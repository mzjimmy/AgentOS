/**
 * Background orchestration service for SentinelDesk Language Push.
 *
 * - Reads non-private journal entries across a sliding lookback window (default 7 days)
 *   and combines them with recent archived translated corpus for high-frequency word mining
 *   + user 3-tier familiarity profile (陌生 / 模糊 / 熟悉) for adaptive expansion.
 * - Multi-source extensible design: defines `LanguagePushCorpusProvider` so future Desk
 *   windows (e.g. Morning Brief / 早报) can plug in alongside the built-in `'journal'` source
 *   without rewriting the storage, scheduler, or UI layers.
 * - Resolves cloud model from ClaudeAgentSettingsStore (supports dedicated `modelPick` override).
 * - Runs silent daily schedule after 04:00 Asia/Shanghai cutover (optional, configurable).
 */

import type { ChatModelPick, ClaudeAgentResolvedConfig, ClaudeAgentSettingsSnapshot } from '../../src/claude-chat-types'
import type { JournalDayResult, JournalEntry } from '../../src/journal-contract'
import {
  LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS,
  LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
  type LanguagePushActionResult,
  type LanguagePushChangedEvent,
  type LanguagePushConfig,
  type LanguagePushCorpusSourceKind,
  type LanguagePushDecisionAction,
  type LanguagePushOverview,
  type LanguagePushRunResult,
  type LanguagePushRunState,
  type LanguagePushSpeakInput,
  type LanguagePushSpeakResult,
} from '../../src/language-push-contract'
import { getShanghaiLogicalDay, hasPassedShanghaiCutover, shiftDateString } from './intent-todo-time'
import { analyzeJournalForLanguagePush, type LanguagePushLlmCaller } from './language-push-analyzer'
import { LanguagePushStore } from './language-push-store'
import {
  resolveMiniMaxTtsCredentials,
  synthesizeLanguagePushSpeech,
  type MiniMaxTtsFetchFn,
} from './language-push-tts'

export interface LanguagePushJournalReader {
  getConfig(): { deskRoot: string }
  getDay(date: string): Promise<JournalDayResult> | JournalDayResult
}

/**
 * Extensible corpus source contract for future Desk modules (e.g., Morning Brief / 早报).
 * Today only the built-in `'journal'` provider is registered; additional providers can be
 * passed via `extraCorpusProviders` in `LanguagePushServiceOptions` when ready.
 */
export interface LanguagePushCorpusProvider {
  readonly kind: LanguagePushCorpusSourceKind
  readEntriesForDate(date: string): Promise<JournalEntry[]>
}

export interface LanguagePushSettingsResolver {
  resolve(modelPick?: ChatModelPick): ClaudeAgentResolvedConfig
  getSnapshot(): ClaudeAgentSettingsSnapshot
}

export type LanguagePushServiceOptions = {
  journalStore: LanguagePushJournalReader
  settingsStore: LanguagePushSettingsResolver
  extraCorpusProviders?: readonly LanguagePushCorpusProvider[]
  now?: () => Date
  isOnline?: () => boolean
  llmCaller?: LanguagePushLlmCaller
  ttsFetchFn?: MiniMaxTtsFetchFn
  onChanged?: (event: LanguagePushChangedEvent) => void
}

const SCHEDULE_TICK_MS = 10 * 60 * 1000

