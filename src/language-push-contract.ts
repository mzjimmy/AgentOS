/**
 * Frozen contract for SentinelDesk Language Push (外语学习推送板块).
 *
 * Design invariants:
 * - Background translated corpus is archived locally under `<deskRoot>/language/corpus/`
 *   and is NEVER dumped as full translated articles on the UI.
 * - Multi-source corpus ready: `sourceKind` defaults to `'journal'` today and leaves an
 *   extensible slot for future Desk sources (e.g. Morning Brief / 早报).
 * - Foreground UI only surfaces threshold-filtered vocab & grammar interactive cards
 *   (default 8/day: 6 vocab + 2 grammar) across EN + JA with 3-tier familiarity rating
 *   (陌生 / 模糊 / 熟悉) & offline/MiniMax TTS.
 * - Hard privacy filter (`isPrivateJournalEntry` + `scrubSecrets`) intercepts private
 *   journal entries before any cloud call or corpus persistence.
 */

import type { ChatModelPick } from './claude-chat-types'

export const LANGUAGE_PUSH_SUPPORTED_LANGS = ['en', 'ja'] as const
export type LanguagePushLang = (typeof LANGUAGE_PUSH_SUPPORTED_LANGS)[number]

export const LANGUAGE_PUSH_CARD_KINDS = ['vocab', 'grammar'] as const
export type LanguagePushCardKind = (typeof LANGUAGE_PUSH_CARD_KINDS)[number]

/**
 * Extensible corpus source identifier.
 * `'journal'` (时间日记) and `'morning_brief'` (每日早报) are wired today; future Desk
 * windows can register a `LanguagePushCorpusProvider` without changing storage or UI contracts.
 */
export type LanguagePushCorpusSourceKind = 'journal' | 'morning_brief' | (string & {})
export const LANGUAGE_PUSH_DEFAULT_SOURCE_KIND: LanguagePushCorpusSourceKind = 'journal'
export const LANGUAGE_PUSH_MORNING_BRIEF_SOURCE_KIND: LanguagePushCorpusSourceKind = 'morning_brief'

export type LanguagePushCardStatus = 'active' | 'mastered' | 'archived'

/** 3-tier user familiarity rating: 陌生 / 模糊 / 熟悉 */
export const LANGUAGE_PUSH_FAMILIARITY_LEVELS = ['unfamiliar', 'fuzzy', 'familiar'] as const
export type LanguagePushFamiliarity = (typeof LANGUAGE_PUSH_FAMILIARITY_LEVELS)[number]

export type LanguagePushEnLevel = '1500' | '3000' | '5000'
export type LanguagePushJaLevel = 'N4' | 'N3' | 'N2' | 'N1'

export type LanguagePushDecisionAction = 'unfamiliar' | 'fuzzy' | 'familiar' | 'restore'

export type LanguagePushRunState = 'idle' | 'running' | 'needs_config' | 'error'

/** SRS intervals in days for "模糊" (fuzzy) progression. "陌生" always schedules +1 day. */
export const LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS = [3, 7, 14, 30] as const
export const LANGUAGE_PUSH_UNFAMILIAR_INTERVAL_DAYS = 1

/** @deprecated Kept as alias for backward compatibility with older tests/imports. */
export const LANGUAGE_PUSH_REVIEW_INTERVAL_DAYS = LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS

export const LANGUAGE_PUSH_DEFAULT_CUTOVER_HOUR = 4
export const LANGUAGE_PUSH_DEFAULT_SCHEDULE_HOUR = 5
export const LANGUAGE_PUSH_DEFAULT_SCHEDULE_MINUTE = 0
export const LANGUAGE_PUSH_DEFAULT_DAILY_LIMIT = 8
export const LANGUAGE_PUSH_DEFAULT_VOCAB_LIMIT = 6
export const LANGUAGE_PUSH_DEFAULT_GRAMMAR_LIMIT = 2
export const LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS = 7
export const LANGUAGE_PUSH_DEFAULT_BACKLOG_CAP = 40
export const LANGUAGE_PUSH_STALE_ARCHIVE_DAYS = 14
export const LANGUAGE_PUSH_DEFAULT_TTS_MODEL = 'speech-2.8-hd'
export const LANGUAGE_PUSH_DEFAULT_VOICE_EN = 'English_Graceful_Lady'
export const LANGUAGE_PUSH_DEFAULT_VOICE_JA = 'Japanese_KindLady'

