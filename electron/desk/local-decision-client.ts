/**
 * Local-Only Decision Client (LAN / localhost OpenAI-compatible endpoint).
 *
 * This module is deliberately cloud-free: it contains no cloud base URL, no API-key
 * lookup and no import of the JEV/TypeSafe client. Any feature that must never leave
 * the machine (journal auto-tagging) depends on this module, so the import graph alone
 * guarantees it cannot reach the TypeSafe cloud.
 */

import {
  JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL,
  JOURNAL_AUTO_TAG_DEFAULT_LOCAL_MODEL,
} from '../../src/journal-auto-tag-contract'

export type LocalFetchFn = (input: string, init?: RequestInit) => Promise<Response>

export type LocalDecisionRuntime = {
  fetchFn?: LocalFetchFn
  /** Overrides the default request timeout (milliseconds). */
  timeoutMs?: number
}

export const LOCAL_PROBE_TIMEOUT_MS = 1_800
export const LOCAL_DECIDE_TIMEOUT_MS = 22_000

export function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? '').trim() || fallback
  return trimmed.replace(/\/+$/, '')
}

export async function resolveFetch(custom?: LocalFetchFn): Promise<LocalFetchFn> {
  if (custom) return custom
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

export async function fetchWithTimeout(
  fetchFn: LocalFetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function localModelsUrl(baseUrl: string): string {
  const cleanBase = normalizeBaseUrl(baseUrl, JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL)
  return cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`
}

function localChatUrl(baseUrl: string): string {
  const cleanBase = normalizeBaseUrl(baseUrl, JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL)
  return cleanBase.endsWith('/v1')
    ? `${cleanBase}/chat/completions`
    : `${cleanBase}/v1/chat/completions`
}

/**
 * Probes whether a LAN/local LM Studio OpenAI-compatible server is reachable
 * and exposes the requested model ID.
 */
export async function probeLocalModelReady(
  baseUrl: string,
  model: string,
  runtime: LocalDecisionRuntime = {},
): Promise<boolean> {
  const fetchFn = await resolveFetch(runtime.fetchFn)
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      localModelsUrl(baseUrl),
      { method: 'GET' },
      runtime.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS,
    )
    if (!res.ok) return false
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    if (!Array.isArray(json?.data) || json.data.length === 0) return false
    const target = model.trim().toLowerCase()
    return json.data.some((item) => typeof item?.id === 'string' && item.id.toLowerCase() === target)
  } catch {
    return false
  }
}

/**
 * SentinelLab `decide()` pattern: strict JSON-schema enum pick against the local model.
 * Returns null on any failure — never guesses.
 */
export async function decideLocalEnum<T extends string>(
  baseUrl: string,
  model: string,
  stateText: string,
  question: string,
  optionsList: readonly T[],
  runtime: LocalDecisionRuntime = {},
): Promise<T | null> {
  const fetchFn = await resolveFetch(runtime.fetchFn)
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      localChatUrl(baseUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: stateText.slice(0, 3200) },
            { role: 'user', content: question },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'decision',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['answer'],
                properties: {
                  answer: { type: 'string', enum: [...optionsList] },
                },
              },
            },
          },
        }),
      },
      runtime.timeoutMs ?? LOCAL_DECIDE_TIMEOUT_MS,
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return null
    const parsed = JSON.parse(content) as { answer?: unknown }
    if (typeof parsed?.answer === 'string' && (optionsList as readonly string[]).includes(parsed.answer)) {
      return parsed.answer as T
    }
    return null
  } catch {
    return null
  }
}

/**
 * Structured JSON-schema decision call against the local model (single round-trip
 * for multi-field classification such as category + project + entry kind).
 */
export async function decideLocalJson<T extends Record<string, unknown>>(
  baseUrl: string,
  model: string,
  stateText: string,
  question: string,
  schemaName: string,
  schema: Record<string, unknown>,
  runtime: LocalDecisionRuntime = {},
): Promise<T | null> {
  const fetchFn = await resolveFetch(runtime.fetchFn)
  try {
    const res = await fetchWithTimeout(
      fetchFn,
      localChatUrl(baseUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: stateText.slice(0, 3200) },
            { role: 'user', content: question },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: schemaName,
              strict: true,
              schema,
            },
          },
        }),
      },
      runtime.timeoutMs ?? LOCAL_DECIDE_TIMEOUT_MS,
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return null
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

export const DEFAULT_LOCAL_BASE_URL = JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL
export const DEFAULT_LOCAL_MODEL = JOURNAL_AUTO_TAG_DEFAULT_LOCAL_MODEL
