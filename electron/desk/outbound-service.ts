/**
 * Orchestration service & standalone IPC registrar for SentinelDesk Outbound Studio.
 *
 * - Reads non-private journal entries across lookback window + recent Git commits.
 * - Separates candid Moments/Ship-Logs from single-point WeChat Column seeds & full drafts.
 */

import type { IpcMain } from 'electron'
import type { ChatModelPick, ClaudeAgentResolvedConfig, ClaudeAgentSettingsSnapshot } from '../../src/claude-chat-types'
import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'
import type { JournalDayResult } from '../../src/journal-contract'
import type {
  OutboundChangedEvent,
  OutboundConfig,
  OutboundDraftInput,
  OutboundDraftResult,
  OutboundExtractResult,
  OutboundOverview,
  OutboundRunState,
  OutboundSaveDraftInput,
} from '../../src/outbound-contract'
import { getShanghaiLogicalDay, shiftDateString } from './intent-todo-time'
import {
  collectRecentRepoCommits,
  draftOutboundWeChatArticle,
  extractOutboundDayPack,
  filterPublicJournalEntries,
  type OutboundLlmCaller,
  type SanitizedRepoCommit,
} from './outbound-analyzer'
import { OutboundStore } from './outbound-store'

export interface OutboundJournalReader {
  getConfig(): { deskRoot: string }
  getDay(date: string): Promise<JournalDayResult> | JournalDayResult
}

export interface OutboundSettingsResolver {
  resolve(modelPick?: ChatModelPick): ClaudeAgentResolvedConfig
  getSnapshot(): ClaudeAgentSettingsSnapshot
}

