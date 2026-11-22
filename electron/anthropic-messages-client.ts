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

  const headers: Record<string, string> = {
    'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
    'content-type': 'application/json',
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
  const maxRetries = options.maxRateLimitRetries ?? 2

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    timeout.unref?.()

    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      })

      if (response.ok) {
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
      const isAbort = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        kind: isAbort ? 'timeout' : 'network',
        message: isAbort
          ? '模型分析超时（90s），请稍后重试。'
          : error instanceof Error
            ? error.message
            : String(error),
        durationMs: Date.now() - startedAt,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    ok: false,
    kind: 'rate_limited',
    message: '模型限流，重试已耗尽。',
    durationMs: Date.now() - startedAt,
  }
}
