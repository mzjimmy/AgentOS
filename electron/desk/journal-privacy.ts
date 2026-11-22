/**
 * Single source of truth for SentinelDesk journal privacy filtering, secret scrubbing,
 * stable content hashing, and pasted-AI-reply detection.
 */

import { createHash } from 'node:crypto'
import type { JournalEntry, JournalProvenance } from '../../src/journal-contract'

export const PRIVATE_TAG_TOKENS = new Set(['私密', 'private', '隐私', 'secret'])

/**
 * Matches inline `#私密`, `＃私密`, `#private`, `#隐私`, `#secret`, `[私密]`, `[private]`
 * anywhere in body text — intentionally avoids `\b` because `\b` fails on CJK boundaries
 * (e.g. `#私密今天去医院` or `今天 #私密`).
 */
const PRIVATE_INLINE_RE = /(?:[#＃](?:私密|private|隐私|secret)|\[(?:私密|private)\])/i

const AI_PASTE_PATTERNS: readonly RegExp[] = [
  /我会让实现模型/,
  /你在\s*\[[^\]]+\]\([^)]+\)\s*里已经定义/,
  /\[\[\d+\]\]\([^)]+\)|\\\[\d+\\\]\([^)]+\)/,
  /^\|.+\|\s*\n\|[\s:\-|]+\|\s*\n\|.+\|/m,
]

export type PrivacyCheckInput = Pick<JournalEntry, 'body' | 'tags' | 'category' | 'private'> & {
  isPrivate?: boolean
}

/**
 * Determines whether a journal entry must be excluded from AI intent analysis.
 */
export function isPrivateJournalEntry(entry: PrivacyCheckInput): boolean {
  if (entry.private === true || entry.isPrivate === true) {
    return true
  }
  const normalizedCategory = String(entry.category || '').trim().toLowerCase()
  if (PRIVATE_TAG_TOKENS.has(normalizedCategory)) {
    return true
  }
  for (const tag of entry.tags || []) {
    const cleaned = String(tag || '')
      .trim()
      .replace(/^[#＃]+/, '')
      .toLowerCase()
    if (PRIVATE_TAG_TOKENS.has(cleaned)) {
      return true
    }
  }
  if (entry.body && PRIVATE_INLINE_RE.test(entry.body)) {
    return true
  }
  return false
}

/**
 * Heuristic check for human-authored entries that appear to contain a pasted AI response.
 */
export function detectSuspectedAiPaste(provenance: JournalProvenance | string, body: string): boolean {
  if (provenance !== 'human' || !body) return false
  let hits = 0
  for (const pattern of AI_PASTE_PATTERNS) {
    if (pattern.test(body)) hits += 1
  }
  return hits >= 2
}

function normalizeJournalBody(body: string | undefined): string {
  return (body || '').replace(/\r\n/g, '\n').trim()
}

/**
 * Stable content hash for incremental cursor tracking and anchor fallback when meta ID is absent.
 *
 * The private flag only counts when the user authored it: a private mark applied by the
 * local auto-tagger must not change the entry identity, otherwise the very act of
 * auto-tagging would make the entry look brand new and it would be analyzed twice.
 */
export function computeJournalEntryContentHash(
  entry: Pick<
    JournalEntry,
    'date' | 'time' | 'body' | 'category' | 'provenance' | 'private' | 'tags' | 'autoApplied'
  >,
): string {
  const normalizedBody = normalizeJournalBody(entry.body)
  const privFlag = entry.private === true && entry.autoApplied?.private !== true ? 'priv1' : 'priv0'
  const sortedTags = Array.isArray(entry.tags)
    ? [...entry.tags].map((t) => String(t || '').trim().toLowerCase()).filter(Boolean).sort().join(',')
    : ''
  return createHash('sha256')
    .update(`${entry.date}|${entry.time}|${entry.category}|${entry.provenance}|${privFlag}|${sortedTags}|${normalizedBody}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Hash of the entry's identity-bearing text only (date + body).
 *
 * Immune to metadata-only edits (category, tags, project refs, private flag), so a
 * re-classified entry is not re-analyzed and does not produce a duplicate todo.
 */
export function computeJournalEntryBodyHash(entry: Pick<JournalEntry, 'date' | 'body'>): string {
  const normalizedBody = normalizeJournalBody(entry.body)
  return createHash('sha256').update(`${entry.date}|${normalizedBody}`).digest('hex').slice(0, 16)
}

const SECRET_PATTERNS: ReadonlyArray<{ regex: RegExp; replacement: string }> = [
  // OpenAI / Anthropic / generic sk-* keys
  { regex: /\bsk-(?:ant-api\d+-|proj-)?[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED_API_KEY]' },
  // GitHub personal / OAuth / app tokens
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED_GH_TOKEN]' },
  // AWS access key IDs
  { regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // Slack tokens
  { regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, replacement: '[REDACTED_TOKEN]' },
  // Authorization Bearer tokens
  { regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  // PEM private key blocks
  {
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // Explicit key=value / token: value assignments
  {
    regex: /((?:api[_-]?key|auth[_-]?token|app[_-]?secret|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?)([A-Za-z0-9._~+/=-]{16,})(['"]?)/gi,
    replacement: '$1[REDACTED_SECRET]$3',
  },
]

/**
 * Scrubs credential-like substrings before sending journal text to an external LLM
 * or injecting it into a dispatched project prompt.
 */
export function scrubSecrets(text: string): string {
  if (!text) return ''
  let out = text
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = out.replace(regex, replacement)
  }
  return out
}
