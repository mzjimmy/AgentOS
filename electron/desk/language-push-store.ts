/**
 * Local Zero-DB file persistence for SentinelDesk Language Push.
 *
 * Storage layout under `<deskRoot>/language/`:
 * - `config.json` — languages, difficulty thresholds, daily caps, 7-day corpus window, backlog cap, modelPick
 * - `deck.json` — canonical cards + familiarity ratings + `processedEntryIds` for idempotent re-runs
 * - `corpus/YYYY/MM/YYYY-MM-DD.json` — silent background translated corpus archive (private-free, multi-source ready)
 * - `runs/YYYY-MM-DD.json` — daily extraction run metadata
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  LANGUAGE_PUSH_DEFAULT_BACKLOG_CAP,
  LANGUAGE_PUSH_DEFAULT_CONFIG,
  LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS,
  LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
  LANGUAGE_PUSH_SUPPORTED_LANGS,
  type LanguagePushCalendarDay,
  type LanguagePushCard,
  type LanguagePushCardKind,
  type LanguagePushConfig,
  type LanguagePushCorpusItem,
  type LanguagePushCorpusSourceKind,
  type LanguagePushDecisionAction,
  type LanguagePushEnLevel,
  type LanguagePushJaLevel,
  type LanguagePushLang,
  type LanguagePushOverview,
  type LanguagePushRunSnapshot,
  type LanguagePushRunState,
} from '../../src/language-push-contract'
import { getShanghaiLogicalDay, shiftDateString } from './intent-todo-time'
import type { LanguagePushFamiliaritySummary } from './language-push-analyzer'
import {
  buildDailyQueue,
  isBelowDifficultyThreshold,
  normalizeCanonicalKey,
  normalizeReadingKey,
  pruneActiveBacklog,
  scheduleNextReview,
} from './language-push-scheduler'

const DECK_SCHEMA_VERSION = 2
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type LanguagePushDeckFile = {
  version: number
  cards: Record<string, LanguagePushCard>
  /** Maps `<entryId>:<lang>` -> logicalDate when already extracted (prevents duplicate cloud extraction). */
  processedEntryIds: Record<string, string>
}

export type LanguagePushCandidateInput = {
  lang: LanguagePushLang
  kind: LanguagePushCardKind
  surface: string
  reading?: string | null
  meaning: string
  grammarNote?: string | null
  levelTag?: string | null
  exampleSentence: string
  exampleTranslation: string
  examplePronunciations?: Array<{ surface: string; reading: string }>
  sourceDate: string
  sourceEntryId: string
  sourceKind?: LanguagePushCorpusSourceKind
  corpusFreq?: number
  isExpansion?: boolean
}

export type MergeLanguageExtractionInput = {
  logicalDate: string
  providerName: string
  modelUsed: string
  processedEntryIds: string[]
  corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>>
  candidates: LanguagePushCandidateInput[]
  statsBase: {
    scannedEntries: number
    eligibleEntries: number
    skippedPrivate: number
    skippedAlreadyProcessed: number
    durationMs: number
    inputTokens?: number
    outputTokens?: number
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, filePath)
}

