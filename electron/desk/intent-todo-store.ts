/**
 * Single-source-of-truth (SSOT) store for SentinelDesk Intent Todo (意图待办).
 *
 * - Durable state lives in `<userData>/intent-todo/items.json` (isolated from SentinelDesk
 *   and unaffected by `setJournalDeskRoot`).
 * - Per-day immutable-style snapshots live in `<userData>/intent-todo/runs/YYYY-MM-DD.json`
 *   for historical date-wheel playback.
 * - Human-readable Markdown triage reports are deterministically rendered to
 *   `<deskRoot>/intent-todos/reports/YYYY-MM-DD.md` (zero extra LLM calls).
 * - Every mutation runs inside a serialized `writeChain` lock: read latest → apply → atomic rename,
 *   guaranteeing long-running analyses never clobber concurrent user clicks.
 */

import { existsSync, mkdirSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ChatModelPick } from '../../src/claude-chat-types'
import {
  INTENT_TODO_AUTO_ARCHIVE_DAYS,
  INTENT_TODO_CUTOVER_HOUR,
  INTENT_TODO_DAILY_FOLLOWUP_LIMIT,
  INTENT_TODO_DEFAULT_SNOOZE_DAYS,
  INTENT_TODO_PENDING_EXPIRE_DAYS,
  INTENT_TODO_TITLE_MAX_LEN,
  type IntentTodoActionKind,
  type IntentTodoAnchor,
  type IntentTodoCalendarDay,
  type IntentTodoConfig,
  type IntentTodoDecisionInput,
  type IntentTodoDispatchInfo,
  type IntentTodoDispatchRuntimePhase,
  type IntentTodoItem,
  type IntentTodoOverview,
  type IntentTodoRunSnapshot,
  type IntentTodoRunState,
  type IntentTodoRunStats,
  type IntentTodoSuggestedDone,
  type IntentTodoTrack,
  type IntentTodoUrgency,
} from '../../src/intent-todo-contract'
import {
  diffDateDays,
  getShanghaiCutoverIso,
  getShanghaiLogicalDay,
  shiftDateString,
} from './intent-todo-time'

const STORE_SCHEMA_VERSION = 1

export type DroppedFingerprint = {
  title: string
  droppedAt: string
  logicalDate: string
}

export type IntentTodoStoreState = {
  version: 1
  config: IntentTodoConfig
  /** Map of journal entry contentHash -> ISO timestamp when processed */
  processedEntryHashes: Record<string, string>
  /** Map of journal entry bodyHash -> ISO timestamp when processed (metadata-change immune) */
  processedEntryBodies: Record<string, string>
  /** Sticky rejection memory (14 days) so dismissed intents are not re-suggested */
  droppedFingerprints: DroppedFingerprint[]
  /** Single source of truth for all intent todo items, keyed by id */
  items: Record<string, IntentTodoItem>
  /** Index of logicalDate -> summary of latest run for fast calendar queries */
  runDates: Record<string, { ranAt: string; itemIds: string[] }>
}

export type CandidateIntentTodo = {
  matchesExistingId?: string | null
  title: string
  reason: string
  track: IntentTodoTrack
  actionKind?: IntentTodoActionKind
  urgency: IntentTodoUrgency
  suggestedProjectId: string | null
  suggestedProjectName: string | null
  projectExplicitlyBound: boolean
  targetSurface?: string | null
  repoHint?: string | null
  doneCriteria?: string | null
  nonGoals?: string[]
  antiPatterns: string[]
  anchors: IntentTodoAnchor[]
  suggestedDone?: IntentTodoSuggestedDone | null
}

export type MergeAnalysisInput = {
  logicalDate: string
  ranAt: string
  providerName: string
  modelUsed: string
  processedHashes: string[]
  processedBodyHashes?: string[]
  candidates: CandidateIntentTodo[]
  stats: Omit<IntentTodoRunStats, 'createdCount' | 'mergedCount'>
  deskRoot?: string
  forceReanalyze?: boolean
}

function normalizeDedupTitle(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}

const URGENCY_RANK: Record<IntentTodoUrgency, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

function normalizeModelPick(raw: unknown): ChatModelPick | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : ''
  const anthropicModel = typeof rec.anthropicModel === 'string' ? rec.anthropicModel.trim() : ''
  if (!providerId || !anthropicModel) return null
  return { providerId, anthropicModel }
}

function defaultConfig(): IntentTodoConfig {
  return {
    enabled: true,
    cutoverHour: INTENT_TODO_CUTOVER_HOUR,
    providerConsentAcknowledged: false,
    consentedProviderName: null,
    modelPick: null,
  }
}