export type LanguagePushVoiceOption = {
  id: string
  label: string
  note: string
}

/** Curated account-verified MiniMax voices ported from SentinelLab. */
export const LANGUAGE_PUSH_VOICE_PRESETS: Record<LanguagePushLang, readonly LanguagePushVoiceOption[]> = {
  en: [
    { id: 'English_Graceful_Lady', label: 'Graceful Lady', note: '柔和自然，长时间听感轻（推荐）' },
    { id: 'English_Trustworthy_Man', label: 'Trustworthy Man', note: '稳重清晰，适合连续精读' },
    { id: 'English_Gentle-voiced_man', label: 'Gentle-voiced Man', note: '语气偏轻，节奏平稳' },
    { id: 'English_Diligent_Man', label: 'Diligent Man', note: '颗粒更实，适合跟读' },
    { id: 'English_Aussie_Bloke', label: 'Aussie Bloke', note: '更松弛的口语感' },
  ],
  ja: [
    { id: 'Japanese_KindLady', label: 'Kind Lady', note: '温和通顺，日语纯正（推荐）' },
    { id: 'Japanese_CalmLady', label: 'Calm Lady', note: '平静克制，适合连播听读' },
    { id: 'Japanese_GentleButler', label: 'Gentle Butler', note: '吐字干净，节奏感明确' },
    { id: 'Japanese_DependableWoman', label: 'Dependable Woman', note: '温柔清晰，自然耐听' },
    { id: 'Japanese_IntellectualSenior', label: 'Intellectual Senior', note: '成熟稳重，信息密度高' },
    { id: 'Japanese_OptimisticYouth', label: 'Optimistic Youth', note: '轻快明亮，年轻感更强' },
  ],
}

export type LanguagePushConfig = {
  enabledLangs: LanguagePushLang[]
  dailyLimit: number
  dailyVocabLimit: number
  dailyGrammarLimit: number
  enLevel: LanguagePushEnLevel
  jaLevel: LanguagePushJaLevel
  corpusWindowDays: number
  backlogCap: number
  /** Logical-day boundary (04:00) aligned with IntentTodo/MorningBrief; not the trigger time. */
  cutoverHour: number
  /** Daily auto-extraction trigger time in Asia/Shanghai (default 05:00). */
  scheduleHour: number
  scheduleMinute: number
  autoRunEnabled: boolean
  speechRate: number
  ttsVoiceEn: string
  ttsVoiceJa: string
  ttsModel: string
  modelPick?: ChatModelPick | null
}

export const LANGUAGE_PUSH_DEFAULT_CONFIG: LanguagePushConfig = {
  enabledLangs: ['en', 'ja'],
  dailyLimit: LANGUAGE_PUSH_DEFAULT_DAILY_LIMIT,
  dailyVocabLimit: LANGUAGE_PUSH_DEFAULT_VOCAB_LIMIT,
  dailyGrammarLimit: LANGUAGE_PUSH_DEFAULT_GRAMMAR_LIMIT,
  enLevel: '1500',
  jaLevel: 'N3',
  corpusWindowDays: LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS,
  backlogCap: LANGUAGE_PUSH_DEFAULT_BACKLOG_CAP,
  cutoverHour: LANGUAGE_PUSH_DEFAULT_CUTOVER_HOUR,
  scheduleHour: LANGUAGE_PUSH_DEFAULT_SCHEDULE_HOUR,
  scheduleMinute: LANGUAGE_PUSH_DEFAULT_SCHEDULE_MINUTE,
  autoRunEnabled: true,
  speechRate: 0.95,
  ttsVoiceEn: LANGUAGE_PUSH_DEFAULT_VOICE_EN,
  ttsVoiceJa: LANGUAGE_PUSH_DEFAULT_VOICE_JA,
  ttsModel: LANGUAGE_PUSH_DEFAULT_TTS_MODEL,
  modelPick: null,
}

export type LanguagePushPronunciationHint = {
  surface: string
  reading: string
}