export type OutboundServiceOptions = {
  journalStore: OutboundJournalReader
  settingsStore: OutboundSettingsResolver
  defaultRepoPaths?: () => string[]
  commitCollector?: (repoPaths: readonly string[], sinceDays: number) => SanitizedRepoCommit[]
  now?: () => Date
  llmCaller?: OutboundLlmCaller
  onChanged?: (event: OutboundChangedEvent) => void
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export class OutboundService {
  readonly store: OutboundStore
  private readonly now: () => Date
  private runState: OutboundRunState = 'idle'
  private runningDate: string | null = null
  private draftingSeedId: string | null = null
  private lastError: string | null = null
  private inflightExtract: Promise<OutboundExtractResult> | null = null
  private disposed = false

  constructor(private readonly options: OutboundServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.store = new OutboundStore({
      getDeskRoot: () => options.journalStore.getConfig().deskRoot,
      now: this.now,
    })
  }

  dispose(): void {
    this.disposed = true
  }

  private resolveProviderInfo(): {
    providerName: string
    modelName: string
    configured: boolean
    resolved: ClaudeAgentResolvedConfig
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
    return { providerName, modelName, configured, resolved }
  }

  private emitChanged(reason: OutboundChangedEvent['reason'], date: string): void {
    if (this.disposed) return
    this.options.onChanged?.({
      reason,
      date,
      at: this.now().toISOString(),
    })
  }

  private async loadSanitizedContext(anchorDate: string, config: OutboundConfig) {
    const windowDays = Math.max(1, Math.min(14, config.journalWindowDays || 5))
    const rawDays = []
    for (let i = 0; i < windowDays; i += 1) {
      const dateStr = shiftDateString(anchorDate, -i)
      const res = await this.options.journalStore.getDay(dateStr)
      rawDays.push({
        date: dateStr,
        entries: res && res.ok ? res.entries : [],
      })
    }
    const { publicEntries, skippedPrivate } = filterPublicJournalEntries(rawDays)
    const repoPaths =
      config.repoPaths.length > 0
        ? config.repoPaths
        : (this.options.defaultRepoPaths?.() ?? [])
    const collector = this.options.commitCollector ?? collectRecentRepoCommits
    const commits = collector(repoPaths, config.commitWindowDays)
    return { publicEntries, skippedPrivate, commits }
  }

  getOverview(selectedDate?: string): OutboundOverview {
    const todayDate = getShanghaiLogicalDay(this.now(), 4)
    const date = selectedDate && DATE_RE.test(selectedDate) ? selectedDate : todayDate
    const config = this.store.getConfig()
    const info = this.resolveProviderInfo()
    return {
      selectedDate: date,
      todayDate,
      runState: !info.configured && this.runState === 'idle' ? 'needs_config' : this.runState,
      runningDate: this.runningDate,
      draftingSeedId: this.draftingSeedId,
      lastError: this.lastError,
      modelConfigured: info.configured,
      providerName: info.providerName,
      modelName: info.modelName,
      config,
      dayPack: this.store.getDayPack(date),
      drafts: this.store.listDrafts(),
      calendarDays: this.store.listCalendarDays(),
    }
  }

  getConfig(): OutboundConfig {
    return this.store.getConfig()
  }

  saveConfig(patch: Partial<OutboundConfig>): OutboundConfig {
    const saved = this.store.saveConfig(patch)
    this.emitChanged('config', getShanghaiLogicalDay(this.now(), 4))
    return saved
  }

  async extract(options?: { date?: string; force?: boolean }): Promise<OutboundExtractResult> {
    if (this.inflightExtract) return this.inflightExtract
    const todayDate = getShanghaiLogicalDay(this.now(), 4)
    const targetDate = options?.date && DATE_RE.test(options.date) ? options.date : todayDate

    if (!options?.force) {
      const existing = this.store.getDayPack(targetDate)
      if (existing) {
        return { ok: true, date: targetDate, dayPack: existing }
      }
    }

    const task = this.executeExtract(targetDate)
    this.inflightExtract = task
    try {
      return await task
    } finally {
      this.inflightExtract = null
    }
  }

  private async executeExtract(targetDate: string): Promise<OutboundExtractResult> {
    const info = this.resolveProviderInfo()
    if (!info.configured) {
      this.runState = 'needs_config'
      this.lastError = '尚未配置云端模型凭据。'
      this.emitChanged('extracted', targetDate)
      return { ok: false, date: targetDate, error: this.lastError }
    }

    this.runState = 'running'
    this.runningDate = targetDate
    this.lastError = null
    this.emitChanged('extracted', targetDate)

    try {
      const config = this.store.getConfig()
      const { publicEntries, skippedPrivate, commits } = await this.loadSanitizedContext(targetDate, config)

      const extracted = await extractOutboundDayPack({
        date: targetDate,
        publicEntries,
        skippedPrivateEntries: skippedPrivate,
        commits,
        config,
        resolvedModel: info.resolved,
        llmCaller: this.options.llmCaller,
        nowIso: this.now().toISOString(),
      })

      if (!extracted.ok) {
        this.runState = extracted.kind === 'needs_config' ? 'needs_config' : 'error'
        this.runningDate = null
        this.lastError = extracted.message
        this.emitChanged('extracted', targetDate)
        return { ok: false, date: targetDate, error: extracted.message }
      }

      const saved = this.store.saveDayPack(extracted.dayPack)
      this.runState = 'idle'
      this.runningDate = null
      this.lastError = null
      this.emitChanged('extracted', targetDate)
      return { ok: true, date: targetDate, dayPack: saved }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '提炼外宣素材失败'
      this.runState = 'error'
      this.runningDate = null
      this.lastError = msg
      this.emitChanged('extracted', targetDate)
      return { ok: false, date: targetDate, error: msg }
    }
  }

  async generateDraft(input: OutboundDraftInput): Promise<OutboundDraftResult> {
    const safeDate = DATE_RE.test(input.date) ? input.date : getShanghaiLogicalDay(this.now(), 4)
    const pack = this.store.getDayPack(safeDate)
    const seed = pack?.seeds.find((s) => s.id === input.seedId)
    if (!pack || !seed) {
      return { ok: false, error: '未找到对应的公众号选题种子。' }
    }

    const info = this.resolveProviderInfo()
    if (!info.configured) {
      this.runState = 'needs_config'
      return { ok: false, error: '尚未配置云端模型凭据。' }
    }

    this.runState = 'drafting'
    this.runningDate = safeDate
    this.draftingSeedId = seed.id
    this.lastError = null
    this.emitChanged('drafted', safeDate)

    try {
      const config = this.store.getConfig()
      const { publicEntries, commits } = await this.loadSanitizedContext(safeDate, config)
      const provisionalPath = this.store.draftMarkdownPath(safeDate, seed.id)

      const drafted = await draftOutboundWeChatArticle({
        date: safeDate,
        seed,
        publicEntries,
        commits,
        config,
        customAngle: input.customAngle,
        markdownPath: provisionalPath,
        resolvedModel: info.resolved,
        llmCaller: this.options.llmCaller,
        nowIso: this.now().toISOString(),
      })

      if (!drafted.ok) {
        this.runState = drafted.kind === 'needs_config' ? 'needs_config' : 'error'
        this.runningDate = null
        this.draftingSeedId = null
        this.lastError = drafted.message
        this.emitChanged('drafted', safeDate)
        return { ok: false, error: drafted.message }
      }

      const saved = this.store.upsertDraft(drafted.draft)
      this.runState = 'idle'
      this.runningDate = null
      this.draftingSeedId = null
      this.lastError = null
      this.emitChanged('drafted', safeDate)
      return { ok: true, draft: saved }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '公众号初稿生成失败'
      this.runState = 'error'
      this.runningDate = null
      this.draftingSeedId = null
      this.lastError = msg
      this.emitChanged('drafted', safeDate)
      return { ok: false, error: msg }
    }
  }

  saveDraft(input: OutboundSaveDraftInput): OutboundDraftResult {
    const updated = this.store.updateExistingDraft(input)
    if (!updated) {
      return { ok: false, error: '未找到要保存的文章草稿。' }
    }
    this.emitChanged('saved', updated.date)
    return { ok: true, draft: updated }
  }
}

export function registerOutboundIpc(
  ipcMain: IpcMain,
  serviceOrGetter: OutboundService | (() => OutboundService),
): () => void {
  const resolveService = typeof serviceOrGetter === 'function' ? serviceOrGetter : () => serviceOrGetter

  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getOutboundOverview, (_event, selectedDate?: unknown) =>
    resolveService().getOverview(typeof selectedDate === 'string' ? selectedDate : undefined),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.extractOutboundPack, (_event, options?: unknown) => {
    const safe = options && typeof options === 'object' ? (options as { date?: unknown; force?: unknown }) : {}
    return resolveService().extract({
      date: typeof safe.date === 'string' ? safe.date : undefined,
      force: safe.force === true,
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.generateOutboundDraft, (_event, input: unknown) => {
    const safe = input && typeof input === 'object' ? (input as Partial<OutboundDraftInput>) : {}
    return resolveService().generateDraft({
      date: typeof safe.date === 'string' ? safe.date : '',
      seedId: typeof safe.seedId === 'string' ? safe.seedId : '',
      customAngle: typeof safe.customAngle === 'string' ? safe.customAngle : undefined,
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveOutboundDraft, (_event, input: unknown) => {
    const safe = input && typeof input === 'object' ? (input as Partial<OutboundSaveDraftInput>) : {}
    return resolveService().saveDraft({
      draftId: typeof safe.draftId === 'string' ? safe.draftId : '',
      title: typeof safe.title === 'string' ? safe.title : undefined,
      markdown: typeof safe.markdown === 'string' ? safe.markdown : '',
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getOutboundConfig, () => resolveService().getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveOutboundConfig, (_event, patch: unknown) =>
    resolveService().saveConfig((patch && typeof patch === 'object' ? patch : {}) as Partial<OutboundConfig>),
  )

  return () => {
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getOutboundOverview)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.extractOutboundPack)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.generateOutboundDraft)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.saveOutboundDraft)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getOutboundConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.saveOutboundConfig)
  }
}
