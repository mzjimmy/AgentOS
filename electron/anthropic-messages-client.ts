/**
 * Shared Anthropic Messages HTTP client for Main-process background LLM calls
 * (e.g. Intent Todo analysis) and provider connectivity checks.
 *
 * Uses Electron `net.fetch` when available so system proxy / Chromium network stack
 * matches SDK behavior, falls back to global `fetch` in plain Node tests.
 */

import type { ClaudeAgentResolvedConfig } from '../src/claude-chat-types'

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

export type AnthropicMessageParam = {
  role: 'user' | 'assistant'
  content: string
}

export type AnthropicMessagesRequest = {
  system?: string
  messages: AnthropicMessageParam[]
  maxTokens?: number
  temperature?: number
  effort?: 'low'
}

export type AnthropicMessagesErrorKind =
  | 'needs_config'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'provider_error'

export type AnthropicMessagesResult =
  | {
      ok: true
      text: string
      model: string
      stopReason?: string
      usage?: { inputTokens?: number; outputTokens?: number }
      durationMs: number
    }
  | {
      ok: false
      kind: AnthropicMessagesErrorKind
      status?: number
      retryAfterMs?: number
      message: string
      durationMs: number
    }

export type AnthropicFetchFn = (input: string, init?: RequestInit) => Promise<Response>

export type AnthropicCallOptions = {
  timeoutMs?: number
  /** When true, sends `stream: true` and reads Anthropic SSE chunks with idle-timeout reset. Falls back to JSON if the upstream returns `application/json`. */
  stream?: boolean
  /** Max silence between chunks in SSE streaming mode (defaults to 60_000 ms). */
  idleTimeoutMs?: number
  maxRateLimitRetries?: number
  fetchFn?: AnthropicFetchFn
  sleep?: (ms: number) => Promise<void>
}

export function buildAnthropicMessagesEndpoint(baseUrl?: string | null): string {
  const trimmed = (baseUrl ?? '').trim() || DEFAULT_ANTHROPIC_BASE_URL
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith('/v1') ? `${pathname}/messages` : `${pathname}/v1/messages`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Extracts and concatenates all `type === 'text'` content blocks from an Anthropic
 * Messages API payload. Safe against reasoning models (e.g. MiniMax-CN / Claude thinking)
 * whose `content[0]` is a `thinking` block.
 */
export function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  if (!Array.isArray(record.content)) return ''
  const chunks: string[] = []
  for (const block of record.content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string'
    ) {
      chunks.push((block as Record<string, unknown>).text as string)
    }
  }
  return chunks.join('\n').trim()
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 60_000)
  }
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 60_000)
  }
  return undefined
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const data = (await response.json()) as Record<string, unknown>
      if (typeof data?.message === 'string' && data.message.trim()) {
        return data.message.trim().slice(0, 300)
      }
      const err = data?.error
      if (typeof err === 'string' && err.trim()) return err.trim().slice(0, 300)
      if (err && typeof err === 'object') {
        const errRec = err as Record<string, unknown>
        const msg =
          (typeof errRec.message === 'string' && errRec.message.trim()) ||
          (typeof errRec.type === 'string' && errRec.type.trim()) ||
          (typeof errRec.code === 'string' && errRec.code.trim())
        if (msg) return msg.slice(0, 300)
      }
    }
    const text = await response.text()
    return text.trim().replace(/\s+/g, ' ').slice(0, 300)
  } catch {
    return ''
  }
}