function emptyState(): IntentTodoStoreState {
  return {
    version: STORE_SCHEMA_VERSION,
    config: defaultConfig(),
    processedEntryHashes: {},
    processedEntryBodies: {},
    droppedFingerprints: [],
    items: {},
    runDates: {},
  }
}

function migrateState(raw: unknown): IntentTodoStoreState {
  if (!raw || typeof raw !== 'object') return emptyState()
  const obj = raw as Record<string, unknown>
  const cfgRaw = (obj.config && typeof obj.config === 'object' ? obj.config : {}) as Record<string, unknown>
  const cutoverHour =
    typeof cfgRaw.cutoverHour === 'number' && cfgRaw.cutoverHour >= 0 && cfgRaw.cutoverHour <= 23
      ? Math.floor(cfgRaw.cutoverHour)
      : INTENT_TODO_CUTOVER_HOUR

  return {
    version: STORE_SCHEMA_VERSION,
    config: {
      enabled: cfgRaw.enabled !== false,
      cutoverHour,
      providerConsentAcknowledged: cfgRaw.providerConsentAcknowledged === true,
      consentedProviderName:
        typeof cfgRaw.consentedProviderName === 'string' && cfgRaw.consentedProviderName.trim()
          ? cfgRaw.consentedProviderName.trim()
          : null,
      modelPick: normalizeModelPick(cfgRaw.modelPick),
    },
    processedEntryHashes:
      obj.processedEntryHashes && typeof obj.processedEntryHashes === 'object'
        ? { ...(obj.processedEntryHashes as Record<string, string>) }
        : {},
    processedEntryBodies:
      obj.processedEntryBodies && typeof obj.processedEntryBodies === 'object'
        ? { ...(obj.processedEntryBodies as Record<string, string>) }
        : {},
    droppedFingerprints: Array.isArray(obj.droppedFingerprints)
      ? (obj.droppedFingerprints as DroppedFingerprint[]).filter(
          (f) => f && typeof f.title === 'string' && typeof f.logicalDate === 'string',
        )
      : [],
    items:
      obj.items && typeof obj.items === 'object'
        ? { ...(obj.items as Record<string, IntentTodoItem>) }
        : {},
    runDates:
      obj.runDates && typeof obj.runDates === 'object'
        ? { ...(obj.runDates as Record<string, { ranAt: string; itemIds: string[] }>) }
        : {},
  }
}

function escalateUrgency(current: IntentTodoUrgency): IntentTodoUrgency {
  if (current === 'low') return 'medium'
  return 'high'
}

function sortByUrgencyAndRecency(items: IntentTodoItem[]): IntentTodoItem[] {
  return [...items].sort((a, b) => {
    const urgDiff = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
    if (urgDiff !== 0) return urgDiff
    return b.statusUpdatedAt.localeCompare(a.statusUpdatedAt)
  })
}

function clampTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= INTENT_TODO_TITLE_MAX_LEN) return cleaned
  return `${cleaned.slice(0, INTENT_TODO_TITLE_MAX_LEN - 1)}…`
}