export type LanguagePushExample = {
  sentence: string
  translation: string
  sourceDate: string
  sourceEntryId: string
  sourceKind?: LanguagePushCorpusSourceKind
  pronunciations?: LanguagePushPronunciationHint[]
}

export type LanguagePushCard = {
  id: string
  lang: LanguagePushLang
  kind: LanguagePushCardKind
  wordKey: string
  readingKey: string
  surface: string
  reading: string
  meaning: string
  grammarNote: string | null
  levelTag: string | null
  example: LanguagePushExample
  status: LanguagePushCardStatus
  familiarity?: LanguagePushFamiliarity | null
  lastRatedAt?: string | null
  corpusFreq?: number
  isExpansion?: boolean
  /** @deprecated Legacy field retained as optional for old deck.json compatibility. */
  pinned?: boolean
  exposures: number
  seenDays: number
  firstSeenDate: string
  lastSeenDate: string
  /** Logical extraction date when this card was added to the deck (for archive date lookup). */
  extractedDate?: string
  dueAt: string
  lastShownAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Silent background corpus archive unit (persisted under `<deskRoot>/language/corpus/`,
 * intentionally excluded from LanguagePushOverview so full translated text is never dumped to UI).
 */
export type LanguagePushCorpusItem = {
  entryId: string
  sourceDate: string
  sourceKind?: LanguagePushCorpusSourceKind
  lang: LanguagePushLang
  translatedText: string
  createdAt: string
}

export type LanguagePushRunStats = {
  scannedEntries: number
  eligibleEntries: number
  skippedPrivate: number
  skippedAlreadyProcessed: number
  corpusArchivedCount: number
  addedCards: number
  updatedCards: number
  archivedOverflow?: number
  filteredBelowThreshold: number
  skippedMastered: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
}

export type LanguagePushRunSnapshot = {
  logicalDate: string
  ranAt: string
  providerName: string
  modelUsed: string
  enabledLangs: LanguagePushLang[]
  stats: LanguagePushRunStats
}

export type LanguagePushOverviewCounts = {
  todayTotal: number
  todayVocab: number
  todayGrammar: number
  backlogTotal: number
  backlogCap: number
  unfamiliarTotal: number
  fuzzyTotal: number
  masteredTotal: number
  archivedTotal: number
  corpusDaysCount: number
}

export type LanguagePushCalendarDay = {
  date: string
  cardCount: number
  hasRun: boolean
  hasCorpus: boolean
}

export type LanguagePushOverview = {
  todayDate: string
  /** Currently viewed logical date (YYYY-MM-DD); equals `todayDate` when omitted. */
  selectedDate: string
  /** Archive/activity calendar markers across all dates with cards, runs, or corpus. */
  calendarMarkers: LanguagePushCalendarDay[]
  todayCards: LanguagePushCard[]
  backlogCards: LanguagePushCard[]
  masteredCards: LanguagePushCard[]
  counts: LanguagePushOverviewCounts
  config: LanguagePushConfig
  runState: LanguagePushRunState
  runError: string | null
  lastRun: LanguagePushRunSnapshot | null
  providerDisplay: {
    providerName: string
    modelName: string
    configured: boolean
    ttsConfigured: boolean
  }
}

export type LanguagePushSpeakInput = {
  text: string
  lang: LanguagePushLang
  speed?: number
  voiceId?: string
  pronunciations?: LanguagePushPronunciationHint[]
}

export type LanguagePushSpeakResult =
  | {
      ok: true
      audioBase64: string
      mime: string
      voiceId: string
      provider: 'minimax'
      cached: boolean
    }
  | {
      ok: false
      code: 'tts_not_configured' | 'tts_error'
      message: string
    }

export type LanguagePushRunResult = {
  ok: boolean
  logicalDate: string
  overview: LanguagePushOverview
  error?: string
}

export type LanguagePushActionResult = {
  ok: boolean
  card: LanguagePushCard | null
  overview: LanguagePushOverview
}

export type LanguagePushChangedEvent = {
  reason: 'run-started' | 'run-completed' | 'run-failed' | 'card-decided' | 'config-updated'
  todayCount: number
  runState: LanguagePushRunState
  logicalDate: string
  timestamp: number
}