function normalizeConfig(raw: unknown): LanguagePushConfig {
  const base = { ...LANGUAGE_PUSH_DEFAULT_CONFIG, enabledLangs: [...LANGUAGE_PUSH_DEFAULT_CONFIG.enabledLangs] }
  if (!raw || typeof raw !== 'object') return base
  const obj = raw as Record<string, unknown>

  const enabledLangs = Array.isArray(obj.enabledLangs)
    ? [...new Set(obj.enabledLangs.filter((v): v is LanguagePushLang => LANGUAGE_PUSH_SUPPORTED_LANGS.includes(v as LanguagePushLang)))]
    : base.enabledLangs

  const dailyLimit = typeof obj.dailyLimit === 'number' && Number.isFinite(obj.dailyLimit)
    ? Math.max(2, Math.min(20, Math.floor(obj.dailyLimit)))
    : base.dailyLimit
  const dailyVocabLimit = typeof obj.dailyVocabLimit === 'number' && Number.isFinite(obj.dailyVocabLimit)
    ? Math.max(0, Math.min(dailyLimit, Math.floor(obj.dailyVocabLimit)))
    : Math.max(0, dailyLimit - Math.min(2, dailyLimit))
  const dailyGrammarLimit = typeof obj.dailyGrammarLimit === 'number' && Number.isFinite(obj.dailyGrammarLimit)
    ? Math.max(0, Math.min(dailyLimit, Math.floor(obj.dailyGrammarLimit)))
    : Math.max(0, dailyLimit - dailyVocabLimit)

  const enLevel: LanguagePushEnLevel = obj.enLevel === '1500' || obj.enLevel === '3000' || obj.enLevel === '5000'
    ? obj.enLevel
    : base.enLevel
  const jaLevel: LanguagePushJaLevel = obj.jaLevel === 'N4' || obj.jaLevel === 'N3' || obj.jaLevel === 'N2' || obj.jaLevel === 'N1'
    ? obj.jaLevel
    : base.jaLevel

  const corpusWindowDays =
    typeof obj.corpusWindowDays === 'number' && Number.isFinite(obj.corpusWindowDays)
      ? Math.max(3, Math.min(30, Math.floor(obj.corpusWindowDays)))
      : LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS

  const backlogCap =
    typeof obj.backlogCap === 'number' && Number.isFinite(obj.backlogCap)
      ? Math.max(15, Math.min(120, Math.floor(obj.backlogCap)))
      : LANGUAGE_PUSH_DEFAULT_BACKLOG_CAP

  const cutoverHour = typeof obj.cutoverHour === 'number' && Number.isFinite(obj.cutoverHour)
    ? Math.max(0, Math.min(12, Math.floor(obj.cutoverHour)))
    : base.cutoverHour
  const speechRate = typeof obj.speechRate === 'number' && Number.isFinite(obj.speechRate)
    ? Math.max(0.6, Math.min(1.4, Number(obj.speechRate.toFixed(2))))
    : base.speechRate

  const modelPick =
    obj.modelPick &&
    typeof obj.modelPick === 'object' &&
    typeof (obj.modelPick as Record<string, unknown>).providerId === 'string' &&
    typeof (obj.modelPick as Record<string, unknown>).anthropicModel === 'string'
      ? {
          providerId: String((obj.modelPick as Record<string, unknown>).providerId).trim(),
          anthropicModel: String((obj.modelPick as Record<string, unknown>).anthropicModel).trim(),
        }
      : null

  const ttsVoiceEn =
    typeof obj.ttsVoiceEn === 'string' && obj.ttsVoiceEn.trim() ? obj.ttsVoiceEn.trim() : base.ttsVoiceEn
  const ttsVoiceJa =
    typeof obj.ttsVoiceJa === 'string' && obj.ttsVoiceJa.trim() ? obj.ttsVoiceJa.trim() : base.ttsVoiceJa
  const ttsModel =
    typeof obj.ttsModel === 'string' && obj.ttsModel.trim() ? obj.ttsModel.trim() : base.ttsModel

  return {
    enabledLangs: enabledLangs.length > 0 ? enabledLangs : ['en', 'ja'],
    dailyLimit,
    dailyVocabLimit,
    dailyGrammarLimit,
    enLevel,
    jaLevel,
    corpusWindowDays,
    backlogCap,
    cutoverHour,
    autoRunEnabled: typeof obj.autoRunEnabled === 'boolean' ? obj.autoRunEnabled : base.autoRunEnabled,
    speechRate,
    ttsVoiceEn,
    ttsVoiceJa,
    ttsModel,
    modelPick: modelPick && modelPick.providerId && modelPick.anthropicModel ? modelPick : null,
  }
}

function makeCardId(lang: LanguagePushLang, kind: LanguagePushCardKind, wordKey: string): string {
  const digest = createHash('sha1').update(`${lang}:${kind}:${wordKey}`).digest('hex').slice(0, 10)
  return `lp_${lang}_${kind}_${digest}`
}

function cardTouchesDate(card: LanguagePushCard, date: string): boolean {
  return (
    card.firstSeenDate === date ||
    card.lastSeenDate === date ||
    card.extractedDate === date ||
    card.example?.sourceDate === date ||
    card.lastRatedAt === date
  )
}

