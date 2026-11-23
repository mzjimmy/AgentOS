/**
 * Local Zero-DB file persistence for SentinelDesk Language Push.
 *
 * Storage layout under `<deskRoot>/language/`:
 * - `config.json` — languages, difficulty thresholds, daily caps, modelPick
 * - `deck.json` — canonical cards + `processedEntryIds` for idempotent re-runs
 * - `corpus/YYYY/MM/YYYY-MM-DD.json` — silent background translated corpus archive (private-free)
 * - `runs/YYYY-MM-DD.json` — daily extraction run metadata
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  LANGUAGE_PUSH_DEFAULT_CONFIG,
  LANGUAGE_PUSH_SUPPORTED_LANGS,
  type LanguagePushCard,
  type LanguagePushCardKind,
  type LanguagePushConfig,
  type LanguagePushCorpusItem,
  type LanguagePushDecisionAction,
  type LanguagePushEnLevel,
  type LanguagePushJaLevel,
  type LanguagePushLang,
  type LanguagePushOverview,
  type LanguagePushRunSnapshot,
  type LanguagePushRunState,
} from '../../src/language-push-contract'
import { getShanghaiLogicalDay } from './intent-todo-time'
import {
  buildDailyQueue,
  isBelowDifficultyThreshold,
  normalizeCanonicalKey,
  normalizeReadingKey,
  scheduleNextReview,
} from './language-push-scheduler'

const DECK_SCHEMA_VERSION = 1

type LanguagePushDeckFile = {
  version: number
  cards: Record<string, LanguagePushCard>
  /** Maps `<entryId>` -> logicalDate when already extracted (prevents duplicate cloud extraction). */
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
      byKey.set(`${item.entryId}:${item.lang}`, item)
    }
    let added = 0
    for (const item of incoming) {
      const key = `${item.entryId}:${item.lang}`
      const text = item.translatedText.trim()
      if (!text) continue
      if (!byKey.has(key)) added += 1
      byKey.set(key, { ...item, translatedText: text, createdAt: nowIso })
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

        // SentinelLab dedup rule: exact reading match or either side empty reading
        const matched =
          existingList.find((c) => c.readingKey === readingKey) ??
          existingList.find((c) => c.readingKey === '' || readingKey === '')

        if (matched) {
          if (matched.status === 'mastered') {
            skippedMastered += 1
            continue
          }
          const isNewDay = matched.lastSeenDate !== raw.sourceDate
          matched.seenDays = isNewDay ? matched.seenDays + 1 : matched.seenDays
          matched.lastSeenDate = raw.sourceDate > matched.lastSeenDate ? raw.sourceDate : matched.lastSeenDate
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
            pronunciations:
              raw.examplePronunciations && raw.examplePronunciations.length > 0
                ? raw.examplePronunciations
                : undefined,
          },
          status: 'active',
          pinned: false,
          exposures: 0,
          seenDays: 1,
          firstSeenDate: raw.sourceDate || input.logicalDate,
          lastSeenDate: raw.sourceDate || input.logicalDate,
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
          filteredBelowThreshold,
          skippedMastered,
        },
      }
      writeJsonAtomic(this.getRunPath(input.logicalDate), runSnapshot)

      return {
        addedCards,
        updatedCards,
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
        case 'master': {
          card.status = 'mastered'
          card.pinned = false
          card.lastShownAt = today
          card.updatedAt = nowIso
          break
        }
        case 'pin': {
          card.status = 'active'
          card.pinned = true
          if (card.dueAt > today) card.dueAt = today
          card.updatedAt = nowIso
          break
        }
        case 'unpin': {
          card.pinned = false
          card.updatedAt = nowIso
          break
        }
        case 'later': {
          const prevExposures = card.exposures
          card.exposures = prevExposures + 1
          card.lastShownAt = today
          card.dueAt = scheduleNextReview(prevExposures, today)
          card.updatedAt = nowIso
          break
        }
        case 'restore': {
          card.status = 'active'
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

  buildOverview(params: {
    runState: LanguagePushRunState
    runError: string | null
    providerDisplay: { providerName: string; modelName: string; configured: boolean; ttsConfigured: boolean }
  }): LanguagePushOverview {
    const config = this.getConfig()
    const todayDate = getShanghaiLogicalDay(this.now(), config.cutoverHour)
    const deck = this.readDeckSync()
    const allCards = Object.values(deck.cards)
    const { todayCards, backlogCards, masteredCards } = buildDailyQueue(allCards, todayDate, config)

    const todayVocab = todayCards.filter((c) => c.kind === 'vocab').length
    const todayGrammar = todayCards.filter((c) => c.kind === 'grammar').length
    const pinnedTotal = allCards.filter((c) => c.status === 'active' && c.pinned).length

    return {
      todayDate,
      todayCards,
      backlogCards,
      masteredCards,
      counts: {
        todayTotal: todayCards.length,
        todayVocab,
        todayGrammar,
        backlogTotal: backlogCards.length,
        pinnedTotal,
        masteredTotal: masteredCards.length,
        corpusDaysCount: this.countCorpusDays(),
      },
      config,
      runState: params.runState,
      runError: params.runError,
      lastRun: this.getLatestRunSnapshot(),
      providerDisplay: params.providerDisplay,
    }
  }
}
