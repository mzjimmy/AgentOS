/**
 * Frozen Shared Wire Contract for SentinelDesk Timeline Journal (时间日记).
 * Both Electron main (`electron/desk/*`) and renderer (`src/components/journal/*`)
 * import exclusively from this contract.
 */

export const JOURNAL_TIMEZONE = 'Asia/Shanghai'

export const DEFAULT_SENTINEL_DESK_ROOT = '/Users/sentinellab/VibeCoding/SentinelDesk'
export const DEFAULT_LEGACY_SENTINELLAB_DB_PATH =
  '/Users/sentinellab/Library/Application Support/SentinelLab/sentinellab.db'
export const DEFAULT_SENTINELLAB_BRIDGE_SCRIPT_PATH =
  '/Users/sentinellab/AgentOS/SentinelLab/scripts/sentinellab-bridge.sh'

export const JOURNAL_CATEGORIES = [
  '学习',
  '工作',
  '事务',
  '生活',
  '身体',
  '工程',
  '未归类',
] as const

export type JournalCategory = (typeof JOURNAL_CATEGORIES)[number]

export const JOURNAL_ENTRY_KINDS = [
  'note',
  'photo',
  'thought',
  'moment',
  'ai',
  'judgment',
] as const

export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number]

export type JournalEntrySource = 'local' | 'feishu' | 'sentinellab-import' | 'ai'

export type JournalProvenance = 'human' | 'ai' | 'ai-verified' | 'human-approved'

export type JournalImageAttachment = {
  /** Path relative to `<deskRoot>/journal`, e.g. `attachments/2026/11/img_xxx.png` */
  relativePath: string
  fileName: string
  mimeType: string
  caption?: string
  aiCaption?: string
  width?: number
  height?: number
}

export type JournalEntry = {
  id: string
  /** Local calendar date `YYYY-MM-DD` */
  date: string
  /** Local display time `HH:mm` */
  time: string
  /** ISO-8601 timestamp */
  ts: string
  kind: JournalEntryKind
  body: string
  category: JournalCategory
  tags: string[]
  projectRefs: string[]
  source: JournalEntrySource
  provenance: JournalProvenance
  /** Stable idempotency key (e.g. `feishu:<msgId>` or `sl:<legacyId>`) */
  externalId?: string | null
  images: JournalImageAttachment[]
  /** Optional cross-day reference note, e.g. "与周一的密钥整理有关" */
  relatedNote?: string | null
  /** Optional moment subtitle/artist/meta */
  momentTitle?: string | null
  momentSubtitle?: string | null
}

export type JournalDaySummary = {
  date: string
  count: number
  hasImages: boolean
  hasFeishu: boolean
  hasAi: boolean
}

export type JournalConfig = {
  deskRoot: string
  journalRoot: string
  legacyDbPath: string
  legacyDbAvailable: boolean
  bridgeScriptPath: string
  bridgeScriptAvailable: boolean
}

export type JournalDayResult =
  | {
      ok: true
      date: string
      filePath: string
      entries: JournalEntry[]
    }
  | {
      ok: false
      date: string
      error: string
    }

export type JournalWeekDay = {
  date: string
  summary: JournalDaySummary
  entries: JournalEntry[]
}

export type JournalWeekResult =
  | {
      ok: true
      anchorDate: string
      startDate: string
      endDate: string
      days: JournalWeekDay[]
    }
  | {
      ok: false
      anchorDate: string
      error: string
    }

export type JournalCreateImageInput = {
  fileName: string
  mimeType: string
  /** Base64 payload (either raw base64 or `data:<mime>;base64,...`) */
  dataUrl: string
  caption?: string
}

export type CreateJournalEntryInput = {
  /** Optional target date `YYYY-MM-DD`; defaults to local today */
  date?: string
  /** Optional local time `HH:mm`; defaults to current local time */
  time?: string
  /** Optional ISO timestamp */
  ts?: string
  body: string
  kind?: JournalEntryKind
  category?: JournalCategory
  tags?: string[]
  projectRefs?: string[]
  source?: JournalEntrySource
  provenance?: JournalProvenance
  externalId?: string | null
  images?: JournalCreateImageInput[]
  relatedNote?: string | null
  momentTitle?: string | null
  momentSubtitle?: string | null
}

export type CreateJournalEntryResult =
  | {
      ok: true
      entry: JournalEntry
      deduplicated: boolean
      filePath: string
    }
  | {
      ok: false
      error: string
    }

export type UpdateJournalEntryInput = {
  body?: string
  kind?: JournalEntryKind
  category?: JournalCategory
  tags?: string[]
  projectRefs?: string[]
  relatedNote?: string | null
  momentTitle?: string | null
  momentSubtitle?: string | null
}

export type UpdateJournalEntryResult =
  | {
      ok: true
      entry: JournalEntry
    }
  | {
      ok: false
      error: string
    }

export type DeleteJournalEntryResult =
  | { ok: true; date: string; entryId: string }
  | { ok: false; error: string }

export type JournalAttachmentReadResult =
  | { ok: true; relativePath: string; mimeType: string; dataUrl: string }
  | { ok: false; error: string }

export type LegacyJournalSyncOptions = {
  dbPath?: string
  limit?: number
}

export type LegacyJournalSyncResult =
  | {
      ok: true
      dbPath: string
      totalScanned: number
      imported: number
      skipped: number
      latestDate: string | null
      daysTouched: number
    }
  | {
      ok: false
      dbPath: string
      error: string
    }

export type JournalChangedEvent = {
  reason: 'created' | 'updated' | 'deleted' | 'external-write' | 'legacy-sync' | 'config-changed'
  dates: string[]
  timestamp: number
}

export type JournalDiscussTarget =
  | { kind: 'desk'; deskRoot: string }
  | { kind: 'project'; projectId: string }

export type FeishuBridgeDomain = 'feishu' | 'lark'

export type FeishuBridgeConnectionState =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export type FeishuBridgePublicConfig = {
  enabled: boolean
  appId: string
  hasAppSecret: boolean
  appSecretMasked: string
  allowedChatId: string
  allowedOpenId: string
  domain: FeishuBridgeDomain
  reactionEmoji: string
}

export type FeishuBridgeConfigUpdate = {
  enabled?: boolean
  appId?: string
  /** Omit (undefined) to keep existing secret; pass '' to clear */
  appSecret?: string
  allowedChatId?: string
  allowedOpenId?: string
  domain?: FeishuBridgeDomain
  reactionEmoji?: string
}

export type FeishuBridgeStatus = {
  state: FeishuBridgeConnectionState
  config: FeishuBridgePublicConfig
  lastError: string | null
  lastMessageAt: number | null
  receivedCount: number
  /** Non-fatal warning when emoji reaction could not be sent (e.g. missing permission) */
  reactionWarning: string | null
}