export class LanguagePushService {
  readonly store: LanguagePushStore
  private readonly now: () => Date
  private readonly isOnline: () => boolean
  private readonly corpusProviders: LanguagePushCorpusProvider[]
  private runState: LanguagePushRunState = 'idle'
  private runError: string | null = null
  private inflightRun: { logicalDate: string; force: boolean; promise: Promise<LanguagePushRunResult> } | null = null
  private runChain: Promise<unknown> = Promise.resolve()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly options: LanguagePushServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.isOnline = options.isOnline ?? (() => true)
    this.store = new LanguagePushStore({
      getDeskRoot: () => options.journalStore.getConfig().deskRoot,
      now: this.now,
    })
    const journalProvider: LanguagePushCorpusProvider = {
      kind: LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
      readEntriesForDate: async (date: string) => {
        const res = await options.journalStore.getDay(date)
        return res && res.ok ? res.entries : []
      },
    }
    this.corpusProviders = [journalProvider, ...(options.extraCorpusProviders ?? [])]
  }

  private resolveProviderDisplay(): {
    providerName: string
    modelName: string
    configured: boolean
    ttsConfigured: boolean
    config: ClaudeAgentResolvedConfig
  } {
    const cfg = this.store.getConfig()
    const picked = cfg.modelPick ?? undefined
    const resolved = this.options.settingsStore.resolve(picked)
    const snapshot = this.options.settingsStore.getSnapshot()
    const matchedProvider = picked
      ? snapshot.settings.providers.find((p) => p.id === picked.providerId)
      : undefined
    const activeProvider =
      matchedProvider ??
      snapshot.settings.providers.find((p) => p.id === snapshot.settings.activeProviderId)
    const providerName =
      !matchedProvider && resolved.configSource === 'env'
        ? 'Environment (ANTHROPIC_*)'
        : activeProvider?.name?.trim() || 'Anthropic Provider'
    const modelName = resolved.model?.trim() || activeProvider?.model?.trim() || ''
    const configured = Boolean((resolved.apiKey || '').trim() || (resolved.authToken || '').trim())
    const ttsConfigured = Boolean(resolveMiniMaxTtsCredentials(snapshot, cfg.ttsModel))
    return { providerName, modelName, configured, ttsConfigured, config: resolved }
  }

  private emitChanged(reason: LanguagePushChangedEvent['reason']): void {
    if (this.disposed) return
    const cfg = this.store.getConfig()
    this.options.onChanged?.({
      reason,
      todayCount: this.store.getTodayCount(),
      runState: this.runState,
      logicalDate: getShanghaiLogicalDay(this.now(), cfg.cutoverHour),
      timestamp: Date.now(),
    })
  }

  getOverview(date?: string): LanguagePushOverview {
    const provider = this.resolveProviderDisplay()
    return this.store.buildOverview({
      runState: this.runState,
      runError: this.runError,
      providerDisplay: {
        providerName: provider.providerName,
        modelName: provider.modelName,
        configured: provider.configured,
        ttsConfigured: provider.ttsConfigured,
      },
      targetDate: date,
    })
  }

  async speak(input: LanguagePushSpeakInput): Promise<LanguagePushSpeakResult> {
    const cfg = this.store.getConfig()
    const snapshot = this.options.settingsStore.getSnapshot()
    const credentials = resolveMiniMaxTtsCredentials(snapshot, cfg.ttsModel)
    return synthesizeLanguagePushSpeech({
      credentials,
      config: cfg,
      input,
      cacheDir: this.store.getAudioCacheDir(),
      fetchFn: this.options.ttsFetchFn,
    })
  }

  getConfig(): LanguagePushConfig {
    return this.store.getConfig()
  }

  async saveConfig(patch: Partial<LanguagePushConfig>): Promise<LanguagePushConfig> {
    const updated = await this.store.saveConfig(patch)
    this.emitChanged('config-updated')
    return updated
  }

  async decideCard(
    cardId: string,
    action: LanguagePushDecisionAction,
    date?: string,
  ): Promise<LanguagePushActionResult> {
    const { card } = await this.store.applyDecision(cardId, action)
    this.emitChanged('card-decided')
    return {
      ok: Boolean(card),
      card,
      overview: this.getOverview(date),
    }
  }

  /**
   * Collects entries across the recent `corpusWindowDays` (default 7 days), newest first.
   * Currently backed by the `'journal'` provider; future Desk providers plug in seamlessly.
   */
  private async collectEntriesForRun(
    logicalDate: string,
    windowDays: number,
  ): Promise<JournalEntry[]> {
    const days = Math.max(1, Math.min(30, Math.floor(windowDays || LANGUAGE_PUSH_DEFAULT_CORPUS_WINDOW_DAYS)))
    const combined: JournalEntry[] = []
    for (let offset = 0; offset < days; offset += 1) {
      const date = shiftDateString(logicalDate, -offset)
      for (const provider of this.corpusProviders) {
        const dayEntries = await provider.readEntriesForDate(date)
        if (dayEntries.length > 0) combined.push(...dayEntries)
      }
    }
    return combined
  }

  async runExtraction(options: { date?: string; force?: boolean } = {}): Promise<LanguagePushRunResult> {
    const cfg = this.store.getConfig()
    const logicalDate =
      options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date)
        ? options.date
        : getShanghaiLogicalDay(this.now(), cfg.cutoverHour)
    const force = options.force === true

    if (
      this.inflightRun &&
      this.inflightRun.logicalDate === logicalDate &&
      (!force || this.inflightRun.force)
    ) {
      return this.inflightRun.promise
    }

    const entry: { logicalDate: string; force: boolean; promise: Promise<LanguagePushRunResult> } = {
      logicalDate,
      force,
      promise: null as unknown as Promise<LanguagePushRunResult>,
    }

    const run = this.runChain
      .then(() => this.executeRun({ date: logicalDate, force }))
      .finally(() => {
        if (this.inflightRun === entry) this.inflightRun = null
      })

    entry.promise = run
    this.inflightRun = entry
    this.runChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async executeRun(options: { date?: string; force?: boolean }): Promise<LanguagePushRunResult> {
    const cfg = this.store.getConfig()
    const logicalDate =
      options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date)
        ? options.date
        : getShanghaiLogicalDay(this.now(), cfg.cutoverHour)
    const force = options.force === true

    const provider = this.resolveProviderDisplay()
    if (!provider.configured) {
      this.runState = 'needs_config'
      this.runError = '请先在「模型设置」中配置可用的云端模型 API Key。'
      this.emitChanged('run-failed')
      return { ok: false, logicalDate, overview: this.getOverview(logicalDate), error: this.runError }
    }

    this.runState = 'running'
    this.runError = null
    this.emitChanged('run-started')

    try {
      const processedEntryIds = this.store.getProcessedEntryIds()
      const entries = await this.collectEntriesForRun(logicalDate, cfg.corpusWindowDays)
      const recentCorpusItems = this.store.readRecentCorpusItems(logicalDate, cfg.corpusWindowDays)
      const familiarityByLang = this.store.buildFamiliarityProfileByLang()

      const result = await analyzeJournalForLanguagePush({
        logicalDate,
        entries,
        sourceKind: LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
        processedEntryIds,
        recentCorpusItems,
        familiarityByLang,
        allowCorpusOnlyMine: force,
        force,
        config: cfg,
        resolvedModel: provider.config,
        llmCaller: this.options.llmCaller,
      })

      if (!result.ok) {
        this.runState = result.kind === 'needs_config' ? 'needs_config' : 'error'
        this.runError = result.message
        this.emitChanged('run-failed')
        return { ok: false, logicalDate, overview: this.getOverview(logicalDate), error: result.message }
      }

      await this.store.mergeExtractionResult({
        logicalDate,
        providerName: provider.providerName,
        modelUsed: result.modelUsed,
        processedEntryIds: result.processedEntryIds,
        corpusItems: result.corpusItems,
        candidates: result.candidates,
        statsBase: result.statsBase,
      })

      this.runState = 'idle'
      this.runError = result.partialWarnings?.length ? result.partialWarnings.join('；') : null
      this.emitChanged('run-completed')
      return {
        ok: true,
        logicalDate,
        overview: this.getOverview(logicalDate),
        error: this.runError ?? undefined,
      }
    } catch (error) {
      this.runState = 'error'
      this.runError = error instanceof Error ? error.message : String(error)
      this.emitChanged('run-failed')
      return { ok: false, logicalDate, overview: this.getOverview(logicalDate), error: this.runError }
    }
  }

  private async checkSchedule(): Promise<void> {
    if (this.disposed || this.inflightRun || !this.isOnline()) return
    const cfg = this.store.getConfig()
    if (!cfg.autoRunEnabled) return
    const nowDate = this.now()
    if (!hasPassedShanghaiCutover(nowDate, cfg.cutoverHour)) return
    const logicalDate = getShanghaiLogicalDay(nowDate, cfg.cutoverHour)
    if (this.store.hasRunFor(logicalDate)) return
    if (!this.resolveProviderDisplay().configured) return
    await this.runExtraction({ date: logicalDate }).catch(() => undefined)
  }

  start(): void {
    if (this.disposed || this.tickTimer) return
    this.tickTimer = setInterval(() => {
      void this.checkSchedule()
    }, SCHEDULE_TICK_MS)
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref()
  }

  notifySystemResumeOrFocus(): void {
    void this.checkSchedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }
}