/** Unfamiliar and still-active cards first, then vocab before grammar, then id. */
function compareHistoricalCards(a: LanguagePushCard, b: LanguagePushCard): number {
  const unfamiliarDelta = Number(b.familiarity === 'unfamiliar') - Number(a.familiarity === 'unfamiliar')
  if (unfamiliarDelta !== 0) return unfamiliarDelta
  const activeDelta = Number(b.status === 'active') - Number(a.status === 'active')
  if (activeDelta !== 0) return activeDelta
  if (a.kind !== b.kind) return a.kind === 'vocab' ? -1 : 1
  return a.id.localeCompare(b.id)
}

export class LanguagePushStore {
  private readonly getDeskRoot: () => string
  private readonly now: () => Date
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: { getDeskRoot: () => string; now?: () => Date }) {
    this.getDeskRoot = options.getDeskRoot
    this.now = options.now ?? (() => new Date())
  }

  private getLanguageRoot(): string {
    return path.join(this.getDeskRoot(), 'language')
  }

  getConfigPath(): string {
    return path.join(this.getLanguageRoot(), 'config.json')
  }

  getDeckPath(): string {
    return path.join(this.getLanguageRoot(), 'deck.json')
  }

  getCorpusPath(logicalDate: string): string {
    const [yyyy = '0000', mm = '00'] = logicalDate.split('-')
    return path.join(this.getLanguageRoot(), 'corpus', yyyy, mm, `${logicalDate}.json`)
  }

  getRunPath(logicalDate: string): string {
    return path.join(this.getLanguageRoot(), 'runs', `${logicalDate}.json`)
  }

  getAudioCacheDir(): string {
    return path.join(this.getLanguageRoot(), 'audio-cache')
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  getConfig(): LanguagePushConfig {
    const p = this.getConfigPath()
    if (!existsSync(p)) return normalizeConfig(null)
    try {
      return normalizeConfig(JSON.parse(readFileSync(p, 'utf8')))
    } catch {
      return normalizeConfig(null)
    }
  }

  async saveConfig(patch: Partial<LanguagePushConfig>): Promise<LanguagePushConfig> {
    return this.enqueue(() => {
      const current = this.getConfig()
      const merged = normalizeConfig({ ...current, ...patch })
      writeJsonAtomic(this.getConfigPath(), merged)
      return merged
    })
  }

  private readDeckSync(): LanguagePushDeckFile {
    const p = this.getDeckPath()
    if (!existsSync(p)) {
      return { version: DECK_SCHEMA_VERSION, cards: {}, processedEntryIds: {} }
    }
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<LanguagePushDeckFile>
      return {
        version: DECK_SCHEMA_VERSION,
        cards: parsed.cards && typeof parsed.cards === 'object' ? parsed.cards : {},
        processedEntryIds:
          parsed.processedEntryIds && typeof parsed.processedEntryIds === 'object'
            ? parsed.processedEntryIds
            : {},
      }
    } catch {
      return { version: DECK_SCHEMA_VERSION, cards: {}, processedEntryIds: {} }
    }
  }

  getProcessedEntryIds(): Record<string, string> {
    return { ...this.readDeckSync().processedEntryIds }
  }

  /**
   * Reads archived translated corpus items across the recent `windowDays` (default 7 days).
   * Multi-source ready: preserves `sourceKind` (defaults to `'journal'` for legacy files).
   */
  readRecentCorpusItems(logicalDate: string, windowDays: number): LanguagePushCorpusItem[] {
    const days = Math.max(1, Math.min(30, Math.floor(windowDays || LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS)))
    const collected: LanguagePushCorpusItem[] = []
    for (let offset = 0; offset < days; offset += 1) {
      const date = shiftDateString(logicalDate, -offset)
      const corpusPath = this.getCorpusPath(date)
      if (!existsSync(corpusPath)) continue
      try {
        const parsed = JSON.parse(readFileSync(corpusPath, 'utf8')) as { items?: LanguagePushCorpusItem[] }
        if (!Array.isArray(parsed.items)) continue
        for (const item of parsed.items) {
          if (!item || typeof item !== 'object' || !item.translatedText?.trim()) continue
          collected.push({
            ...item,
            sourceKind: item.sourceKind ?? LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
          })
        }
      } catch {
        /* ignore corrupt corpus day */
      }
    }
    return collected
  }

  /**
   * Builds a compact per-language familiarity profile from the user's rating history
   * to steer subsequent extractions and expand related expressions.
   */
  buildFamiliarityProfileByLang(): Record<LanguagePushLang, LanguagePushFamiliaritySummary> {
    const deck = this.readDeckSync()
    const cards = Object.values(deck.cards).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    const result: Record<LanguagePushLang, LanguagePushFamiliaritySummary> = {
      en: { unfamiliar: [], fuzzy: [], familiar: [], excludedWordKeys: new Set<string>() },
      ja: { unfamiliar: [], fuzzy: [], familiar: [], excludedWordKeys: new Set<string>() },
    }

    for (const card of cards) {
      const bucket = result[card.lang]
      if (!bucket) continue
      if (card.status === 'mastered' || card.status === 'active') {
        bucket.excludedWordKeys.add(card.wordKey)
      }
      if (card.status === 'mastered' || card.familiarity === 'familiar') {
        if (bucket.familiar.length < 15) bucket.familiar.push(card.surface)
      } else if (card.status === 'active' && card.familiarity === 'unfamiliar') {
        if (bucket.unfamiliar.length < 10) {
          bucket.unfamiliar.push({ surface: card.surface, kind: card.kind, meaning: card.meaning })
        }
      } else if (card.status === 'active' && card.familiarity === 'fuzzy') {
        if (bucket.fuzzy.length < 8) {
          bucket.fuzzy.push({ surface: card.surface, kind: card.kind, meaning: card.meaning })
        }
      }
    }

    return result
  }

  getRunSnapshot(logicalDate: string): LanguagePushRunSnapshot | null {
    if (!ISO_DATE_RE.test(logicalDate)) return null
    const p = this.getRunPath(logicalDate)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as LanguagePushRunSnapshot
    } catch {
      return null
    }
  }

  getLatestRunSnapshot(): LanguagePushRunSnapshot | null {
    const runsDir = path.join(this.getLanguageRoot(), 'runs')
    if (!existsSync(runsDir)) return null
    try {
      const files = readdirSync(runsDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
      const latest = files[files.length - 1]
      if (!latest) return null
      return JSON.parse(readFileSync(path.join(runsDir, latest), 'utf8')) as LanguagePushRunSnapshot
    } catch {
      return null
    }
  }

  hasRunFor(logicalDate: string): boolean {
    return existsSync(this.getRunPath(logicalDate))
  }

  private countCorpusDays(): number {
    const corpusRoot = path.join(this.getLanguageRoot(), 'corpus')
    if (!existsSync(corpusRoot)) return 0
    let count = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) count += 1
      }
    }
    try {
      walk(corpusRoot)
    } catch {
      return 0
    }
    return count
  }

  private archiveCorpusSilent(
    logicalDate: string,
    incoming: Array<Omit<LanguagePushCorpusItem, 'createdAt'>>,
    nowIso: string,
  ): number {
    if (incoming.length === 0) return 0
    const corpusPath = this.getCorpusPath(logicalDate)
    let existing: LanguagePushCorpusItem[] = []
    if (existsSync(corpusPath)) {
      try {
        const parsed = JSON.parse(readFileSync(corpusPath, 'utf8')) as { items?: LanguagePushCorpusItem[] }
        if (Array.isArray(parsed.items)) existing = parsed.items
      } catch {
        existing = []
      }
    }

    const byKey = new Map<string, LanguagePushCorpusItem>()
    for (const item of existing) {
      byKey.set(`${item.sourceKind ?? LANGUAGE_PUSH_DEFAULT_SOURCE_KIND}:${item.entryId}:${item.lang}`, item)
    }
    let added = 0
    for (const item of incoming) {
      const sourceKind = item.sourceKind ?? LANGUAGE_PUSH_DEFAULT_SOURCE_KIND
      const key = `${sourceKind}:${item.entryId}:${item.lang}`
      const text = item.translatedText.trim()
      if (!text) continue
      if (!byKey.has(key)) added += 1
      byKey.set(key, { ...item, sourceKind, translatedText: text, createdAt: nowIso })
    }
    writeJsonAtomic(corpusPath, {
      logicalDate,
      updatedAt: nowIso,
      items: [...byKey.values()],
    })
    return added
  }

  async mergeExtractionResult(input: MergeLanguageExtractionInput): Promise<{
    addedCards: number
    updatedCards: number
    archivedOverflow: number
    filteredBelowThreshold: number
    skippedMastered: number
    corpusArchivedCount: number
    runSnapshot: LanguagePushRunSnapshot
  }> {
    return this.enqueue(() => {
      const config = this.getConfig()
      const deck = this.readDeckSync()
      const nowIso = this.now().toISOString()

      const corpusArchivedCount = this.archiveCorpusSilent(input.logicalDate, input.corpusItems, nowIso)

      let addedCards = 0
      let updatedCards = 0
      let filteredBelowThreshold = 0
      let skippedMastered = 0

      // Build lookup index by lang + kind + wordKey
      const indexByKey = new Map<string, LanguagePushCard[]>()
      for (const card of Object.values(deck.cards)) {
        const bucketKey = `${card.lang}:${card.kind}:${card.wordKey}`
        const list = indexByKey.get(bucketKey) ?? []
        list.push(card)
        indexByKey.set(bucketKey, list)
      }

      for (const raw of input.candidates) {
        if (!LANGUAGE_PUSH_SUPPORTED_LANGS.includes(raw.lang)) continue
        const surface = (raw.surface || '').trim()
        const meaning = (raw.meaning || '').trim()
        const sentence = (raw.exampleSentence || '').trim()
        if (!surface || !meaning || !sentence) continue

        if (isBelowDifficultyThreshold(surface, raw.lang, raw.kind, config)) {
          filteredBelowThreshold += 1
          continue
        }

        const wordKey = normalizeCanonicalKey(surface, raw.lang)
        const reading = (raw.reading || '').trim()
        const readingKey = normalizeReadingKey(reading)
        const bucketKey = `${raw.lang}:${raw.kind}:${wordKey}`
        const existingList = indexByKey.get(bucketKey) ?? []

        // Canonical dedup rule: exact reading match or either side empty reading
        const matched =
          existingList.find((c) => c.readingKey === readingKey) ??
          existingList.find((c) => c.readingKey === '' || readingKey === '')

        if (matched) {
          if (matched.status === 'mastered') {
            skippedMastered += 1
            continue
          }
          // Auto-revive previously archived cards if they recur in fresh corpus
          if (matched.status === 'archived') {
            matched.status = 'active'
            matched.dueAt = input.logicalDate
          }
          const isNewDay = matched.lastSeenDate !== raw.sourceDate
          matched.seenDays = isNewDay ? matched.seenDays + 1 : matched.seenDays
          matched.lastSeenDate = raw.sourceDate > matched.lastSeenDate ? raw.sourceDate : matched.lastSeenDate
          if (typeof raw.corpusFreq === 'number' && raw.corpusFreq > (matched.corpusFreq ?? 0)) {
            matched.corpusFreq = raw.corpusFreq
          }
          if (!matched.reading && reading) {
            matched.reading = reading
            matched.readingKey = readingKey
          }
          if (!matched.grammarNote && raw.grammarNote?.trim()) {
            matched.grammarNote = raw.grammarNote.trim()
          }
          matched.updatedAt = nowIso
          updatedCards += 1
          continue
        }

        let id = makeCardId(raw.lang, raw.kind, wordKey)
        if (deck.cards[id]) {
          id = `${id}_${createHash('sha1').update(`${readingKey}:${nowIso}`).digest('hex').slice(0, 4)}`
        }

        const created: LanguagePushCard = {
          id,
          lang: raw.lang,
          kind: raw.kind,
          wordKey,
          readingKey,
          surface,
          reading,
          meaning,
          grammarNote: raw.grammarNote?.trim() || null,
          levelTag: raw.levelTag?.trim() || null,
          example: {
            sentence,
            translation: (raw.exampleTranslation || '').trim(),
            sourceDate: raw.sourceDate || input.logicalDate,
            sourceEntryId: raw.sourceEntryId || '',
            sourceKind: raw.sourceKind ?? LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
            pronunciations:
              raw.examplePronunciations && raw.examplePronunciations.length > 0
                ? raw.examplePronunciations
                : undefined,
          },
          status: 'active',
          familiarity: null,
          lastRatedAt: null,
          corpusFreq: raw.corpusFreq,
          isExpansion: raw.isExpansion === true ? true : undefined,
          exposures: 0,
          seenDays: 1,
          firstSeenDate: raw.sourceDate || input.logicalDate,
          lastSeenDate: raw.sourceDate || input.logicalDate,
          extractedDate: input.logicalDate,
          dueAt: input.logicalDate,
          lastShownAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        deck.cards[id] = created
        existingList.push(created)
        indexByKey.set(bucketKey, existingList)
        addedCards += 1
      }

      for (const entryId of input.processedEntryIds) {
        if (entryId) deck.processedEntryIds[entryId] = input.logicalDate
      }

      // Anti-bloat guard: decay stale untouched cards & cap backlog pool
      const archivedIds = pruneActiveBacklog(Object.values(deck.cards), input.logicalDate, config, nowIso)

      writeJsonAtomic(this.getDeckPath(), deck)

      const runSnapshot: LanguagePushRunSnapshot = {
        logicalDate: input.logicalDate,
        ranAt: nowIso,
        providerName: input.providerName,
        modelUsed: input.modelUsed,
        enabledLangs: [...config.enabledLangs],
        stats: {
          ...input.statsBase,
          corpusArchivedCount,
          addedCards,
          updatedCards,
          archivedOverflow: archivedIds.length,
          filteredBelowThreshold,
          skippedMastered,
        },
      }
      writeJsonAtomic(this.getRunPath(input.logicalDate), runSnapshot)

      return {
        addedCards,
        updatedCards,
        archivedOverflow: archivedIds.length,
        filteredBelowThreshold,
        skippedMastered,
        corpusArchivedCount,
        runSnapshot,
      }
    })
  }

  async applyDecision(
    cardId: string,
    action: LanguagePushDecisionAction,
  ): Promise<{ card: LanguagePushCard | null }> {
    return this.enqueue(() => {
      const config = this.getConfig()
      const deck = this.readDeckSync()
      const card = deck.cards[cardId]
      if (!card) return { card: null }

      const nowDate = this.now()
      const nowIso = nowDate.toISOString()
      const today = getShanghaiLogicalDay(nowDate, config.cutoverHour)

      switch (action) {
        case 'unfamiliar': {
          card.status = 'active'
          card.familiarity = 'unfamiliar'
          card.exposures = 0
          card.lastShownAt = today
          card.lastRatedAt = today
          card.dueAt = scheduleNextReview(0, today, 'unfamiliar')
          card.updatedAt = nowIso
          break
        }
        case 'fuzzy': {
          const prevExposures = card.exposures
          card.status = 'active'
          card.familiarity = 'fuzzy'
          card.exposures = prevExposures + 1
          card.lastShownAt = today
          card.lastRatedAt = today
          card.dueAt = scheduleNextReview(prevExposures, today, 'fuzzy')
          card.updatedAt = nowIso
          break
        }
        case 'familiar': {
          card.status = 'mastered'
          card.familiarity = 'familiar'
          card.lastShownAt = today
          card.lastRatedAt = today
          card.updatedAt = nowIso
          break
        }
        case 'restore': {
          card.status = 'active'
          card.familiarity = 'fuzzy'
          card.dueAt = today
          card.updatedAt = nowIso
          break
        }
      }

      writeJsonAtomic(this.getDeckPath(), deck)
      return { card: structuredClone(card) }
    })
  }

  getTodayCount(): number {
    const config = this.getConfig()
    const today = getShanghaiLogicalDay(this.now(), config.cutoverHour)
    const deck = this.readDeckSync()
    const { todayCards } = buildDailyQueue(Object.values(deck.cards), today, config)
    return todayCards.length
  }

  /**
   * Dates that have at least one card touch, extraction run, or archived corpus file.
   * A card counts once per date even if several of its date fields match that day.
   */
  listCalendarDays(): LanguagePushCalendarDay[] {
    const byDate = new Map<string, { cardIds: Set<string>; hasRun: boolean; hasCorpus: boolean }>()
    const ensure = (raw: string) => {
      if (!ISO_DATE_RE.test(raw)) return null
      let row = byDate.get(raw)
      if (!row) {
        row = { cardIds: new Set<string>(), hasRun: false, hasCorpus: false }
        byDate.set(raw, row)
      }
      return row
    }

    for (const card of Object.values(this.readDeckSync().cards)) {
      const touches = [
        card.firstSeenDate,
        card.lastSeenDate,
        card.extractedDate,
        card.example?.sourceDate,
        card.lastRatedAt,
      ]
      for (const date of touches) {
        if (!date) continue
        ensure(date)?.cardIds.add(card.id)
      }
    }

    const runsDir = path.join(this.getLanguageRoot(), 'runs')
    if (existsSync(runsDir)) {
      try {
        for (const file of readdirSync(runsDir)) {
          const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file)
          if (!match) continue
          const row = ensure(match[1])
          if (row) row.hasRun = true
        }
      } catch {
        /* ignore unreadable runs dir */
      }
    }

    const corpusRoot = path.join(this.getLanguageRoot(), 'corpus')
    if (existsSync(corpusRoot)) {
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          if (!entry.isFile()) continue
          const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(entry.name)
          if (!match) continue
          const row = ensure(match[1])
          if (row) row.hasCorpus = true
        }
      }
      try {
        walk(corpusRoot)
      } catch {
        /* ignore unreadable corpus tree */
      }
    }

    return [...byDate.entries()]
      .map(([date, row]) => ({
        date,
        cardCount: row.cardIds.size,
        hasRun: row.hasRun,
        hasCorpus: row.hasCorpus,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  buildOverview(params: {
    runState: LanguagePushRunState
    runError: string | null
    providerDisplay: { providerName: string; modelName: string; configured: boolean; ttsConfigured: boolean }
    targetDate?: string
  }): LanguagePushOverview {
    const config = this.getConfig()
    const todayDate = getShanghaiLogicalDay(this.now(), config.cutoverHour)
    const selectedDate = params.targetDate && ISO_DATE_RE.test(params.targetDate) ? params.targetDate : todayDate
    const deck = this.readDeckSync()
    const allCards = Object.values(deck.cards)
    const queued = buildDailyQueue(allCards, todayDate, config)
    const todayCards =
      selectedDate === todayDate
        ? queued.todayCards
        : allCards.filter((card) => cardTouchesDate(card, selectedDate)).sort(compareHistoricalCards)

    const todayVocab = todayCards.filter((c) => c.kind === 'vocab').length
    const todayGrammar = todayCards.filter((c) => c.kind === 'grammar').length
    const unfamiliarTotal = allCards.filter((c) => c.status === 'active' && c.familiarity === 'unfamiliar').length
    const fuzzyTotal = allCards.filter((c) => c.status === 'active' && c.familiarity === 'fuzzy').length

    return {
      todayDate,
      selectedDate,
      calendarMarkers: this.listCalendarDays(),
      todayCards,
      backlogCards: queued.backlogCards,
      masteredCards: queued.masteredCards,
      counts: {
        todayTotal: todayCards.length,
        todayVocab,
        todayGrammar,
        backlogTotal: queued.backlogCards.length,
        backlogCap: config.backlogCap,
        unfamiliarTotal,
        fuzzyTotal,
        masteredTotal: queued.masteredCards.length,
        archivedTotal: queued.archivedCards.length,
        corpusDaysCount: this.countCorpusDays(),
      },
      config,
      runState: params.runState,
      runError: params.runError,
      lastRun:
        selectedDate === todayDate
          ? (this.getRunSnapshot(todayDate) ?? this.getLatestRunSnapshot())
          : this.getRunSnapshot(selectedDate),
      providerDisplay: params.providerDisplay,
    }
  }
}
