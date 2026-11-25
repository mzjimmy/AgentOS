/**
 * Orchestration service for SentinelDesk Morning Brief.
 *
 * - Daily schedule runs at most once per Asia/Shanghai morning after `scheduleHour` when enabled
 *   (no wasteful 5-minute polling).
 * - Coordinates vertical feed fetch -> editorial LLM synthesis -> instant backup item swap ->
 *   MiniMax HD Mandarin TTS synthesis & MP3 stitching.
 */

import type { ChatModelPick, ClaudeAgentResolvedConfig, ClaudeAgentSettingsSnapshot } from '../../src/claude-chat-types'
import type {
  MorningBriefChangedEvent,
  MorningBriefConfig,
  MorningBriefOverview,
  MorningBriefRunResult,
  MorningBriefRunState,
  MorningBriefSpeakInput,
  MorningBriefSpeakResult,
  MorningBriefSwapResult,
} from '../../src/morning-brief-contract'
import { formatShanghaiParts, getShanghaiLogicalDay } from './intent-todo-time'
import { resolveMiniMaxTtsCredentials, type MiniMaxTtsFetchFn } from './language-push-tts'
import { synthesizeMorningBriefIssue, type MorningBriefLlmCaller } from './morning-brief-analyzer'
import { fetchAllMorningBriefCandidates, type MorningBriefFetchFn } from './morning-brief-fetcher'
import { MorningBriefStore } from './morning-brief-store'
import { buildMorningBriefSpeakSegments, synthesizeMorningBriefAudio } from './morning-brief-tts'

export interface MorningBriefDeskRootProvider {
  getConfig(): { deskRoot: string }
}

export interface MorningBriefSettingsResolver {
  resolve(modelPick?: ChatModelPick): ClaudeAgentResolvedConfig
  getSnapshot(): ClaudeAgentSettingsSnapshot
}

export type MorningBriefServiceOptions = {
  journalStore: MorningBriefDeskRootProvider
  settingsStore: MorningBriefSettingsResolver
  now?: () => Date
  isOnline?: () => boolean
  feedFetchFn?: MorningBriefFetchFn
  llmCaller?: MorningBriefLlmCaller
  ttsFetchFn?: MiniMaxTtsFetchFn
  onChanged?: (event: MorningBriefChangedEvent) => void
}

const SCHEDULE_TICK_MS = 5 * 60 * 1000
const MAX_AUTO_RETRIES_PER_DAY = 3
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function hasPassedShanghaiSchedule(date: Date, hour: number, minute: number): boolean {
  const parts = formatShanghaiParts(date)
  return parts.hour > hour || (parts.hour === hour && parts.minute >= minute)
}

export class MorningBriefService {
  readonly store: MorningBriefStore
  private readonly now: () => Date
  private readonly isOnline: () => boolean
  private runState: MorningBriefRunState = 'idle'
  private runningDate: string | null = null
  private lastError: string | null = null
  private inflightRun: Promise<MorningBriefRunResult> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private autoRetryDate: string | null = null
  private autoRetryCount = 0
  private disposed = false

  constructor(private readonly options: MorningBriefServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.isOnline = options.isOnline ?? (() => true)
    this.store = new MorningBriefStore({
      getDeskRoot: () => options.journalStore.getConfig().deskRoot,
      now: this.now,
    })
  }

  private resolveProviderInfo(): {
    providerName: string
    modelName: string
    configured: boolean
    ttsConfigured: boolean
    resolved: ClaudeAgentResolvedConfig
    snapshot: ClaudeAgentSettingsSnapshot
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
    return { providerName, modelName, configured, ttsConfigured, resolved, snapshot }
  }

  private emitChanged(reason: MorningBriefChangedEvent['reason'], date: string): void {
    if (this.disposed) return
    this.options.onChanged?.({
      reason,
      date,
      at: this.now().toISOString(),
    })
  }

