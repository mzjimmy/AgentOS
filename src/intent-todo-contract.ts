/**
 * Frozen Shared Wire Contract for SentinelDesk Intent Todo (意图待办).
 * Both Electron main (`electron/desk/intent-todo-*`) and renderer (`src/components/intent-todo/*`)
 * import exclusively from this contract.
 */

import type { ChatModelPick } from './claude-chat-types'

export const INTENT_TODO_CUTOVER_HOUR = 4
export const INTENT_TODO_DEFAULT_SNOOZE_DAYS = 3
export const INTENT_TODO_PENDING_EXPIRE_DAYS = 3
export const INTENT_TODO_DAILY_FOLLOWUP_LIMIT = 3
export const INTENT_TODO_AUTO_ARCHIVE_DAYS = 14
export const INTENT_TODO_TITLE_MAX_LEN = 28

export type IntentTodoUrgency = 'high' | 'medium' | 'low'
export type IntentTodoTrack = 'engineering' | 'life'
export type IntentTodoActionKind = 'implement' | 'investigate' | 'design' | 'life'
export type IntentTodoStatus = 'pending' | 'now' | 'later' | 'done' | 'dropped'

export type IntentTodoRunState =
  | 'idle'
  | 'analyzing'
  | 'ready'
  | 'failed'
  | 'needs_config'
  | 'offline'

export type IntentTodoDispatchRuntimePhase =
  | 'submitting'
  | 'running'
  | 'waiting_permission'
  | 'waiting_answer'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type IntentTodoAnchor = {
  date: string
  time: string
  entryId: string
  contentHash: string
  /** Metadata-only provenance labels. Never carries journal body text. */
  flags?: string[]
}

export type IntentTodoSuggestedDone = {
  sha: string
  message: string
  projectName?: string
}

export type IntentTodoDispatchInfo = {
  projectId: string
  projectName: string
  threadId: string
  at: string
  sandboxed?: boolean
}

export type IntentTodoHistoryEntry = {
  at: string
  action: 'created' | 'escalated' | 'now' | 'later' | 'done' | 'dropped' | 'auto_archived' | 'restored' | 'dispatched' | 'project_changed'
  note?: string
}

export type IntentTodoItem = {
  id: string
  /** Logical date (Asia/Shanghai 04:00 cutover) when first extracted */
  firstSeenDate: string
  /** Latest logical date when mentioned in journal */
  lastMentionedDate: string
  /** Chinese verb-first concise title (<= 28 chars) */
  title: string
  /** One concise grey reason line explaining urgency/value */
  reason: string
  track: IntentTodoTrack
  /** Distinguishes concrete implementation vs audit/question vs design discussion vs life task */
  actionKind?: IntentTodoActionKind
  urgency: IntentTodoUrgency
  /** Suggested project matched from workspace (engineering track) */
  suggestedProjectId: string | null
  suggestedProjectName: string | null
  /** True if matched from explicit @projectRef rather than AI inference */
  projectExplicitlyBound: boolean
  /** User-overridden or confirmed target project */
  confirmedProjectId?: string | null
  confirmedProjectName?: string | null
  /** Explicit user-facing page/surface or entrypoint owning this feature (prevents wrong-page placement) */
  targetSurface?: string | null
  repoHint?: string | null
  /** Concise observable acceptance criterion (what counts as done) */
  doneCriteria?: string | null
  /** Explicit out-of-scope boundaries (what NOT to touch or expand into) */
  nonGoals?: string[]
  antiPatterns: string[]
  anchors: IntentTodoAnchor[]
  /** Optional git-log match suggestion; never auto-hides the item */
  suggestedDone?: IntentTodoSuggestedDone | null
  status: IntentTodoStatus
  statusUpdatedAt: string
  /** Snooze re-surface date (YYYY-MM-DD in Asia/Shanghai) for `later` items */
  snoozeUntil?: string | null
  snoozeCount: number
  /** True if auto-archived after 14 days of inactivity */
  autoArchived?: boolean
  dispatch?: IntentTodoDispatchInfo | null
  /** Live derived runtime phase from ProjectChatBroker (never persisted) */
  dispatchRuntimePhase?: IntentTodoDispatchRuntimePhase | null
  history: IntentTodoHistoryEntry[]
}

export type IntentTodoRunStats = {
  scannedEntries: number
  newHumanEntries: number
  skippedPrivate: number
  suspectedAiPaste: number
  ignoredNoiseCount: number
  createdCount: number
  mergedCount: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
}

export type IntentTodoRunSnapshot = {
  logicalDate: string
  ranAt: string
  providerName: string
  modelUsed: string
  cutoverIso: string
  itemIds: string[]
  stats: IntentTodoRunStats
  reportPath: string | null
}