async function resolveDefaultFetch(): Promise<AnthropicFetchFn> {
  try {
    const electron = await import('electron')
    if (electron?.net && typeof electron.net.fetch === 'function') {
      return (input: string, init?: RequestInit) => electron.net.fetch(input, init)
    }
  } catch {
    /* plain Node runtime (unit tests) */
  }
  return (input: string, init?: RequestInit) => fetch(input, init)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

type SseParseResult =
  | {
      ok: true
      text: string
      model: string
      stopReason?: string
      usage?: { inputTokens?: number; outputTokens?: number }
    }
  | {
      ok: false
      kind: 'rate_limited' | 'provider_error'
      message: string
    }

/**
 * Parses an Anthropic Messages API Server-Sent Events stream, collecting `text_delta`
 * chunks while safely ignoring `thinking_delta` / `signature_delta` blocks.
 * Calls `onChunk()` whenever bytes arrive so the caller can reset its idle timer.
 */
async function readAnthropicSseStream(
  response: Response,
  fallbackModel: string,
  onChunk: () => void,
): Promise<SseParseResult> {
  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    return {
      ok: false,
      kind: 'provider_error',
      message: '流式响应体不可读。',
    }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const textChunks: string[] = []
  let resolvedModel = fallbackModel
  let stopReason: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  const processDataPayload = (rawData: string): SseParseResult | null => {
    const trimmed = rawData.trim()
    if (!trimmed || trimmed === '[DONE]') return null
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return null
    }

    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'error') {
      const errObj = payload.error as Record<string, unknown> | undefined
      const errType = typeof errObj?.type === 'string' ? errObj.type : ''
      const errMsg =
        (typeof errObj?.message === 'string' && errObj.message.trim()) ||
        (typeof payload.message === 'string' && payload.message.trim()) ||
        errType ||
        '模型流式响应返回错误。'
      const isRateLimited = errType === 'rate_limit_error' || errType === 'overloaded_error'
      return {
        ok: false,
        kind: isRateLimited ? 'rate_limited' : 'provider_error',
        message: isRateLimited ? `模型限流或繁忙：${errMsg.slice(0, 300)}` : `模型调用失败：${errMsg.slice(0, 300)}`,
      }
    }

    if (type === 'message_start') {
      const msg = payload.message as Record<string, unknown> | undefined
      if (typeof msg?.model === 'string' && msg.model.trim()) {
        resolvedModel = msg.model
      }
      const usage = msg?.usage as Record<string, unknown> | undefined
      if (typeof usage?.input_tokens === 'number') {
        inputTokens = usage.input_tokens
      }
      if (typeof usage?.output_tokens === 'number') {
        outputTokens = usage.output_tokens
      }
      return null
    }

    if (type === 'content_block_delta') {
      const delta = payload.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textChunks.push(delta.text)
      }
      return null
    }

    if (type === 'message_delta') {
      const delta = payload.delta as Record<string, unknown> | undefined
      if (typeof delta?.stop_reason === 'string') {
        stopReason = delta.stop_reason
      }
      const usage = payload.usage as Record<string, unknown> | undefined
      if (typeof usage?.output_tokens === 'number') {
        outputTokens = usage.output_tokens
      }
      if (typeof usage?.input_tokens === 'number') {
        inputTokens = usage.input_tokens
      }
      return null
    }

    return null
  }

  const consumeEvents = (flush: boolean): SseParseResult | null => {
    const normalized = buffer.replace(/\r\n/g, '\n')
    const blocks = normalized.split('\n\n')
    buffer = flush ? '' : (blocks.pop() ?? '')
    for (const block of blocks) {
      if (!block.trim()) continue
      const dataLines: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
      if (dataLines.length === 0) continue
      const streamError = processDataPayload(dataLines.join('\n'))
      if (streamError) return streamError
    }
    if (flush && buffer.trim()) {
      const dataLines: string[] = []
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
      if (dataLines.length > 0) {
        const streamError = processDataPayload(dataLines.join('\n'))
        if (streamError) return streamError
      }
    }
    return null
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        onChunk()
        buffer += decoder.decode(value, { stream: true })
        const streamError = consumeEvents(false)
        if (streamError) return streamError
      }
    }
    buffer += decoder.decode()
    const streamError = consumeEvents(true)
    if (streamError) return streamError
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore releaseLock errors */
    }
  }

  return {
    ok: true,
    text: textChunks.join('').trim(),
    model: resolvedModel,
    stopReason,
    usage:
      inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined,
  }
}