  start(): void {
    if (this.disposed || this.tickTimer) return
    this.tickTimer = setInterval(() => {
      void this.maybeAutoRun()
    }, SCHEDULE_TICK_MS)
    this.tickTimer.unref?.()
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (!this.disposed) void this.maybeAutoRun()
    }, 10_000)
    this.startupTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  notifySystemResumeOrFocus(): void {
    if (!this.disposed) {
      void this.maybeAutoRun()
    }
  }

  async maybeAutoRun(): Promise<void> {
    if (this.disposed || this.inflightRun) return
    const cfg = this.store.getConfig()
    if (!cfg.autoRunEnabled || !this.isOnline()) return
    const nowDate = this.now()
    if (!hasPassedShanghaiSchedule(nowDate, cfg.scheduleHour, cfg.scheduleMinute)) return
    const today = getShanghaiLogicalDay(nowDate, 4)
    if (this.store.getIssue(today)) return
    const info = this.resolveProviderInfo()
    if (!info.configured) return
    if (this.autoRetryDate !== today) {
      this.autoRetryDate = today
      this.autoRetryCount = 0
    }
    if (this.autoRetryCount >= MAX_AUTO_RETRIES_PER_DAY) return
    this.autoRetryCount += 1
    await this.runBrief({ date: today, force: false })
  }

  getOverview(selectedDate?: string): MorningBriefOverview {
    const todayDate = getShanghaiLogicalDay(this.now(), 4)
    const date = selectedDate && DATE_RE.test(selectedDate) ? selectedDate : todayDate
    const config = this.store.getConfig()
    const info = this.resolveProviderInfo()
    return {
      selectedDate: date,
      todayDate,
      runState: !info.configured && this.runState === 'idle' ? 'needs_config' : this.runState,
      runningDate: this.runningDate,
      lastError: this.lastError,
      modelConfigured: info.configured,
      ttsConfigured: info.ttsConfigured,
      providerName: info.providerName,
      modelName: info.modelName,
      config,
      issue: this.store.getIssue(date),
      calendarDays: this.store.listCalendarDays(),
    }
  }

  getConfig(): MorningBriefConfig {
    return this.store.getConfig()
  }

  saveConfig(patch: Partial<MorningBriefConfig>): MorningBriefConfig {
    const saved = this.store.saveConfig(patch)
    const today = getShanghaiLogicalDay(this.now(), 4)
    this.emitChanged('config', today)
    if (saved.autoRunEnabled) {
      void this.maybeAutoRun()
    }
    return saved
  }

  swapItem(date: string, itemId: string): MorningBriefSwapResult {
    const safeDate = DATE_RE.test(date) ? date : getShanghaiLogicalDay(this.now(), 4)
    const result = this.store.swapStoryItem(safeDate, itemId)
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
    this.emitChanged('swapped', safeDate)
    return { ok: true, issue: result.issue }
  }

  async runBrief(options?: { date?: string; force?: boolean }): Promise<MorningBriefRunResult> {
    if (this.inflightRun) return this.inflightRun
    const todayDate = getShanghaiLogicalDay(this.now(), 4)
    const targetDate = options?.date && DATE_RE.test(options.date) ? options.date : todayDate

    if (!options?.force) {
      const existing = this.store.getIssue(targetDate)
      if (existing) {
        return { ok: true, date: targetDate, issue: existing }
      }
    }

    const task = this.executeRun(targetDate)
    this.inflightRun = task
    try {
      return await task
    } finally {
      this.inflightRun = null
    }
  }

  private async executeRun(targetDate: string): Promise<MorningBriefRunResult> {
    if (this.disposed) {
      return { ok: false, date: targetDate, error: 'Service disposed' }
    }

    const info = this.resolveProviderInfo()
    if (!info.configured) {
      this.runState = 'needs_config'
      this.lastError = '尚未配置云端模型凭据。'
      this.emitChanged('error', targetDate)
      return { ok: false, date: targetDate, error: this.lastError }
    }

    this.runState = 'running'
    this.runningDate = targetDate
    this.lastError = null
    this.emitChanged('running', targetDate)

    try {
      const config = this.store.getConfig()
      const { candidates, sourceHitCount } = await fetchAllMorningBriefCandidates({
        sources: config.sources,
        fetchFn: this.options.feedFetchFn,
      })

      if (this.disposed) {
        this.runState = 'idle'
        this.runningDate = null
        return { ok: false, date: targetDate, error: 'Service disposed' }
      }

      const synth = await synthesizeMorningBriefIssue({
        date: targetDate,
        candidates,
        sourceHitCount,
        config,
        resolvedModel: info.resolved,
        markdownPath: this.store.issueMarkdownPath(targetDate),
        llmCaller: this.options.llmCaller,
        nowIso: this.now().toISOString(),
      })

      if (this.disposed) {
        this.runState = 'idle'
        this.runningDate = null
        return { ok: false, date: targetDate, error: 'Service disposed' }
      }

      if (!synth.ok) {
        this.runState = synth.kind === 'needs_config' ? 'needs_config' : 'error'
        this.runningDate = null
        this.lastError = synth.message
        this.emitChanged('error', targetDate)
        return { ok: false, date: targetDate, error: synth.message }
      }

      const saved = this.store.saveIssue(synth.issue)
      this.runState = 'idle'
      this.runningDate = null
      this.lastError = null
      this.emitChanged('generated', targetDate)
      return { ok: true, date: targetDate, issue: saved }
    } catch (error) {
      if (this.disposed) {
        this.runState = 'idle'
        this.runningDate = null
        return { ok: false, date: targetDate, error: 'Service disposed' }
      }
      const msg = error instanceof Error ? error.message : '早报生成失败'
      this.runState = 'error'
      this.runningDate = null
      this.lastError = msg
      this.emitChanged('error', targetDate)
      return { ok: false, date: targetDate, error: msg }
    }
  }

  async speak(input: MorningBriefSpeakInput): Promise<MorningBriefSpeakResult> {
    const safeDate = DATE_RE.test(input.date) ? input.date : getShanghaiLogicalDay(this.now(), 4)
    const issue = this.store.getIssue(safeDate)
    if (!issue) {
      return {
        ok: false,
        code: 'tts_error',
        message: '当前日期尚未生成早报。',
        segments: [],
      }
    }

    const config = this.store.getConfig()
    const snapshot = this.options.settingsStore.getSnapshot()
    const credentials = resolveMiniMaxTtsCredentials(snapshot, config.ttsModel)

    const result = await synthesizeMorningBriefAudio({
      issue,
      credentials,
      config,
      cacheDir: this.store.ttsCacheDir,
      stitchedOutputPath: this.store.issueAudioPath(safeDate),
      sectionIndex: input.sectionIndex,
      stitchFullIssue: input.stitchFullIssue,
      fetchFn: this.options.ttsFetchFn,
    })

    if (result.ok && result.stitchedAudioPath) {
      this.store.saveIssue({
        ...issue,
        stitchedAudioPath: result.stitchedAudioPath,
        updatedAt: this.now().toISOString(),
      })
      this.emitChanged('audio', safeDate)
    }

    return result
  }

  getSegmentsPreview(date: string) {
    const issue = this.store.getIssue(date)
    return issue ? buildMorningBriefSpeakSegments(issue) : []
  }
}
