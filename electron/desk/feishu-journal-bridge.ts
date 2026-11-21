/**
 * Deterministic Feishu WebSocket Long-Connection Bridge for SentinelDesk Timeline Journal.
 * Receives text, image, and rich-text (post) messages directly in Electron main without
 * invoking any LLM, writes them to JournalStore, and acknowledges with an emoji reaction.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Readable } from 'node:stream'
import * as Lark from '@larksuiteoapi/node-sdk'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryResult,
  FeishuBridgeConfigUpdate,
  FeishuBridgeConnectionState,
  FeishuBridgeDomain,
  FeishuBridgePublicConfig,
  FeishuBridgeStatus,
  JournalCreateImageInput,
} from '../../src/journal-contract'

const CONFIG_FILE_NAME = 'feishu-journal-bridge.json'
const DEFAULT_REACTION_EMOJI = 'DONE'
const FEISHU_APP_ID_REGEX = /^cli_[0-9a-fA-F]{16}$/
const HANDSHAKE_TIMEOUT_MS = 20_000

export type StoredFeishuBridgeConfig = {
  enabled: boolean
  appId: string
  appSecret: string
  allowedChatId: string
  allowedOpenId: string
  domain: FeishuBridgeDomain
  reactionEmoji: string
}

const DEFAULT_STORED_CONFIG: StoredFeishuBridgeConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  allowedChatId: '',
  allowedOpenId: '',
  domain: 'feishu',
  reactionEmoji: DEFAULT_REACTION_EMOJI,
}

export type ParsedFeishuMessage = {
  text: string
  imageKeys: string[]
  unsupportedType?: string
}

export type FeishuIncomingMessageEvent = {
  sender?: {
    sender_type?: string
    sender_id?: {
      open_id?: string
      user_id?: string
      union_id?: string
    }
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    create_time?: string
  }
}

export interface FeishuBridgeJournalWriter {
  createEntry(input: CreateJournalEntryInput): Promise<CreateJournalEntryResult>
}

export type FeishuAdapterLifecycleCallbacks = {
  onReady: () => void
  onReconnecting: () => void
  onReconnected: () => void
  onError: (error: Error) => void
}

export interface FeishuBridgeClientAdapter {
  downloadImage(messageId: string, imageKey: string): Promise<{ buffer: Buffer; contentType?: string }>
  addReaction(messageId: string, emojiType: string): Promise<void>
  start(onMessage: (event: FeishuIncomingMessageEvent) => Promise<void> | void): Promise<void>
  close(): void
}

export type FeishuBridgeClientFactory = (
  config: StoredFeishuBridgeConfig,
  lifecycle: FeishuAdapterLifecycleCallbacks,
) => FeishuBridgeClientAdapter

function normalizeDomain(value: unknown): FeishuBridgeDomain {
  return value === 'lark' ? 'lark' : 'feishu'
}

function normalizeEmoji(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_REACTION_EMOJI
  const trimmed = value.trim()
  if (!trimmed) return DEFAULT_REACTION_EMOJI
  // Feishu emoji_type is case-sensitive: official checkmark is 'CheckMark'
  if (trimmed === 'CHECKMARK') return 'CheckMark'
  return trimmed
}

function normalizeStoredConfig(raw: unknown): StoredFeishuBridgeConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_STORED_CONFIG }
  }
  const obj = raw as Record<string, unknown>
  return {
    enabled: obj.enabled === true,
    appId: typeof obj.appId === 'string' ? obj.appId.trim() : '',
    appSecret: typeof obj.appSecret === 'string' ? obj.appSecret.trim() : '',
    allowedChatId: typeof obj.allowedChatId === 'string' ? obj.allowedChatId.trim() : '',
    allowedOpenId: typeof obj.allowedOpenId === 'string' ? obj.allowedOpenId.trim() : '',
    domain: normalizeDomain(obj.domain),
    reactionEmoji: normalizeEmoji(obj.reactionEmoji),
  }
}

export function maskSecret(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 4) return '••••'
  return `••••${secret.slice(-4)}`
}

export function toPublicFeishuConfig(cfg: StoredFeishuBridgeConfig): FeishuBridgePublicConfig {
  return {
    enabled: cfg.enabled,
    appId: cfg.appId,
    hasAppSecret: cfg.appSecret.length > 0,
    appSecretMasked: maskSecret(cfg.appSecret),
    allowedChatId: cfg.allowedChatId,
    allowedOpenId: cfg.allowedOpenId,
    domain: cfg.domain,
    reactionEmoji: cfg.reactionEmoji,
  }
}

/**
 * Strips Feishu @mention placeholders (e.g. `@_user_1`) and optional legacy `/记` prefix
 * so users never need to type `/记`, while muscle-memory `/记 ...` still works cleanly.
 */