function renderMarkdownReport(snapshot: IntentTodoRunSnapshot, items: IntentTodoItem[]): string {
  const lines: string[] = [
    '---',
    `logicalDate: ${snapshot.logicalDate}`,
    `ranAt: ${snapshot.ranAt}`,
    `provider: ${snapshot.providerName}`,
    `model: ${snapshot.modelUsed}`,
    '---',
    '',
    `# ${snapshot.logicalDate} 意图分析待办报告`,
    '',
    '## 分诊概览',
    `- 扫描日记条目：${snapshot.stats.scannedEntries}（新增人写：${snapshot.stats.newHumanEntries}，已过滤私密：${snapshot.stats.skippedPrivate}，疑似粘贴 AI：${snapshot.stats.suspectedAiPaste}）`,
    `- 过滤噪声/纯状态：${snapshot.stats.ignoredNoiseCount} 条`,
    `- 本轮新增待办：${snapshot.stats.createdCount} 项，合并去重：${snapshot.stats.mergedCount} 项`,
    `- 耗时：${(snapshot.stats.durationMs / 1000).toFixed(1)}s`,
    '',
    '## 待办清单',
  ]

  if (items.length === 0) {
    lines.push('_本轮未提取到新的可执行待办。_')
  } else {
    for (const item of items) {
      const trackLabel =
        item.track === 'engineering'
          ? `工程 · ${item.confirmedProjectName || item.suggestedProjectName || '未匹配项目'}`
          : '生活'
      const urgLabel = item.urgency === 'high' ? '高' : item.urgency === 'medium' ? '中' : '低'
      const anchorStr = item.anchors.map((a) => `⟨${a.date} ${a.time} · ${a.entryId}⟩`).join(' ')
      lines.push(`- **[${urgLabel}] [${trackLabel}] ${item.title}**（状态：\`${item.status}\`${item.actionKind ? ` · 动作：\`${item.actionKind}\`` : ''}）`)
      if (item.reason) lines.push(`  - 理由：${item.reason}`)
      if (item.targetSurface) lines.push(`  - 归属界面/落点：${item.targetSurface}`)
      if (item.doneCriteria) lines.push(`  - 完成标准：${item.doneCriteria}`)
      if (item.nonGoals && item.nonGoals.length > 0) lines.push(`  - 明确不做：${item.nonGoals.join('；')}`)
      if (item.antiPatterns.length > 0) lines.push(`  - 反模式/约束：${item.antiPatterns.join('；')}`)
      if (item.suggestedDone) {
        lines.push(`  - 疑似已完成线索：\`${item.suggestedDone.sha}\` ${item.suggestedDone.message}`)
      }
      if (anchorStr) lines.push(`  - 锚点：${anchorStr}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export class IntentTodoStore {
  private readonly baseDir: string
  private readonly itemsFilePath: string
  private readonly runsDir: string
  private writeChain: Promise<void> = Promise.resolve()
  private readonly now: () => Date

  constructor(options: { userDataPath: string; now?: () => Date }) {
    this.baseDir = path.join(options.userDataPath, 'intent-todo')
    this.itemsFilePath = path.join(this.baseDir, 'items.json')
    this.runsDir = path.join(this.baseDir, 'runs')
    this.now = options.now ?? (() => new Date())
  }

  getItemsFilePath(): string {
    return this.itemsFilePath
  }

  getRunFilePath(logicalDate: string): string {
    return path.join(this.runsDir, `${logicalDate}.json`)
  }

  /** Serializes all state mutations so concurrent clicks and async analyses never race. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation)
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private readStateSync(): IntentTodoStoreState {
    if (!existsSync(this.itemsFilePath)) {
      return emptyState()
    }
    try {
      const raw = JSON.parse(readFileSync(this.itemsFilePath, 'utf8'))
      return migrateState(raw)
    } catch {
      return emptyState()
    }
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(3).toString('hex')}.tmp`
    await fs.writeFile(tmpPath, content, 'utf8')
    await fs.rename(tmpPath, filePath)
  }

  private async saveState(state: IntentTodoStoreState): Promise<void> {
    await this.atomicWriteFile(this.itemsFilePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  private readRunSnapshotSync(logicalDate: string): IntentTodoRunSnapshot | null {
    const filePath = this.getRunFilePath(logicalDate)
    if (!existsSync(filePath)) return null
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as IntentTodoRunSnapshot
    } catch {
      return null
    }
  }

  /**
   * Prunes auto-archive candidates:
   * - Untouched `pending` items older than 3 days -> auto-archived so historical backlog never piles up.
   * - Untouched `later` items older than 14 days -> auto-archived.
   * - Old `droppedFingerprints` older than 14 days -> pruned.
   */
  private applyHousekeeping(state: IntentTodoStoreState, todayLogicalDate: string, nowIso: string): boolean {
    let mutated = false

    const recordDroppedFingerprint = (title: string) => {
      const norm = normalizeDedupTitle(title)
      if (!norm) return
      const exists = state.droppedFingerprints.some((fp) => normalizeDedupTitle(fp.title) === norm)
      if (!exists) {
        state.droppedFingerprints.push({
          title,
          droppedAt: nowIso,
          logicalDate: todayLogicalDate,
        })
      }
    }

    for (const item of Object.values(state.items)) {
      // 1a. Auto-expire untouched `pending` items after 3 days
      if (item.status === 'pending') {
        const refDate = item.lastMentionedDate || item.firstSeenDate
        if (refDate && diffDateDays(refDate, todayLogicalDate) >= INTENT_TODO_PENDING_EXPIRE_DAYS) {
          item.status = 'dropped'
          item.autoArchived = true
          item.statusUpdatedAt = nowIso
          item.history.push({
            at: nowIso,
            action: 'auto_archived',
            note: `超过 ${INTENT_TODO_PENDING_EXPIRE_DAYS} 天未决策自动沉睡归档`,
          })
          recordDroppedFingerprint(item.title)
          mutated = true
        }
        continue
      }

      // 1b. Auto-archive stale `later` items untouched for >= 14 days
      if (item.status === 'later') {
        const updatedDate = getShanghaiLogicalDay(new Date(item.statusUpdatedAt), state.config.cutoverHour)
        if (diffDateDays(updatedDate, todayLogicalDate) >= INTENT_TODO_AUTO_ARCHIVE_DAYS) {
          item.status = 'dropped'
          item.autoArchived = true
          item.statusUpdatedAt = nowIso
          item.history.push({
            at: nowIso,
            action: 'auto_archived',
            note: `超过 ${INTENT_TODO_AUTO_ARCHIVE_DAYS} 天未处理自动归档`,
          })
          recordDroppedFingerprint(item.title)
          mutated = true
        }
      }
    }

    // 2. Keep droppedFingerprints within 14 days
    const beforeLen = state.droppedFingerprints.length
    state.droppedFingerprints = state.droppedFingerprints.filter(
      (fp) => diffDateDays(fp.logicalDate, todayLogicalDate) <= INTENT_TODO_AUTO_ARCHIVE_DAYS,
    )
    if (state.droppedFingerprints.length !== beforeLen) {
      mutated = true
    }

    return mutated
  }

  getConfig(): IntentTodoConfig {
    return this.readStateSync().config
  }

  async updateConfig(patch: Partial<IntentTodoConfig>): Promise<IntentTodoConfig> {
    return this.enqueue(async () => {
      const state = this.readStateSync()
      state.config = {
        ...state.config,
        ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
        ...(typeof patch.cutoverHour === 'number' && patch.cutoverHour >= 0 && patch.cutoverHour <= 23
          ? { cutoverHour: Math.floor(patch.cutoverHour) }
          : {}),
        ...(typeof patch.providerConsentAcknowledged === 'boolean'
          ? { providerConsentAcknowledged: patch.providerConsentAcknowledged }
          : {}),
        ...(patch.consentedProviderName !== undefined
          ? { consentedProviderName: patch.consentedProviderName }
          : {}),
        ...(patch.modelPick !== undefined
          ? { modelPick: normalizeModelPick(patch.modelPick) }
          : {}),
      }
      await this.saveState(state)
      return state.config
    })
  }

  getRunSnapshot(logicalDate: string): IntentTodoRunSnapshot | null {
    return this.readRunSnapshotSync(logicalDate)
  }

  getPendingItemsForDate(targetDate: string): IntentTodoItem[] {
    const state = this.readStateSync()
    return Object.values(state.items)
      .filter((item) => item.status === 'pending' && (item.firstSeenDate === targetDate || item.lastMentionedDate === targetDate))
      .map((item) => structuredClone(item))
  }

  getProcessedEntryHashes(): Record<string, string> {
    return this.readStateSync().processedEntryHashes
  }

  getProcessedEntryBodies(): Record<string, string> {
    return this.readStateSync().processedEntryBodies
  }

  getOpenItemsForDedup(): Array<{ id: string; title: string; track: IntentTodoTrack; status: string }> {
    const state = this.readStateSync()
    return Object.values(state.items)
      .filter((item) => item.status === 'pending' || item.status === 'now' || item.status === 'later')
      .map((item) => ({
        id: item.id,
        title: item.title,
        track: item.track,
        status: item.status,
      }))
  }

  getClosedItemsForDate(logicalDate: string): Array<{
    id: string
    title: string
    track: IntentTodoTrack
    status: string
    anchorEntryIds: string[]
  }> {
    const state = this.readStateSync()
    const snapshotIds = new Set(state.runDates[logicalDate]?.itemIds ?? [])
    return Object.values(state.items)
      .filter(
        (item) =>
          (item.status === 'done' || item.status === 'dropped') &&
          (snapshotIds.has(item.id) ||
            item.firstSeenDate === logicalDate ||
            item.lastMentionedDate === logicalDate),
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        track: item.track,
        status: item.status,
        anchorEntryIds: item.anchors.map((a) => a.entryId),
      }))
  }

  getDroppedFingerprints(): DroppedFingerprint[] {
    return this.readStateSync().droppedFingerprints
  }

  hasSuccessfulRunFor(logicalDate: string): boolean {
    const state = this.readStateSync()
    return Boolean(state.runDates[logicalDate])
  }

  getItem(itemId: string): IntentTodoItem | null {
    const state = this.readStateSync()
    return state.items[itemId] ? structuredClone(state.items[itemId]) : null
  }

  getTodayPendingCount(): number {
    const state = this.readStateSync()
    return Object.values(state.items).filter((item) => item.status === 'pending').length
  }

  /**
   * Merges analyzer output into the latest persisted state inside the write lock.
   * User-decided items (`status !== 'pending'` or `dispatch` set) are NEVER overwritten.
   */
  async mergeAnalysisResult(input: MergeAnalysisInput): Promise<{
    snapshot: IntentTodoRunSnapshot
    createdIds: string[]
    mergedIds: string[]
  }> {
    return this.enqueue(async () => {
      const state = this.readStateSync()
      const nowIso = input.ranAt || this.now().toISOString()

      this.applyHousekeeping(state, input.logicalDate, nowIso)

      // Record all processed hashes
      for (const hash of input.processedHashes) {
        if (hash) {
          state.processedEntryHashes[hash] = nowIso
        }
      }
      for (const hash of input.processedBodyHashes || []) {
        if (hash) {
          state.processedEntryBodies[hash] = nowIso
        }
      }

      const createdIds: string[] = []
      const mergedIds: string[] = []
      const touchedItemIds = new Set<string>()
      const prevDayIds = new Set(state.runDates[input.logicalDate]?.itemIds ?? [])
      const droppedTitleSet = new Set(
        state.droppedFingerprints.map((fp) => normalizeDedupTitle(fp.title)).filter(Boolean),
      )

      const findSameDayItemByTitle = (title: string): IntentTodoItem | null => {
        const norm = normalizeDedupTitle(title)
        if (!norm) return null
        for (const item of Object.values(state.items)) {
          const belongsToDay =
            prevDayIds.has(item.id) ||
            item.firstSeenDate === input.logicalDate ||
            item.lastMentionedDate === input.logicalDate
          if (belongsToDay && normalizeDedupTitle(item.title) === norm) {
            return item
          }
        }
        return null
      }

      for (const cand of input.candidates) {
        const existingById =
          cand.matchesExistingId && state.items[cand.matchesExistingId]
            ? state.items[cand.matchesExistingId]
            : null
        const existing = existingById ?? findSameDayItemByTitle(cand.title)

        if (existing) {
          // Append only truly new anchors
          const knownAnchors = new Set(existing.anchors.map((a) => `${a.entryId}:${a.contentHash}`))
          let addedAnchor = false
          for (const anchor of cand.anchors) {
            const key = `${anchor.entryId}:${anchor.contentHash}`
            if (!knownAnchors.has(key)) {
              existing.anchors.push(anchor)
              knownAnchors.add(key)
              addedAnchor = true
            }
          }

          const isHistoricalBackfill =
            Boolean(existing.lastMentionedDate) && input.logicalDate < existing.lastMentionedDate
          if (!isHistoricalBackfill) {
            existing.lastMentionedDate = input.logicalDate
          }

          // Never reopen, escalate, or duplicate an already-closed (`done` / `dropped`) item
          if (existing.status === 'done' || existing.status === 'dropped') {
            mergedIds.push(existing.id)
            touchedItemIds.add(existing.id)
            continue
          }

          // If analysis newly confirms completion, auto-close pending items unless the user explicitly restored them
          if (cand.suggestedDone) {
            existing.suggestedDone = cand.suggestedDone
            const userRestored = existing.history.some((h) => h.action === 'restored')
            if (existing.status === 'pending' && !userRestored) {
              existing.status = 'done'
              existing.statusUpdatedAt = nowIso
              existing.history.push({
                at: nowIso,
                action: 'done',
                note: `分析自动检测已闭环 (${cand.suggestedDone.sha}${cand.suggestedDone.message ? ` · ${cand.suggestedDone.message}` : ''})`,
              })
            }
          }

          // Re-mentioned open item escalates urgency without clobbering user's decision status
          if (
            addedAnchor &&
            !isHistoricalBackfill &&
            (existing.status === 'pending' || existing.status === 'later')
          ) {
            const nextUrgency = escalateUrgency(existing.urgency)
            if (nextUrgency !== existing.urgency) {
              existing.urgency = nextUrgency
              existing.history.push({
                at: nowIso,
                action: 'escalated',
                note: `日记再次提及，紧迫度升至 ${nextUrgency}`,
              })
            }
            // If a snoozed `later` item was mentioned again on a current/newer day, make it due then
            if (existing.status === 'later') {
              existing.snoozeUntil = input.logicalDate
            }
          }

          mergedIds.push(existing.id)
          touchedItemIds.add(existing.id)
          continue
        }

        // Guard against recreating recently dropped or auto-archived items on forceReanalyze
        const normCandTitle = normalizeDedupTitle(cand.title)
        if (input.forceReanalyze && normCandTitle && droppedTitleSet.has(normCandTitle)) {
          continue
        }

        // Create new item — auto-mark as `done` when analyzer already verified completion via git/journal
        const id = `it_${input.logicalDate.replace(/-/g, '')}_${randomBytes(4).toString('hex')}`
        const autoDone = Boolean(cand.suggestedDone)
        const newItem: IntentTodoItem = {
          id,
          firstSeenDate: input.logicalDate,
          lastMentionedDate: input.logicalDate,
          title: clampTitle(cand.title),
          reason: (cand.reason || '').trim().slice(0, 120),
          track: cand.track,
          actionKind: cand.actionKind ?? (cand.track === 'life' ? 'life' : 'implement'),
          urgency: cand.urgency,
          suggestedProjectId: cand.suggestedProjectId ?? null,
          suggestedProjectName: cand.suggestedProjectName ?? null,
          projectExplicitlyBound: cand.projectExplicitlyBound === true,
          confirmedProjectId: cand.projectExplicitlyBound ? cand.suggestedProjectId : null,
          confirmedProjectName: cand.projectExplicitlyBound ? cand.suggestedProjectName : null,
          targetSurface: cand.targetSurface ?? null,
          repoHint: cand.repoHint ?? null,
          doneCriteria: cand.doneCriteria ?? null,
          nonGoals: Array.isArray(cand.nonGoals) ? cand.nonGoals.filter(Boolean) : [],
          antiPatterns: Array.isArray(cand.antiPatterns) ? cand.antiPatterns.filter(Boolean) : [],
          anchors: cand.anchors,
          suggestedDone: cand.suggestedDone ?? null,
          status: autoDone ? 'done' : 'pending',
          statusUpdatedAt: nowIso,
          snoozeUntil: null,
          snoozeCount: 0,
          autoArchived: false,
          dispatch: null,
          history: autoDone
            ? [
                { at: nowIso, action: 'created' },
                {
                  at: nowIso,
                  action: 'done',
                  note: `分析自动检测已闭环 (${cand.suggestedDone!.sha}${cand.suggestedDone!.message ? ` · ${cand.suggestedDone!.message}` : ''})`,
                },
              ]
            : [{ at: nowIso, action: 'created' }],
        }

        state.items[id] = newItem
        createdIds.push(id)
        touchedItemIds.add(id)
      }

      const prevRun = state.runDates[input.logicalDate]
      const prevSnapshot = this.readRunSnapshotSync(input.logicalDate)
      const combinedItemIds = Array.from(
        new Set([...(prevRun?.itemIds ?? []), ...touchedItemIds]),
      )

      const preserveIncrementalStats =
        Boolean(prevSnapshot) && input.stats.newHumanEntries === 0 && createdIds.length === 0 && mergedIds.length === 0

      const maxHumanForDay = Math.max(0, input.stats.scannedEntries - input.stats.skippedPrivate)
      const resolvedNewHumanEntries = input.forceReanalyze
        ? Math.min(input.stats.newHumanEntries, maxHumanForDay)
        : preserveIncrementalStats
          ? Math.min(prevSnapshot!.stats.newHumanEntries, maxHumanForDay)
          : Math.min((prevSnapshot?.stats.newHumanEntries ?? 0) + input.stats.newHumanEntries, maxHumanForDay)
      const resolvedIgnoredNoiseCount = input.forceReanalyze
        ? input.stats.ignoredNoiseCount
        : preserveIncrementalStats
          ? prevSnapshot!.stats.ignoredNoiseCount
          : (prevSnapshot?.stats.ignoredNoiseCount ?? 0) + input.stats.ignoredNoiseCount

      let reportPath: string | null = null
      const snapshot: IntentTodoRunSnapshot = {
        logicalDate: input.logicalDate,
        ranAt: nowIso,
        providerName: input.providerName,
        modelUsed: input.modelUsed,
        cutoverIso: getShanghaiCutoverIso(input.logicalDate, state.config.cutoverHour),
        itemIds: combinedItemIds,
        stats: {
          ...input.stats,
          newHumanEntries: resolvedNewHumanEntries,
          ignoredNoiseCount: resolvedIgnoredNoiseCount,
          createdCount: createdIds.length,
          mergedCount: mergedIds.length,
        },
        reportPath: null,
      }

      // Render deterministic Markdown report to `<deskRoot>/intent-todos/reports/YYYY-MM-DD.md`
      if (input.deskRoot) {
        try {
          reportPath = path.join(input.deskRoot, 'intent-todos', 'reports', `${input.logicalDate}.md`)
          snapshot.reportPath = reportPath
          const reportItems = combinedItemIds
            .map((id) => state.items[id])
            .filter((item): item is IntentTodoItem => Boolean(item))
          const md = renderMarkdownReport(snapshot, reportItems)
          await this.atomicWriteFile(reportPath, md)
        } catch {
          snapshot.reportPath = null
        }
      }

      state.runDates[input.logicalDate] = {
        ranAt: nowIso,
        itemIds: combinedItemIds,
      }

      await this.atomicWriteFile(
        this.getRunFilePath(input.logicalDate),
        `${JSON.stringify(snapshot, null, 2)}\n`,
      )
      await this.saveState(state)

      return { snapshot, createdIds, mergedIds }
    })
  }

  /**
   * Applies a user decision (`now`, `later`, `done`, `dropped`, `restore`, `set_project`)
   * atomically inside the write lock.
   */
  async applyDecision(itemId: string, decision: IntentTodoDecisionInput): Promise<IntentTodoItem | null> {
    return this.enqueue(async () => {
      const state = this.readStateSync()
      const item = state.items[itemId]
      if (!item) return null

      const nowDate = this.now()
      const nowIso = nowDate.toISOString()
      const todayLogical = getShanghaiLogicalDay(nowDate, state.config.cutoverHour)

      switch (decision.action) {
        case 'now': {
          item.status = 'now'
          item.autoArchived = false
          item.snoozeUntil = null
          item.statusUpdatedAt = nowIso
          item.history.push({ at: nowIso, action: 'now' })
          break
        }
        case 'later': {
          const days =
            typeof decision.snoozeDays === 'number' && decision.snoozeDays > 0
              ? Math.floor(decision.snoozeDays)
              : INTENT_TODO_DEFAULT_SNOOZE_DAYS
          item.status = 'later'
          item.autoArchived = false
          item.snoozeCount = (item.snoozeCount || 0) + 1
          item.snoozeUntil = shiftDateString(todayLogical, days)
          item.statusUpdatedAt = nowIso
          item.history.push({ at: nowIso, action: 'later', note: `+${days}d → ${item.snoozeUntil}` })
          break
        }
        case 'done': {
          item.status = 'done'
          item.autoArchived = false
          item.snoozeUntil = null
          item.statusUpdatedAt = nowIso
          item.history.push({ at: nowIso, action: 'done' })
          break
        }
        case 'dropped': {
          item.status = 'dropped'
          item.autoArchived = false
          item.snoozeUntil = null
          item.statusUpdatedAt = nowIso
          item.history.push({ at: nowIso, action: 'dropped' })
          state.droppedFingerprints.push({
            title: item.title,
            droppedAt: nowIso,
            logicalDate: todayLogical,
          })
          break
        }
        case 'restore': {
          item.status = 'pending'
          item.autoArchived = false
          item.snoozeUntil = null
          item.statusUpdatedAt = nowIso
          item.history.push({ at: nowIso, action: 'restored' })
          break
        }
        case 'set_project': {
          item.confirmedProjectId = decision.projectId
          item.confirmedProjectName = decision.projectName
          item.history.push({
            at: nowIso,
            action: 'project_changed',
            note: decision.projectName,
          })
          break
        }
      }

      await this.saveState(state)
      return structuredClone(item)
    })
  }

  /**
   * Records a Main-process dispatch result inside the same serialized write lock.
   */
  async recordDispatch(itemId: string, dispatch: IntentTodoDispatchInfo): Promise<IntentTodoItem | null> {
    return this.enqueue(async () => {
      const state = this.readStateSync()
      const item = state.items[itemId]
      if (!item) return null

      const nowIso = dispatch.at || this.now().toISOString()
      item.status = 'now'
      item.autoArchived = false
      item.snoozeUntil = null
      item.statusUpdatedAt = nowIso
      item.dispatch = dispatch
      if (!dispatch.sandboxed) {
        item.confirmedProjectId = dispatch.projectId
        item.confirmedProjectName = dispatch.projectName
      }
      item.history.push({
        at: nowIso,
        action: 'dispatched',
        note: `${dispatch.projectName} (${dispatch.threadId})`,
      })

      await this.saveState(state)
      return structuredClone(item)
    })
  }

  async runHousekeepingIfNeeded(): Promise<boolean> {
    return this.enqueue(async () => {
      const state = this.readStateSync()
      const nowDate = this.now()
      const todayLogical = getShanghaiLogicalDay(nowDate, state.config.cutoverHour)
      const changed = this.applyHousekeeping(state, todayLogical, nowDate.toISOString())
      if (changed) {
        await this.saveState(state)
      }
      return changed
    })
  }

  listCalendarDays(): IntentTodoCalendarDay[] {
    const state = this.readStateSync()
    const dates = new Set<string>(Object.keys(state.runDates))
    for (const item of Object.values(state.items)) {
      if (item.firstSeenDate) dates.add(item.firstSeenDate)
    }

    const result: IntentTodoCalendarDay[] = []
    for (const date of Array.from(dates).sort()) {
      const runInfo = state.runDates[date]
      const dayItems = runInfo
        ? runInfo.itemIds
            .map((id) => state.items[id])
            .filter((i): i is IntentTodoItem => Boolean(i))
        : Object.values(state.items).filter((i) => i.firstSeenDate === date)

      const pendingCount = dayItems.filter((i) => i.status === 'pending').length
      const hasRun = Boolean(runInfo) || dayItems.length > 0
      const allCleared = hasRun && dayItems.length > 0 && pendingCount === 0

      result.push({
        date,
        hasRun,
        pendingCount,
        allCleared,
      })
    }
    return result
  }

  /**
   * Builds the overview projection strictly scoped to `selectedDate`.
   * - Each date owns its own analyzed items (never bleeding yesterday's pending items onto an empty today).
   * - On today, due follow-ups (`later` with `snoozeUntil <= today`, capped at 3/day) also surface in `activeItems`.
   * - Decisions are actionable on every date.
   */
  buildOverview(params: {
    selectedDate?: string
    runState: IntentTodoRunState
    runError: string | null
    providerName: string
    modelName: string
    brokerAvailable: boolean
    resolveRuntimePhase?: (projectId: string, threadId: string) => IntentTodoDispatchRuntimePhase | null
  }): IntentTodoOverview {
    const state = this.readStateSync()
    const todayLogicalDate = getShanghaiLogicalDay(this.now(), state.config.cutoverHour)
    const selectedDate =
      params.selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(params.selectedDate)
        ? params.selectedDate
        : todayLogicalDate
    const isToday = selectedDate === todayLogicalDate

    const hydrate = (item: IntentTodoItem): IntentTodoItem => {
      const cloned = structuredClone(item)
      if (cloned.dispatch && params.resolveRuntimePhase) {
        cloned.dispatchRuntimePhase = params.resolveRuntimePhase(
          cloned.dispatch.projectId,
          cloned.dispatch.threadId,
        )
      }
      return cloned
    }

    const allItems = Object.values(state.items)
    const todayPendingCount = allItems.filter((i) => i.status === 'pending').length
    const snapshot = this.readRunSnapshotSync(selectedDate)

    // Strictly resolve items belonging to `selectedDate`
    const snapshotIds = snapshot?.itemIds ?? state.runDates[selectedDate]?.itemIds ?? []
    const dayItemMap = new Map<string, IntentTodoItem>()
    for (const id of snapshotIds) {
      const found = state.items[id]
      if (found) dayItemMap.set(found.id, found)
    }
    for (const item of allItems) {
      if (item.firstSeenDate === selectedDate || item.lastMentionedDate === selectedDate) {
        dayItemMap.set(item.id, item)
      }
    }
    const dayItems = Array.from(dayItemMap.values())

    const pendingItems = sortByUrgencyAndRecency(
      dayItems.filter((i) => i.status === 'pending'),
    ).map(hydrate)

    const nowItems = sortByUrgencyAndRecency(
      dayItems.filter((i) => i.status === 'now'),
    ).map(hydrate)

    let surfacedLater: IntentTodoItem[] = []
    let snoozedLaterCount = 0
    if (isToday) {
      const allLater = sortByUrgencyAndRecency(allItems.filter((i) => i.status === 'later'))
      const dueLater = allLater.filter((i) => !i.snoozeUntil || i.snoozeUntil <= todayLogicalDate)
      surfacedLater = dueLater.slice(0, INTENT_TODO_DAILY_FOLLOWUP_LIMIT).map(hydrate)
      snoozedLaterCount = allLater.length - surfacedLater.length
    } else {
      surfacedLater = sortByUrgencyAndRecency(dayItems.filter((i) => i.status === 'later')).map(hydrate)
    }

    const activeItems = [...nowItems, ...surfacedLater]
    const resolvedItems = dayItems
      .filter((i) => i.status === 'done' || i.status === 'dropped')
      .sort((a, b) => b.statusUpdatedAt.localeCompare(a.statusUpdatedAt))
      .map(hydrate)

    const autoArchivedCount = resolvedItems.filter((i) => i.autoArchived === true).length
    const dayTotalCount = dayItems.length
    const dayDecidedCount = dayItems.filter((i) => i.status !== 'pending').length

    return {
      selectedDate,
      todayLogicalDate,
      isToday,
      runState: params.runState,
      runError: params.runError,
      providerName: params.providerName || snapshot?.providerName || '',
      modelName: params.modelName || snapshot?.modelUsed || '',
      brokerAvailable: params.brokerAvailable,
      config: state.config,
      snapshot,
      pendingItems,
      activeItems,
      snoozedLaterCount,
      resolvedItems,
      autoArchivedCount,
      todayPendingCount,
      todayDecidedCount: dayDecidedCount,
      todayTotalCount: dayTotalCount,
    }
  }
}
