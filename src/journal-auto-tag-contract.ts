import type { JournalCategory } from './journal-contract'

/**
 * Frozen Shared Wire Contract for SentinelDesk Journal Auto-Tagging (AI 自动标记).
 *
 * Pipeline order:
 * 1. Privacy classification FIRST (private life / address / PII -> `private: true`, short-circuit).
 * 2. Category classification (`学习/工作/事务/生活/身体/工程`), workspace project attribution, and concise tags.
 *
 * Engine modes:
 * - `local` (default): LAN/local OpenAI-compatible model only — zero cloud egress.
 * - `jev`: TypeSafe AI System One (`jev-1.13.0`) — explicit user opt-in, ~500ms parallel multi-question.
 * - `auto`: LAN local first, falls back to TypeSafe JEV when local is unreachable (explicit opt-in).
 */

export const JOURNAL_AUTO_TAG_PIPELINE_VERSION = 'v2'
export const JOURNAL_AUTO_TAG_MAX_ENTRIES_PER_RUN = 100
export const JOURNAL_AUTO_TAG_MAX_BODY_CHARS = 1500
export const JOURNAL_AUTO_TAG_CONCURRENCY = 3
export const JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL = 'http://192.168.31.57:1234/v1'
export const JOURNAL_AUTO_TAG_DEFAULT_LOCAL_MODEL = 'cloudflare_clef-flash'

export type JournalAutoTagEngine = 'local' | 'jev' | 'auto'

export type JournalAutoTagConfig = {
  /** Auto-tagging on journal creation/update is enabled by default */
  enabled: boolean
  /** Engine selection: `local` (default, LAN only), `jev` (TypeSafe System One), or `auto` */
  engine: JournalAutoTagEngine
  /** LAN/local OpenAI-compatible base URL */
  localBaseUrl: string
  /** Local lightweight decision model ID */
  localModel: string
}

export type JournalAutoTagDecision = {
  /** Step 1: true when private personal life / address / PII detected */
  private: boolean
  /** Step 2: classified journal category (null when uncertain / keep current) */
  category: JournalCategory | null
  /** Step 2: canonical workspace project name the entry belongs to (null when none or private) */
  projectName: string | null
  /** Step 2: optional concise semantic tags (e.g. ['开发履历']) */
  tags: string[]
  decidedAt: string
  pipeline: string
  engine?: string
}

export type JournalAutoTagRunStatus =
  | 'idle'
  | 'disabled'
  | 'local_unreachable'
  | 'skipped'
  | 'completed'
  | 'failed'

export type JournalAutoTagRunSummary = {
  status: JournalAutoTagRunStatus
  ranAt: string | null
  /** Where the decision engine actually lived (never a cloud host) */
  endpoint: string | null
  scanned: number
  decided: number
  changed: number
  skipped: number
  message?: string
}

export type JournalAutoTagStatus = {
  config: JournalAutoTagConfig
  lastRun: JournalAutoTagRunSummary
  /** date -> summary of the latest run for that calendar day */
  lastRunByDate: Record<string, JournalAutoTagRunSummary>
}

export type JournalAutoTagRunResult = {
  ok: boolean
  status: JournalAutoTagRunStatus
  date: string
  endpoint: string | null
  scanned: number
  decided: number
  changed: number
  skipped: number
  message?: string
}

export type JournalAutoTagChangedEvent = {
  reason: 'ran' | 'config-changed'
  dates: string[]
  timestamp: number
}