export async function callAnthropicMessages(
  config: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>,
  request: AnthropicMessagesRequest,
  options: AnthropicCallOptions = {},
): Promise<AnthropicMessagesResult> {
  const startedAt = Date.now()
  const authToken = (config.authToken ?? '').trim()
  const apiKey = (config.apiKey ?? '').trim()
  const model = (config.model ?? '').trim()

  if (!authToken && !apiKey) {
    return {
      ok: false,
      kind: 'needs_config',
      message: '尚未配置模型 API Key / Auth Token，请在设置中完成模型配置。',
      durationMs: Date.now() - startedAt,
    }
  }
  if (!model) {
    return {
      ok: false,
      kind: 'needs_config',
      message: '当前提供商未配置可用模型，请在设置中指定模型名称。',
      durationMs: Date.now() - startedAt,
    }
  }

  let endpoint: string
  try {
    endpoint = buildAnthropicMessagesEndpoint(config.baseUrl)
  } catch (error) {
    return {
      ok: false,
      kind: 'needs_config',
      message: error instanceof Error ? error.message : 'Base URL 格式无效。',
      durationMs: Date.now() - startedAt,
    }
  }

  const useStream = options.stream === true
  const headers: Record<string, string> = {
    'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
    'content-type': 'application/json',
  }
  if (useStream) {
    headers.accept = 'text/event-stream'
  }
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`
  } else {
    headers['x-api-key'] = apiKey
  }

  const bodyPayload: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages,
  }
  if (useStream) {
    bodyPayload.stream = true
  }
  if (request.system) {
    bodyPayload.system = request.system
  }
  if (typeof request.temperature === 'number') {
    bodyPayload.temperature = request.temperature
  }

  if (request.effort) {
    bodyPayload.output_config = { effort: request.effort }
  }

  const fetchFn = options.fetchFn ?? (await resolveDefaultFetch())
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? 90_000
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000
  const maxRetries = options.maxRateLimitRetries ?? 2

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    let abortReason: 'total' | 'idle' | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const totalTimer = setTimeout(() => {
      abortReason = 'total'
      controller.abort()
    }, timeoutMs)
    totalTimer.unref?.()

    const resetIdleTimer = () => {
      if (!useStream || idleTimeoutMs <= 0) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        abortReason = 'idle'
        controller.abort()
      }, idleTimeoutMs)
      idleTimer.unref?.()
    }

    resetIdleTimer()

    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      })

      if (response.ok) {
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
        if (useStream && contentType.includes('text/event-stream')) {
          resetIdleTimer()
          const sse = await readAnthropicSseStream(response, model, resetIdleTimer)
          if (!sse.ok) {
            if (sse.kind === 'rate_limited' && attempt < maxRetries) {
              await sleep(Math.min(2_000 * 2 ** attempt, 15_000))
              continue
            }
            return {
              ok: false,
              kind: sse.kind,
              message: sse.message,
              durationMs: Date.now() - startedAt,
            }
          }
          return {
            ok: true,
            text: sse.text,
            model: sse.model,
            stopReason: sse.stopReason,
            usage: sse.usage,
            durationMs: Date.now() - startedAt,
          }
        }

        // Non-streaming JSON response (also serves as graceful fallback if proxy buffers SSE into JSON)
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
        const json = (await response.json()) as Record<string, unknown>
        const text = extractAnthropicText(json)
        const usageRaw = json?.usage as Record<string, unknown> | undefined
        return {
          ok: true,
          text,
          model: typeof json?.model === 'string' && json.model.trim() ? json.model : model,
          stopReason: typeof json?.stop_reason === 'string' ? json.stop_reason : undefined,
          usage: usageRaw
            ? {
                inputTokens: typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : undefined,
                outputTokens: typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : undefined,
              }
            : undefined,
          durationMs: Date.now() - startedAt,
        }
      }

      const errMsg = await readErrorMessage(response)

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          kind: 'needs_config',
          status: response.status,
          message: errMsg ? `模型鉴权失败（${response.status}）：${errMsg}` : `模型鉴权失败（${response.status}）。`,
          durationMs: Date.now() - startedAt,
        }
      }

      if (response.status === 429 || response.status === 529) {
        const retryAfterMs = parseRetryAfterMs(response) ?? Math.min(2_000 * 2 ** attempt, 15_000)
        if (attempt < maxRetries) {
          await sleep(retryAfterMs)
          continue
        }
        return {
          ok: false,
          kind: 'rate_limited',
          status: response.status,
          retryAfterMs,
          message: errMsg ? `模型限流或繁忙（${response.status}）：${errMsg}` : `模型限流或繁忙（${response.status}）。`,
          durationMs: Date.now() - startedAt,
        }
      }

      return {
        ok: false,
        kind: 'provider_error',
        status: response.status,
        message: errMsg ? `模型调用失败（${response.status}）：${errMsg}` : `模型调用失败（${response.status}）。`,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      const isAbort =
        (error instanceof Error && error.name === 'AbortError') || controller.signal.aborted
      const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000))
      const idleSec = Math.max(1, Math.round(idleTimeoutMs / 1000))
      return {
        ok: false,
        kind: isAbort ? 'timeout' : 'network',
        message: isAbort
          ? abortReason === 'idle'
            ? `模型响应超时（${idleSec}s 无输出），请稍后重试。`
            : `模型分析超时（${timeoutSec}s），请稍后重试。`
          : error instanceof Error
            ? error.message
            : String(error),
        durationMs: Date.now() - startedAt,
      }
    } finally {
      clearTimeout(totalTimer)
      if (idleTimer) clearTimeout(idleTimer)
    }
  }

  return {
    ok: false,
    kind: 'rate_limited',
    message: '模型限流，重试已耗尽。',
    durationMs: Date.now() - startedAt,
  }
}