export function cleanFeishuJournalText(raw: string): string {
  if (!raw) return ''
  let text = raw
    .replace(/@_user_\d+\s*/g, '')
    .trim()

  text = text.replace(/^\/记(?:录)?(?:[\s:：]+|$)/, '').trim()
  return text
}

type PostNode = {
  tag?: string
  text?: string
  href?: string
  user_name?: string
  image_key?: string
}

function extractPostBody(parsed: Record<string, unknown>): { title: string; paragraphs: PostNode[][] } {
  let target: Record<string, unknown> = parsed
  if (!Array.isArray(parsed.content)) {
    const preferredLocales = ['zh_cn', 'zh_hk', 'zh_tw', 'en_us', 'ja_jp']
    let found: Record<string, unknown> | null = null
    for (const key of preferredLocales) {
      const candidate = parsed[key]
      if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).content)) {
        found = candidate as Record<string, unknown>
        break
      }
    }
    if (!found) {
      for (const value of Object.values(parsed)) {
        if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).content)) {
          found = value as Record<string, unknown>
          break
        }
      }
    }
    if (found) target = found
  }

  const title = typeof target.title === 'string' ? target.title.trim() : ''
  const paragraphs = Array.isArray(target.content) ? (target.content as PostNode[][]) : []
  return { title, paragraphs }
}

/**
 * Pure parser for Feishu `im.message.receive_v1` message content.
 * Supports `text`, `image`, and `post` (rich text with inline images).
 */
export function parseFeishuMessageContent(
  messageType: string,
  rawContent: string,
): ParsedFeishuMessage {
  const normalizedType = (messageType || '').trim().toLowerCase()
  let parsed: Record<string, unknown> = {}
  try {
    const json = JSON.parse(rawContent || '{}')
    if (json && typeof json === 'object') {
      parsed = json as Record<string, unknown>
    }
  } catch {
    if (normalizedType === 'text') {
      return { text: cleanFeishuJournalText(rawContent || ''), imageKeys: [] }
    }
    return { text: '', imageKeys: [] }
  }

  if (normalizedType === 'text') {
    const rawText = typeof parsed.text === 'string' ? parsed.text : ''
    return {
      text: cleanFeishuJournalText(rawText),
      imageKeys: [],
    }
  }

  if (normalizedType === 'image') {
    const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key.trim() : ''
    return {
      text: '',
      imageKeys: imageKey ? [imageKey] : [],
    }
  }

  if (normalizedType === 'post') {
    const { title, paragraphs } = extractPostBody(parsed)
    const imageKeys: string[] = []
    const seenImageKeys = new Set<string>()
    const lines: string[] = []

    if (title) {
      lines.push(title)
    }

    for (const para of paragraphs) {
      if (!Array.isArray(para)) continue
      const segs: string[] = []
      for (const node of para) {
        if (!node || typeof node !== 'object') continue
        if (node.tag === 'text' && typeof node.text === 'string') {
          segs.push(node.text)
        } else if (node.tag === 'a') {
          const label = typeof node.text === 'string' ? node.text.trim() : ''
          const href = typeof node.href === 'string' ? node.href.trim() : ''
          if (label && href && label !== href) {
            segs.push(`[${label}](${href})`)
          } else if (label || href) {
            segs.push(label || href)
          }
        } else if (node.tag === 'at') {
          const userName = typeof node.user_name === 'string' ? node.user_name.trim() : ''
          if (userName) segs.push(`@${userName}`)
        } else if (node.tag === 'img' || node.tag === 'media') {
          const key = typeof node.image_key === 'string' ? node.image_key.trim() : ''
          if (key && !seenImageKeys.has(key)) {
            seenImageKeys.add(key)
            imageKeys.push(key)
          }
        }
      }
      const line = segs.join('').trim()
      if (line) lines.push(line)
    }

    return {
      text: cleanFeishuJournalText(lines.join('\n')),
      imageKeys,
    }
  }

  return {
    text: '',
    imageKeys: [],
    unsupportedType: normalizedType || 'unknown',
  }
}