export type IntentTodoConfig = {
  enabled: boolean
  /** Fixed 04:00 cutover by default; stored as hidden config for future flexibility */
  cutoverHour: number
  /** Whether the user has acknowledged sending non-private journal entries to the active provider */
  providerConsentAcknowledged: boolean
  consentedProviderName: string | null
  /** Dedicated high-accuracy cloud model override for Intent Todo (null/undefined = follow global default) */
  modelPick?: ChatModelPick | null
}

export type IntentTodoCalendarDay = {
  date: string
  hasRun: boolean
  pendingCount: number
  allCleared: boolean
}

export type IntentTodoOverview = {
  selectedDate: string
  todayLogicalDate: string
  isToday: boolean
  runState: IntentTodoRunState
  runError: string | null
  providerName: string
  modelName: string
  brokerAvailable: boolean
  config: IntentTodoConfig
  /** Latest run snapshot for `selectedDate` (if any) */
  snapshot: IntentTodoRunSnapshot | null
  /** Items awaiting decision (today: live pending; past: snapshot pending at the time) */
  pendingItems: IntentTodoItem[]
  /** Today: `now` + due `later` (capped at 3/day); Past: empty or snapshot active */
  activeItems: IntentTodoItem[]
  /** Remaining `later` items snoozed beyond today or capped past daily 3 */
  snoozedLaterCount: number
  /** Done / dropped / auto-archived items */
  resolvedItems: IntentTodoItem[]
  autoArchivedCount: number
  /** Total pending count for today (used for sidebar badge) */
  todayPendingCount: number
  /** Count of items decided today (for "今日已决 n/m") */
  todayDecidedCount: number
  todayTotalCount: number
}

export type IntentTodoDecisionInput =
  | { action: 'now' }
  | { action: 'later'; snoozeDays?: number }
  | { action: 'done' }
  | { action: 'dropped' }
  | { action: 'restore' }
  | { action: 'set_project'; projectId: string; projectName: string }

export type IntentTodoActionResult =
  | { ok: true; item: IntentTodoItem; overview: IntentTodoOverview }
  | { ok: false; error: string }

export type IntentTodoDispatchResult =
  | {
      ok: true
      item: IntentTodoItem
      projectId: string
      projectName: string
      threadId: string
      overview: IntentTodoOverview
    }
  | { ok: false; error: string; code?: 'broker_unavailable' | 'project_not_found' | 'item_not_found' | 'dispatch_failed' }

export type IntentTodoPolishPromptResult =
  | { ok: true; prompt: string; polished: boolean }
  | { ok: false; error: string }

/**
 * Builds an immediate, non-destructive baseline engineering prompt from a todo's structured fields
 * (zero raw journal text). Used to populate the inline dispatch editor instantaneously before
 * optional cloud magic-wand polishing.
 */
export function buildIntentTodoDraftPrompt(item: IntentTodoItem, projectName?: string): string {
  const actionKind = item.actionKind ?? (item.track === 'life' ? 'life' : 'implement')
  const modeLine =
    actionKind === 'investigate'
      ? '核实与汇报现状（严禁擅自写代码）'
      : actionKind === 'design'
        ? '先调研并给出 ≤ 3 个精简方案与取舍（待确认后再动工）'
        : actionKind === 'life'
          ? '梳理清晰可执行步骤与确认点'
          : '先核实落点一致，再按最小范围实施并验证'

  const lines = [
    `【任务目标】${item.title}`,
    projectName ? `【目标项目】${projectName}` : '',
    `【动作形态】${modeLine}`,
    item.reason ? `【背景与依据】${item.reason}` : '',
    item.targetSurface ? `【归属页面 / 表面】${item.targetSurface}` : '',
    item.repoHint ? `【相关模块】${item.repoHint}` : '',
    item.doneCriteria ? `【完成标准】${item.doneCriteria}` : '',
    item.nonGoals && item.nonGoals.length > 0 ? `【明确不做】${item.nonGoals.join('；')}` : '',
    item.antiPatterns.length > 0 ? `【反模式红线】${item.antiPatterns.join('；')}` : '',
  ].filter(Boolean)

  return lines.join('\n')
}

export type IntentTodoRefreshResult =
  | { ok: true; overview: IntentTodoOverview }
  | { ok: false; error: string; overview: IntentTodoOverview }

export type IntentTodoChangedEvent = {
  reason: 'analyzed' | 'decided' | 'dispatched' | 'runtime-phase' | 'config-changed' | 'state-changed'
  todayPendingCount: number
  runState: IntentTodoRunState
  logicalDate: string
  timestamp: number
}