export function detectImageMimeAndExt(
  buffer: Buffer,
  contentType?: string,
): { mimeType: string; ext: string } | null {
  if (!buffer || buffer.length === 0) {
    return null
  }
  const normalizedCt = (contentType || '').split(';')[0].trim().toLowerCase()
  if (
    normalizedCt.startsWith('application/json') ||
    normalizedCt.startsWith('text/')
  ) {
    return null
  }

  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' }
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return { mimeType: 'image/gif', ext: 'gif' }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: 'webp' }
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mimeType: 'image/bmp', ext: 'bmp' }
  }

  if (normalizedCt === 'image/jpeg' || normalizedCt === 'image/jpg') {
    return { mimeType: 'image/jpeg', ext: 'jpg' }
  }
  if (normalizedCt === 'image/webp') {
    return { mimeType: 'image/webp', ext: 'webp' }
  }
  if (normalizedCt === 'image/gif') {
    return { mimeType: 'image/gif', ext: 'gif' }
  }
  if (normalizedCt === 'image/png') {
    return { mimeType: 'image/png', ext: 'png' }
  }
  if (normalizedCt.startsWith('image/')) {
    const sub = normalizedCt.slice('image/'.length).replace(/[^a-z0-9]/g, '') || 'png'
    return { mimeType: normalizedCt, ext: sub }
  }

  // Reject payloads that look like JSON error text even if Content-Type was omitted/octet-stream
  const head = buffer.subarray(0, 64).toString('utf8').trimStart()
  if (head.startsWith('{') || head.startsWith('<')) {
    return null
  }

  return { mimeType: 'image/png', ext: 'png' }
}

export function parseFeishuCreateTime(rawCreateTime?: string): string | undefined {
  if (!rawCreateTime) return undefined
  const num = Number(rawCreateTime)
  if (!Number.isFinite(num) || num <= 0) return undefined
  // Normalize 10-digit Unix seconds to milliseconds
  const ms = num < 1e12 ? num * 1000 : num
  // Guard against out-of-range timestamps (> +-8.64e15 ms)
  if (ms > 8.64e15) return undefined
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function extractBinaryFromLarkResponse(
  res: unknown,
): Promise<{ buffer: Buffer; contentType?: string }> {
  if (!res) {
    throw new Error('Empty response from Feishu messageResource.get')
  }
  if (Buffer.isBuffer(res)) {
    return { buffer: res }
  }
  if (res instanceof Uint8Array) {
    return { buffer: Buffer.from(res) }
  }
  const obj = res as Record<string, unknown>
  const headers = (obj.headers && typeof obj.headers === 'object'
    ? (obj.headers as Record<string, unknown>)
    : undefined)
  const contentType =
    typeof headers?.['content-type'] === 'string'
      ? headers['content-type']
      : typeof headers?.['Content-Type'] === 'string'
        ? headers['Content-Type']
        : undefined

  if (typeof obj.getReadableStream === 'function') {
    const stream = (obj.getReadableStream as () => Readable)()
    const buffer = await streamToBuffer(stream)
    return { buffer, contentType }
  }
  if (Buffer.isBuffer(obj.data)) {
    return { buffer: obj.data, contentType }
  }
  if (obj.data instanceof ArrayBuffer) {
    return { buffer: Buffer.from(obj.data), contentType }
  }
  if (typeof (obj as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    const buffer = await streamToBuffer(obj as unknown as Readable)
    return { buffer, contentType }
  }
  throw new Error('Unsupported binary response shape from Feishu messageResource.get')
}

function createDefaultLarkAdapter(
  config: StoredFeishuBridgeConfig,
  lifecycle: FeishuAdapterLifecycleCallbacks,
): FeishuBridgeClientAdapter {
  const domain = config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.warn,
  }

  let settledInitial = false
  let initialResolve: (() => void) | null = null
  let initialReject: ((err: Error) => void) | null = null
  let handshakeTimer: NodeJS.Timeout | null = null

  const clearHandshakeTimer = () => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer)
      handshakeTimer = null
    }
  }

  const client = new Lark.Client(baseConfig)
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    onReady: () => {
      clearHandshakeTimer()
      if (!settledInitial) {
        settledInitial = true
        initialResolve?.()
      }
      lifecycle.onReady()
    },
    onReconnecting: () => {
      lifecycle.onReconnecting()
    },
    onReconnected: () => {
      lifecycle.onReconnected()
    },
    onError: (err: unknown) => {
      clearHandshakeTimer()
      const error = err instanceof Error ? err : new Error(String(err || 'Feishu WebSocket error'))
      if (!settledInitial) {
        settledInitial = true
        initialReject?.(error)
      }
      lifecycle.onError(error)
    },
  })

  return {
    async downloadImage(messageId: string, imageKey: string) {
      const res = await client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: imageKey,
        },
        params: {
          type: 'image',
        },
      })
      return extractBinaryFromLarkResponse(res)
    },

    async addReaction(messageId: string, emojiType: string) {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      })
      if (res && typeof res.code === 'number' && res.code !== 0) {
        throw new Error(res.msg || `Feishu reaction API error code ${res.code}`)
      }
    },

    async start(onMessage) {
      const eventDispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => {
          // Return promptly so Feishu receives the WebSocket ACK within its 3s window
          // even when downloading multi-image attachments.
          void Promise.resolve(onMessage(data as FeishuIncomingMessageEvent)).catch(() => undefined)
        },
      })

      await new Promise<void>((resolve, reject) => {
        initialResolve = resolve
        initialReject = reject
        handshakeTimer = setTimeout(() => {
          if (!settledInitial) {
            settledInitial = true
            reject(new Error('飞书长连接握手超时，请检查网络及 App ID / App Secret 是否正确'))
          }
        }, HANDSHAKE_TIMEOUT_MS)

        Promise.resolve(wsClient.start({ eventDispatcher })).catch((err: unknown) => {
          clearHandshakeTimer()
          if (!settledInitial) {
            settledInitial = true
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })
    },

    close() {
      clearHandshakeTimer()
      if (!settledInitial) {
        settledInitial = true
        initialResolve?.()
      }
      try {
        wsClient.close({ force: true })
      } catch {
        /* ignore close errors */
      }
    },
  }
}

export class FeishuBridgeConfigStore {
  private readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, CONFIG_FILE_NAME)
  }

  read(): StoredFeishuBridgeConfig {
    if (!existsSync(this.filePath)) {
      return { ...DEFAULT_STORED_CONFIG }
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return normalizeStoredConfig(raw)
    } catch {
      return { ...DEFAULT_STORED_CONFIG }
    }
  }

  save(update: FeishuBridgeConfigUpdate): StoredFeishuBridgeConfig {
    const safeUpdate =
      update && typeof update === 'object' ? update : ({} as FeishuBridgeConfigUpdate)
    const current = this.read()
    const next: StoredFeishuBridgeConfig = {
      enabled: typeof safeUpdate.enabled === 'boolean' ? safeUpdate.enabled : current.enabled,
      appId: typeof safeUpdate.appId === 'string' ? safeUpdate.appId.trim() : current.appId,
      appSecret:
        typeof safeUpdate.appSecret === 'string'
          ? safeUpdate.appSecret.trim()
          : current.appSecret,
      allowedChatId:
        typeof safeUpdate.allowedChatId === 'string'
          ? safeUpdate.allowedChatId.trim()
          : current.allowedChatId,
      allowedOpenId:
        typeof safeUpdate.allowedOpenId === 'string'
          ? safeUpdate.allowedOpenId.trim()
          : current.allowedOpenId,
      domain: safeUpdate.domain ? normalizeDomain(safeUpdate.domain) : current.domain,
      reactionEmoji:
        safeUpdate.reactionEmoji !== undefined
          ? normalizeEmoji(safeUpdate.reactionEmoji)
          : current.reactionEmoji,
    }

    const dir = path.dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = path.join(dir, `.feishu-bridge-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(tmpPath, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      /* ignore chmod error on non-POSIX filesystems */
    }
    return next
  }
}

export interface FeishuJournalBridgeOptions {
  userDataPath: string
  journalStore: FeishuBridgeJournalWriter
  onStatusChange?: (status: FeishuBridgeStatus) => void
  clientFactory?: FeishuBridgeClientFactory
}

function matchesAllowList(allowList: string, value: string | undefined): boolean {
  if (!allowList.trim()) return true
  if (!value) return false
  const allowed = allowList
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (allowed.length === 0) return true
  return allowed.includes(value.trim())
}

export class FeishuJournalBridgeService {
  private readonly configStore: FeishuBridgeConfigStore
  private readonly journalStore: FeishuBridgeJournalWriter
  private readonly onStatusChange?: (status: FeishuBridgeStatus) => void
  private readonly clientFactory: FeishuBridgeClientFactory

  private config: StoredFeishuBridgeConfig
  private adapter: FeishuBridgeClientAdapter | null = null
  private state: FeishuBridgeConnectionState = 'disabled'
  private lastError: string | null = null
  private lastMessageAt: number | null = null
  private receivedCount = 0
  private reactionWarning: string | null = null
  private connectionGeneration = 0
  private readonly inFlightMessageIds = new Set<string>()
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(options: FeishuJournalBridgeOptions) {
    this.configStore = new FeishuBridgeConfigStore(options.userDataPath)
    this.journalStore = options.journalStore
    this.onStatusChange = options.onStatusChange
    this.clientFactory = options.clientFactory ?? createDefaultLarkAdapter
    this.config = this.configStore.read()
    this.state = this.config.enabled ? 'disconnected' : 'disabled'
  }

  getStatus(): FeishuBridgeStatus {
    return {
      state: this.state,
      config: toPublicFeishuConfig(this.config),
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      receivedCount: this.receivedCount,
      reactionWarning: this.reactionWarning,
    }
  }

  private emitStatus(): void {
    if (!this.onStatusChange) return
    try {
      this.onStatusChange(this.getStatus())
    } catch {
      /* ignore listener errors */
    }
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task)
    this.writeQueue = next.catch(() => undefined)
    return next
  }

  async startIfEnabled(): Promise<FeishuBridgeStatus> {
    this.config = this.configStore.read()
    if (!this.config.enabled) {
      this.stopInternal('disabled')
      return this.getStatus()
    }
    return this.connect()
  }

  async updateConfig(update: FeishuBridgeConfigUpdate): Promise<FeishuBridgeStatus> {
    this.config = this.configStore.save(update)
    this.reactionWarning = null
    if (!this.config.enabled) {
      this.stopInternal('disabled')
      return this.getStatus()
    }
    return this.connect()
  }

  async reconnect(): Promise<FeishuBridgeStatus> {
    this.config = this.configStore.read()
    if (!this.config.enabled) {
      this.stopInternal('disabled')
      return this.getStatus()
    }
    return this.connect()
  }

  private stopInternal(nextState: FeishuBridgeConnectionState, error: string | null = null): void {
    this.connectionGeneration += 1
    if (this.adapter) {
      this.adapter.close()
      this.adapter = null
    }
    this.state = nextState
    this.lastError = error
    this.emitStatus()
  }

  private async connect(): Promise<FeishuBridgeStatus> {
    this.stopInternal('connecting', null)

    if (!this.config.appId || !this.config.appSecret) {
      this.state = 'error'
      this.lastError = '请先填写飞书应用的 App ID 和 App Secret'
      this.emitStatus()
      return this.getStatus()
    }

    if (!FEISHU_APP_ID_REGEX.test(this.config.appId)) {
      this.state = 'error'
      this.lastError = 'App ID 格式不正确（应为 cli_ 开头的 20 位字符）'
      this.emitStatus()
      return this.getStatus()
    }

    const gen = this.connectionGeneration
    let adapter: FeishuBridgeClientAdapter | null = null

    try {
      adapter = this.clientFactory(this.config, {
        onReady: () => {
          if (gen !== this.connectionGeneration) return
          this.state = 'connected'
          this.lastError = null
          this.emitStatus()
        },
        onReconnecting: () => {
          if (gen !== this.connectionGeneration) return
          this.state = 'connecting'
          this.emitStatus()
        },
        onReconnected: () => {
          if (gen !== this.connectionGeneration) return
          this.state = 'connected'
          this.lastError = null
          this.emitStatus()
        },
        onError: (err) => {
          if (gen !== this.connectionGeneration) return
          this.state = 'error'
          this.lastError = err.message || String(err)
          this.emitStatus()
        },
      })
      this.adapter = adapter

      await adapter.start(async (event) => {
        await this.handleIncomingEvent(event, adapter, gen)
      })
      if (gen !== this.connectionGeneration) {
        adapter.close()
        return this.getStatus()
      }
      this.state = 'connected'
      this.lastError = null
      this.emitStatus()
    } catch (err: unknown) {
      if (gen !== this.connectionGeneration) {
        adapter?.close()
        return this.getStatus()
      }
      adapter?.close()
      if (this.adapter === adapter) {
        this.adapter = null
      }
      this.state = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus()
    }

    return this.getStatus()
  }

  async handleIncomingEvent(
    event: FeishuIncomingMessageEvent,
    activeAdapter: FeishuBridgeClientAdapter | null = this.adapter,
    expectedGeneration: number = this.connectionGeneration,
  ): Promise<{ handled: boolean; reason?: string }> {
    if (expectedGeneration !== this.connectionGeneration) {
      return { handled: false, reason: 'stale-connection' }
    }

    const senderType = event?.sender?.sender_type
    if (senderType && senderType !== 'user') {
      return { handled: false, reason: 'ignored-non-user' }
    }

    const msg = event?.message
    const messageId = msg?.message_id?.trim()
    if (!msg || !messageId) {
      return { handled: false, reason: 'missing-message-id' }
    }

    const chatId = msg.chat_id?.trim()
    const openId = event?.sender?.sender_id?.open_id?.trim()
    if (!matchesAllowList(this.config.allowedChatId, chatId)) {
      return { handled: false, reason: 'filtered-chat-id' }
    }
    if (!matchesAllowList(this.config.allowedOpenId, openId)) {
      return { handled: false, reason: 'filtered-open-id' }
    }

    if (this.inFlightMessageIds.has(messageId)) {
      return { handled: false, reason: 'in-flight-duplicate' }
    }

    const parsed = parseFeishuMessageContent(msg.message_type || '', msg.content || '')
    if (parsed.unsupportedType) {
      return { handled: false, reason: `unsupported-type:${parsed.unsupportedType}` }
    }
    if (!parsed.text && parsed.imageKeys.length === 0) {
      return { handled: false, reason: 'empty-content' }
    }

    const reactionEmoji = this.config.reactionEmoji || DEFAULT_REACTION_EMOJI
    this.inFlightMessageIds.add(messageId)
    try {
      const images: JournalCreateImageInput[] = []
      const imageErrors: string[] = []

      if (parsed.imageKeys.length > 0) {
        if (!activeAdapter) {
          return { handled: false, reason: 'missing-adapter-for-images' }
        }
        for (const imageKey of parsed.imageKeys) {
          if (expectedGeneration !== this.connectionGeneration) {
            return { handled: false, reason: 'stale-connection' }
          }
          try {
            const downloaded = await activeAdapter.downloadImage(messageId, imageKey)
            const detected = detectImageMimeAndExt(downloaded.buffer, downloaded.contentType)
            if (!detected) {
              imageErrors.push(`invalid image payload for ${imageKey}`)
              continue
            }
            images.push({
              fileName: `${imageKey}.${detected.ext}`,
              mimeType: detected.mimeType,
              dataUrl: `data:${detected.mimeType};base64,${downloaded.buffer.toString('base64')}`,
            })
          } catch (dlErr: unknown) {
            imageErrors.push(dlErr instanceof Error ? dlErr.message : String(dlErr))
          }
        }
      }

      if (expectedGeneration !== this.connectionGeneration) {
        return { handled: false, reason: 'stale-connection' }
      }

      if (!parsed.text && images.length === 0) {
        const errMsg = imageErrors[0] || '未能下载到有效图片'
        this.lastError = errMsg
        this.emitStatus()
        return { handled: false, reason: errMsg }
      }

      const ts = parseFeishuCreateTime(msg.create_time)

      const result = await this.enqueueWrite(() =>
        this.journalStore.createEntry({
          body: parsed.text,
          images: images.length > 0 ? images : undefined,
          source: 'feishu',
          provenance: 'human',
          externalId: `feishu:${messageId}`,
          ts,
        }),
      )

      if (expectedGeneration !== this.connectionGeneration) {
        return { handled: false, reason: 'stale-connection' }
      }

      if (!result.ok) {
        this.lastError = result.error
        this.emitStatus()
        return { handled: false, reason: result.error }
      }

      if (!result.deduplicated) {
        this.receivedCount += 1
        this.lastMessageAt = Date.now()
        this.lastError = imageErrors.length > 0 ? `部分图片下载失败：${imageErrors[0]}` : null

        if (activeAdapter) {
          try {
            await activeAdapter.addReaction(messageId, reactionEmoji)
            if (expectedGeneration === this.connectionGeneration) {
              this.reactionWarning = null
            }
          } catch (reactionErr: unknown) {
            if (expectedGeneration === this.connectionGeneration) {
              this.reactionWarning =
                reactionErr instanceof Error ? reactionErr.message : String(reactionErr)
            }
          }
        }
        if (expectedGeneration === this.connectionGeneration) {
          this.emitStatus()
        }
      }

      return { handled: true }
    } catch (err: unknown) {
      if (expectedGeneration === this.connectionGeneration) {
        this.lastError = err instanceof Error ? err.message : String(err)
        this.emitStatus()
      }
      return { handled: false, reason: err instanceof Error ? err.message : String(err) }
    } finally {
      this.inFlightMessageIds.delete(messageId)
    }
  }

  dispose(): void {
    this.stopInternal('disconnected', null)
  }
}
