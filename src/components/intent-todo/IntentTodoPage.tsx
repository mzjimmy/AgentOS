/**
 * 意图待办主视图（Intent Todo）：
 * - 复用时间日记「日期刻度轮」顶栏与「纸 · 墨 · 黛」视觉语言
 * - 极简三按钮决策（立即派发/今日优先 · Follow up · 忽略），AI 推荐描边预选
 * - 主进程待办派发 + 实时运行状态回流 + 原话锚点跳转时间日记
 */

import '../../styles/intent-todo-page.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT,
  CLAUDE_AGENT_SETTINGS_CHANGED_EVENT,
} from '../../app-events'
import type { ChatModelPick, ClaudeAgentSettingsSnapshot } from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  buildIntentTodoDraftPrompt,
  INTENT_TODO_CUTOVER_HOUR,
  type IntentTodoCalendarDay,
  type IntentTodoDecisionInput,
  type IntentTodoDispatchRuntimePhase,
  type IntentTodoItem,
  type IntentTodoOverview,
} from '../../intent-todo-contract'
import { buildModelPickRows, modelPickFromRow, modelPickKey } from '../../model-pick'
import type { WorkspaceProject } from '../types'
import { DeskDatePageShell } from '../desk/DeskDatePageShell'
import { useShanghaiToday } from '../desk/useShanghaiToday'

export type IntentTodoPageProps = {
  hidden?: boolean
  projects: WorkspaceProject[]
  onTodayPendingCountChange?: (count: number) => void
  onOpenDispatchedThread?: (projectId: string, threadId: string) => void
  onNavigateToJournalAnchor?: (date: string, entryId: string) => void
  onOpenModelSettings?: () => void
}

type DispatchConfirmState = {
  itemId: string
  projectId: string
  prompt: string
  polished: boolean
  polishing: boolean
  copied: boolean
  error: string | null
}

type ToastState = {
  message: string
  projectId?: string
  threadId?: string
}

function runtimePhaseLabelKey(phase: IntentTodoDispatchRuntimePhase | null | undefined): string | null {
  switch (phase) {
    case 'submitting':
    case 'running':
      return 'intentTodo.phaseRunning'
    case 'waiting_permission':
    case 'waiting_answer':
      return 'intentTodo.phaseWaitingPlan'
    case 'succeeded':
      return 'intentTodo.phaseSucceeded'
    case 'failed':
    case 'cancelled':
      return 'intentTodo.phaseFailed'
    default:
      return null
  }
}

function runtimePhaseClass(phase: IntentTodoDispatchRuntimePhase | null | undefined): string {
  if (phase === 'waiting_permission' || phase === 'waiting_answer') return 'is-waiting'
  if (phase === 'succeeded') return 'is-succeeded'
  if (phase === 'failed' || phase === 'cancelled') return 'is-failed'
  return ''
}

function formatCompactProjectName(name: string | null | undefined): string {
  if (!name) return ''
  const trimmed = name.trim()
  const stripped = trimmed.replace(/^[\s【\[（(][^】\]）)]+[】\]）)]\s*/, '').trim()
  return stripped || trimmed
}

export function IntentTodoPage({
  hidden = false,
  projects,
  onTodayPendingCountChange,
  onOpenDispatchedThread,
  onNavigateToJournalAnchor,
  onOpenModelSettings,
}: IntentTodoPageProps) {
  const { t } = useI18n()
  const [refreshTick, setRefreshTick] = useState(0)
  const todayLogicalDate = useShanghaiToday({
    cutoverHour: INTENT_TODO_CUTOVER_HOUR,
    refreshToken: refreshTick,
  })
  const [selectedDate, setSelectedDate] = useState<string>(todayLogicalDate)
  const [overview, setOverview] = useState<IntentTodoOverview | null>(null)
  const [calendarDays, setCalendarDays] = useState<IntentTodoCalendarDay[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [activeTab, setActiveTab] = useState<'pending' | 'active' | 'resolved'>('pending')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmDispatch, setConfirmDispatch] = useState<DispatchConfirmState | null>(null)
  const [busyItemIds, setBusyItemIds] = useState<Set<string>>(() => new Set())
  const [selectedFeedback, setSelectedFeedback] = useState<Record<string, 'now' | 'later' | 'done' | 'dropped'>>({})
  const [claudeSettings, setClaudeSettings] = useState<ClaudeAgentSettingsSnapshot | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)

  const selectedDateRef = useRef(selectedDate)
  selectedDateRef.current = selectedDate
  const prevTodayRef = useRef(todayLogicalDate)
  const toastTimerRef = useRef<number | null>(null)
  const settingsAnchorRef = useRef<HTMLDivElement | null>(null)

  // If user was viewing "today" when crossing 04:00 cutover, auto-advance to the new today
  useEffect(() => {
    if (prevTodayRef.current !== todayLogicalDate) {
      if (selectedDateRef.current === prevTodayRef.current) {
        setSelectedDate(todayLogicalDate)
      }
      prevTodayRef.current = todayLogicalDate
    }
  }, [todayLogicalDate])

  const showToast = useCallback((next: ToastState) => {
    setToast(next)
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 4500)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const onMouseDown = (event: MouseEvent) => {
      if (settingsAnchorRef.current?.contains(event.target as Node)) return
      setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [settingsOpen])

  const loadData = useCallback(
    async (dateStr: string) => {
      const api = window.desktop
      if (!api?.getIntentTodoOverview) {
        setLoading(false)
        return
      }
      try {
        const [ov, cal] = await Promise.all([
          api.getIntentTodoOverview(dateStr),
          api.listIntentTodoCalendar ? api.listIntentTodoCalendar() : Promise.resolve([]),
        ])
        if (selectedDateRef.current !== dateStr) return
        setOverview(ov)
        setCalendarDays(Array.isArray(cal) ? cal : [])
        onTodayPendingCountChange?.(ov.todayPendingCount)
      } catch {
        /* ignore transient IPC error */
      } finally {
        setLoading(false)
      }
    },
    [onTodayPendingCountChange],
  )

  useEffect(() => {
    void loadData(selectedDate)
  }, [loadData, selectedDate])

  useEffect(() => {
    const unsub = window.desktop?.onIntentTodoChanged?.((event) => {
      onTodayPendingCountChange?.(event.todayPendingCount)
      setRefreshTick((n) => n + 1)
      void loadData(selectedDateRef.current)
    })
    return () => unsub?.()
  }, [loadData, onTodayPendingCountChange])

  useEffect(() => {
    let disposed = false
    const pullSettings = () => {
      void window.claudeChat
        ?.getSettings()
        .then((snap) => {
          if (!disposed && snap) setClaudeSettings(snap)
        })
        .catch(() => undefined)
    }
    pullSettings()
    window.addEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, pullSettings)
    window.addEventListener(CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT, pullSettings)
    return () => {
      disposed = true
      window.removeEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, pullSettings)
      window.removeEventListener(CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT, pullSettings)
    }
  }, [])

  const cloudModelRows = useMemo(() => {
    const providers = claudeSettings?.settings?.providers ?? []
    return buildModelPickRows(
      providers,
      {
        primary: t('intentTodo.modelSlotPrimary'),
        haiku: 'Haiku',
        sonnet: 'Sonnet',
        opus: 'Opus',
      },
      t('intentTodo.modelFallback'),
    )
  }, [claudeSettings, t])

  const providerNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of claudeSettings?.settings?.providers ?? []) {
      map.set(p.id, p.name?.trim() || p.id)
    }
    return map
  }, [claudeSettings])

  const calendarDayMap = useMemo(() => {
    const map = new Map<string, IntentTodoCalendarDay>()
    for (const day of calendarDays) {
      map.set(day.date, day)
    }
    return map
  }, [calendarDays])

  const calendarMarkers = useMemo(
    () =>
      calendarDays.map((day) => ({
        date: day.date,
        hasActivity: day.hasRun,
        cleared: day.allCleared,
      })),
    [calendarDays],
  )

  const toggleExpand = (itemId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const withBusyItem = async <T,>(itemId: string, fn: () => Promise<T>): Promise<T> => {
    setBusyItemIds((prev) => new Set(prev).add(itemId))
    try {
      return await fn()
    } finally {
      setBusyItemIds((prev) => {
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
    }
  }

  const handleRefresh = async () => {
    const api = window.desktop
    if (!api?.refreshIntentTodo) return
    const res = await api.refreshIntentTodo(selectedDate)
    setOverview(res.overview)
    onTodayPendingCountChange?.(res.overview.todayPendingCount)
    if (api.listIntentTodoCalendar) {
      const cal = await api.listIntentTodoCalendar().catch(() => [])
      setCalendarDays(cal)
    }
  }

  const handleConsentAccept = async () => {
    const api = window.desktop
    if (!api?.saveIntentTodoConfig) return
    await api.saveIntentTodoConfig({
      providerConsentAcknowledged: true,
      consentedProviderName: overview?.providerName ?? null,
    })
    await loadData(selectedDate)
  }

  const handleToggleAutoEnabled = async () => {
    const api = window.desktop
    if (!api?.saveIntentTodoConfig || !overview) return
    await api.saveIntentTodoConfig({ enabled: !overview.config.enabled })
    await loadData(selectedDate)
  }

  const handleSelectCloudModel = async (pickKeyValue: string) => {
    const api = window.desktop
    if (!api?.saveIntentTodoConfig) return
    if (!pickKeyValue) {
      await api.saveIntentTodoConfig({ modelPick: null })
      await loadData(selectedDate)
      return
    }
    const row = cloudModelRows.find((r) => r.pickKey === pickKeyValue)
    if (!row) return
    const nextPick: ChatModelPick = modelPickFromRow(row)
    await api.saveIntentTodoConfig({ modelPick: nextPick })
    await loadData(selectedDate)
  }

  const handleDecide = async (itemId: string, decision: IntentTodoDecisionInput) => {
    const api = window.desktop
    if (!api?.decideIntentTodo) return
    const feedbackAction =
      decision.action === 'now' ||
      decision.action === 'later' ||
      decision.action === 'done' ||
      decision.action === 'dropped'
        ? decision.action
        : null

    if (feedbackAction) {
      setSelectedFeedback((prev) => ({ ...prev, [itemId]: feedbackAction }))
    }

    await withBusyItem(itemId, async () => {
      const delayPromise = feedbackAction
        ? new Promise<void>((resolve) => window.setTimeout(resolve, 260))
        : Promise.resolve()
      const [res] = await Promise.all([
        api.decideIntentTodo!(itemId, decision, selectedDate),
        delayPromise,
      ])
      if (feedbackAction) {
        setSelectedFeedback((prev) => {
          const next = { ...prev }
          delete next[itemId]
          return next
        })
      }
      if (res.ok) {
        setOverview(res.overview)
        onTodayPendingCountChange?.(res.overview.todayPendingCount)
        if (confirmDispatch?.itemId === itemId) setConfirmDispatch(null)
      }
    })
  }

  const executeDispatch = async (
    item: IntentTodoItem,
    projectId?: string,
    sandboxedLife = false,
    promptOverride?: string,
  ) => {
    const api = window.desktop
    if (!api?.dispatchIntentTodo) return
    await withBusyItem(item.id, async () => {
      const res = await api.dispatchIntentTodo!({
        itemId: item.id,
        projectId,
        sandboxedLife,
        selectedDate,
        promptOverride: promptOverride?.trim() ? promptOverride.trim() : undefined,
      })
      if (res.ok) {
        setConfirmDispatch(null)
        setOverview(res.overview)
        onTodayPendingCountChange?.(res.overview.todayPendingCount)
        showToast({
          message: t('intentTodo.dispatchedToast', { project: res.projectName }),
          projectId: res.projectId,
          threadId: res.threadId,
        })
      } else {
        showToast({ message: res.error })
      }
    })
  }

  const handleImmediateClick = (item: IntentTodoItem) => {
    if (item.track === 'life') {
      void handleDecide(item.id, { action: 'now' })
      return
    }
    if (confirmDispatch?.itemId === item.id) {
      setConfirmDispatch(null)
      return
    }
    const targetProjectId = item.confirmedProjectId || item.suggestedProjectId || projects[0]?.id || ''
    const targetProjectName = projects.find((p) => p.id === targetProjectId)?.name
    setConfirmDispatch({
      itemId: item.id,
      projectId: targetProjectId,
      prompt: buildIntentTodoDraftPrompt(item, targetProjectName),
      polished: false,
      polishing: false,
      copied: false,
      error: null,
    })
  }

  const handlePolishDispatchPrompt = async (item: IntentTodoItem) => {
    const api = window.desktop
    if (!api?.polishIntentTodoPrompt || !confirmDispatch || confirmDispatch.itemId !== item.id) return
    const targetProjectName = projects.find((p) => p.id === confirmDispatch.projectId)?.name
    setConfirmDispatch((prev) =>
      prev && prev.itemId === item.id ? { ...prev, polishing: true, error: null } : prev,
    )
    try {
      const res = await api.polishIntentTodoPrompt({
        itemId: item.id,
        projectName: targetProjectName,
        currentPrompt: confirmDispatch.prompt,
      })
      if (res.ok) {
        setConfirmDispatch((prev) =>
          prev && prev.itemId === item.id
            ? { ...prev, prompt: res.prompt, polished: true, polishing: false, error: null }
            : prev,
        )
      } else {
        setConfirmDispatch((prev) =>
          prev && prev.itemId === item.id ? { ...prev, polishing: false, error: res.error } : prev,
        )
      }
    } catch {
      setConfirmDispatch((prev) =>
        prev && prev.itemId === item.id
          ? { ...prev, polishing: false, error: t('intentTodo.polishPromptFailed') }
          : prev,
      )
    }
  }

  const handleCopyDispatchPrompt = async () => {
    if (!confirmDispatch?.prompt.trim()) return
    try {
      await navigator.clipboard.writeText(confirmDispatch.prompt)
      setConfirmDispatch((prev) => (prev ? { ...prev, copied: true } : prev))
      window.setTimeout(() => {
        setConfirmDispatch((prev) => (prev ? { ...prev, copied: false } : prev))
      }, 1600)
    } catch {
      showToast({ message: t('intentTodo.copyPromptFailed') })
    }
  }

  const handleOpenReport = async () => {
    const reportPath = overview?.snapshot?.reportPath
    if (!reportPath) return
    await window.desktop?.openPath?.(reportPath).catch(() => undefined)
  }

  if (hidden) return null

  const isToday = overview ? overview.isToday : selectedDate === todayLogicalDate
  const isAnalyzing = overview?.runState === 'analyzing'
  const needsConsent = Boolean(overview && !overview.config.providerConsentAcknowledged)
  const brokerAvailable = overview?.brokerAvailable ?? true

  const selectedModelPickKey = useMemo(() => {
    const pick = overview?.config?.modelPick
    if (!pick) return ''
    const key = modelPickKey(pick)
    return cloudModelRows.some((r) => r.pickKey === key) ? key : ''
  }, [overview?.config?.modelPick, cloudModelRows])

  const defaultModelDisplay = useMemo(() => {
    const settings = claudeSettings?.settings
    if (settings) {
      const activeProv =
        settings.providers.find((p) => p.id === settings.activeProviderId) ?? settings.providers[0]
      if (activeProv) {
        const modelId = settings.activeAnthropicModel?.trim() || activeProv.model?.trim() || ''
        return modelId ? `${activeProv.name} · ${modelId}` : activeProv.name
      }
    }
    if (overview?.providerName) {
      return overview.modelName
        ? `${overview.providerName} · ${overview.modelName}`
        : overview.providerName
    }
    return t('intentTodo.modelFallback')
  }, [claudeSettings, overview?.modelName, overview?.providerName, t])

  const renderStateBadge = () => {
    if (!overview) return null
    const state = overview.runState
    const labelKey =
      state === 'analyzing'
        ? 'intentTodo.stateAnalyzing'
        : state === 'failed'
          ? 'intentTodo.stateFailed'
          : state === 'needs_config'
            ? 'intentTodo.stateNeedsConfig'
            : state === 'offline'
              ? 'intentTodo.stateOffline'
              : state === 'ready'
                ? 'intentTodo.stateReady'
                : 'intentTodo.stateIdle'

    return (
      <span className={`intent-todo-state-pill is-${state}`}>
        <span className="intent-todo-state-dot" aria-hidden="true" />
        <span>{t(labelKey)}</span>
      </span>
    )
  }

  const renderItemRow = (item: IntentTodoItem, section: 'pending' | 'active' | 'resolved') => {
    const expanded = expandedIds.has(item.id)
    const busy = busyItemIds.has(item.id)
    const targetProjectName = item.confirmedProjectName || item.suggestedProjectName
    const compactProjectName = formatCompactProjectName(targetProjectName)
    const trackLabel =
      item.track === 'engineering'
        ? compactProjectName || t('intentTodo.trackEngineering')
        : t('intentTodo.trackLife')
    const firstAnchor = item.anchors[0]
    const phaseKey = runtimePhaseLabelKey(item.dispatchRuntimePhase)
    const confirmingThis = confirmDispatch?.itemId === item.id
    const isReconfirmLater = section === 'active' && item.status === 'later' && item.snoozeCount >= 2
    const dispatchTooltip =
      item.track === 'engineering' && !brokerAvailable
        ? t('intentTodo.brokerUnavailableHint')
        : item.track === 'engineering' && targetProjectName
          ? t('intentTodo.actionDispatchTo', { project: targetProjectName })
          : undefined

    const feedback = selectedFeedback[item.id]
    const isExiting = Boolean(feedback)

    return (
      <article
        key={item.id}
        className={`intent-todo-row${section === 'resolved' ? ' is-resolved' : ''}${isExiting ? ' is-exiting' : ''}`}
        data-urgency={item.urgency}
        data-item-id={item.id}
      >
        <div className="intent-todo-row-main">
          <button
            type="button"
            className="intent-todo-row-body"
            aria-expanded={expanded}
            onClick={() => toggleExpand(item.id)}
          >
            <div className="intent-todo-row-topline">
              <span className="intent-todo-title">{item.title}</span>
              {section === 'resolved' ? (
                <span
                  className={`intent-todo-status-chip${item.status === 'done' ? ' is-done' : ' is-dropped'}`}
                  title={item.suggestedDone?.message || undefined}
                >
                  {item.status === 'done'
                    ? item.suggestedDone
                      ? t('intentTodo.autoClosedHint', { sha: item.suggestedDone.sha })
                      : t('intentTodo.statusDone')
                    : t('intentTodo.statusDropped')}
                </span>
              ) : item.suggestedDone ? (
                <span className="intent-todo-git-hint" title={item.suggestedDone.message}>
                  <span>{t('intentTodo.maybeDoneHint', { sha: item.suggestedDone.sha })}</span>
                </span>
              ) : null}
              {item.dispatch && phaseKey ? (
                <span className={`intent-todo-phase-pill ${runtimePhaseClass(item.dispatchRuntimePhase)}`}>
                  {t(phaseKey)}
                </span>
              ) : null}
            </div>

            <div className="intent-todo-meta-line">
              <span
                className={`intent-todo-track-pill${item.track === 'life' ? ' is-life' : ''}`}
                title={targetProjectName || undefined}
              >
                {trackLabel}
              </span>
              {firstAnchor ? (
                <span className="intent-todo-time-tag">
                  {firstAnchor.date === selectedDate ? firstAnchor.time : `${firstAnchor.date.slice(5)} ${firstAnchor.time}`}
                </span>
              ) : null}
              {section === 'active' && item.status === 'later' ? (
                <span className="intent-todo-time-tag">· {t('intentTodo.dueFollowUpBadge')}</span>
              ) : null}
              {item.reason ? (
                <span className="intent-todo-reason-text" title={item.reason}>
                  {item.reason}
                </span>
              ) : null}
            </div>
          </button>

          <div className="intent-todo-actions">
            {section === 'pending' ? (
              <>
                <button
                  type="button"
                  disabled={busy || (item.track === 'engineering' && !brokerAvailable)}
                  title={dispatchTooltip}
                  className={`intent-todo-btn is-primary-col${feedback === 'now' ? ' is-selected-now' : ''}`}
                  onClick={() => handleImmediateClick(item)}
                >
                  {item.track === 'engineering'
                    ? t('intentTodo.actionDispatchShort')
                    : t('intentTodo.actionTodayPriorityShort')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={`intent-todo-btn is-secondary-col${feedback === 'later' ? ' is-selected-later' : ''}`}
                  onClick={() => void handleDecide(item.id, { action: 'later' })}
                >
                  {t('intentTodo.actionFollowUpShort')}
                </button>
                <span className="intent-todo-actions-sep" aria-hidden="true" />
                <button
                  type="button"
                  disabled={busy}
                  className={`intent-todo-btn is-icon-only is-ghost is-done${feedback === 'done' ? ' is-selected-done' : ''}`}
                  title={t('intentTodo.actionDone')}
                  aria-label={t('intentTodo.actionDone')}
                  onClick={() => void handleDecide(item.id, { action: 'done' })}
                >
                  <IconInline name="check" />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={`intent-todo-btn is-icon-only is-ghost is-drop${feedback === 'dropped' ? ' is-selected-dropped' : ''}`}
                  title={t('intentTodo.actionDrop')}
                  aria-label={t('intentTodo.actionDrop')}
                  onClick={() => void handleDecide(item.id, { action: 'dropped' })}
                >
                  <IconInline name="x" />
                </button>
              </>
            ) : section === 'active' ? (
              isReconfirmLater ? (
                <>
                  <span className="intent-todo-reconfirm-label">{t('intentTodo.reconfirmAsk')}</span>
                  <button
                    type="button"
                    disabled={busy}
                    className={`intent-todo-btn${feedback === 'now' ? ' is-selected-now' : ''}`}
                    onClick={() => handleImmediateClick(item)}
                  >
                    {t('intentTodo.reconfirmKeep')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`intent-todo-btn is-drop${feedback === 'dropped' ? ' is-selected-dropped' : ''}`}
                    onClick={() => void handleDecide(item.id, { action: 'dropped' })}
                  >
                    {t('intentTodo.reconfirmDrop')}
                  </button>
                </>
              ) : (
                <>
                  {item.dispatch ? (
                    <button
                      type="button"
                      className="intent-todo-btn"
                      onClick={() => onOpenDispatchedThread?.(item.dispatch!.projectId, item.dispatch!.threadId)}
                    >
                      {t('intentTodo.openDispatchedThread')}
                    </button>
                  ) : item.status === 'later' ? (
                    <>
                      <button
                        type="button"
                        disabled={busy || (item.track === 'engineering' && !brokerAvailable)}
                        title={dispatchTooltip}
                        className={`intent-todo-btn is-primary-col${feedback === 'now' ? ' is-selected-now' : ''}`}
                        onClick={() => handleImmediateClick(item)}
                      >
                        {item.track === 'engineering'
                          ? t('intentTodo.actionDispatchShort')
                          : t('intentTodo.actionTodayPriorityShort')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={`intent-todo-btn is-secondary-col${feedback === 'later' ? ' is-selected-later' : ''}`}
                        onClick={() => void handleDecide(item.id, { action: 'later' })}
                      >
                        {t('intentTodo.snoozeAgain')}
                      </button>
                    </>
                  ) : null}
                  <span className="intent-todo-actions-sep" aria-hidden="true" />
                  <button
                    type="button"
                    disabled={busy}
                    className={`intent-todo-btn is-icon-only is-ghost is-done${feedback === 'done' ? ' is-selected-done' : ''}`}
                    title={t('intentTodo.actionDone')}
                    aria-label={t('intentTodo.actionDone')}
                    onClick={() => void handleDecide(item.id, { action: 'done' })}
                  >
                    <IconInline name="check" />
                  </button>
                </>
              )
            ) : (
              <button
                type="button"
                disabled={busy}
                className="intent-todo-btn is-ghost"
                onClick={() => void handleDecide(item.id, { action: 'restore' })}
              >
                <IconInline name="undo" />
                <span>{t('intentTodo.actionRestore')}</span>
              </button>
            )}
          </div>
        </div>

        {confirmingThis && confirmDispatch ? (
          <div className="intent-todo-dispatch-panel">
            <div className="intent-todo-dispatch-panel-row">
              <div className="intent-todo-confirm-controls">
                <span className="intent-todo-dispatch-label">{t('intentTodo.targetProjectLabel')}</span>
                <select
                  className="intent-todo-select"
                  value={confirmDispatch.projectId}
                  onChange={(e) => {
                    const nextProjectId = e.target.value
                    setConfirmDispatch((prev) =>
                      prev && prev.itemId === item.id ? { ...prev, projectId: nextProjectId } : prev,
                    )
                  }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="intent-todo-confirm-controls">
                <button
                  type="button"
                  className={`intent-todo-btn intent-todo-btn-magic${confirmDispatch.polished ? ' is-polished' : ''}`}
                  disabled={confirmDispatch.polishing || busy}
                  onClick={() => void handlePolishDispatchPrompt(item)}
                >
                  <span>
                    {confirmDispatch.polishing
                      ? t('intentTodo.polishingPrompt')
                      : confirmDispatch.polished
                        ? t('intentTodo.repolishPromptBtn')
                        : t('intentTodo.polishPromptBtn')}
                  </span>
                </button>
                <button
                  type="button"
                  className="intent-todo-btn"
                  onClick={() => setConfirmDispatch(null)}
                >
                  {t('journal.cancel')}
                </button>
              </div>
            </div>

            <textarea
              className="intent-todo-dispatch-textarea"
              rows={6}
              value={confirmDispatch.prompt}
              onChange={(e) => {
                const nextPrompt = e.target.value
                setConfirmDispatch((prev) =>
                  prev && prev.itemId === item.id ? { ...prev, prompt: nextPrompt } : prev,
                )
              }}
            />

            {confirmDispatch.error ? (
              <div className="intent-todo-dispatch-error">{confirmDispatch.error}</div>
            ) : null}

            <div className="intent-todo-dispatch-panel-foot">
              <button
                type="button"
                className="intent-todo-btn"
                disabled={!confirmDispatch.prompt.trim()}
                onClick={() => void handleCopyDispatchPrompt()}
              >
                {confirmDispatch.copied ? t('intentTodo.copiedPromptBtn') : t('intentTodo.copyPromptBtn')}
              </button>
              <button
                type="button"
                className="intent-todo-btn is-primary-solid"
                disabled={!confirmDispatch.projectId || !confirmDispatch.prompt.trim() || busy || confirmDispatch.polishing}
                onClick={() =>
                  void executeDispatch(item, confirmDispatch.projectId, false, confirmDispatch.prompt)
                }
              >
                {t('intentTodo.confirmDispatchBtn')}
              </button>
            </div>
          </div>
        ) : null}

        {expanded ? (
          <div className="intent-todo-drawer">
            {item.suggestedDone?.message ? (
              <div className="intent-todo-closure-note">
                <IconInline name="check" />
                <span>
                  {item.suggestedDone.sha} · {item.suggestedDone.message}
                </span>
              </div>
            ) : null}

            {item.anchors.map((anchor) => (
              <div key={`${anchor.entryId}:${anchor.contentHash}`}>
                <div className="intent-todo-anchor-flags">
                  <span className="intent-todo-anchor-flags-label">
                    {t('intentTodo.anchorFlagsLabel')}
                  </span>
                  <span className="intent-todo-anchor-flags-value">
                    {(anchor.flags || []).join(' / ') || '—'}
                  </span>
                </div>
                <div className="intent-todo-drawer-meta" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="intent-todo-anchor-link"
                    onClick={() => onNavigateToJournalAnchor?.(anchor.date, anchor.entryId)}
                  >
                    ↗ {anchor.date} {anchor.time} · {t('intentTodo.jumpJournalAnchor')}
                  </button>
                </div>
              </div>
            ))}

            {item.antiPatterns.length > 0 ? (
              <div className="intent-todo-antipatterns">
                {item.antiPatterns.map((ap, idx) => (
                  <span key={idx} className="intent-todo-antipattern-tag">
                    {t('intentTodo.antiPatternPrefix')}: {ap}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="intent-todo-drawer-meta">
              {item.track === 'engineering' ? (
                <label className="intent-todo-confirm-controls">
                  <span>{t('intentTodo.targetProjectLabel')}</span>
                  <select
                    className="intent-todo-select"
                    value={item.confirmedProjectId || item.suggestedProjectId || ''}
                    onChange={(e) => {
                      const picked = projects.find((p) => p.id === e.target.value)
                      if (picked) {
                        void handleDecide(item.id, {
                          action: 'set_project',
                          projectId: picked.id,
                          projectName: picked.name,
                        })
                      }
                    }}
                  >
                    <option value="">{t('intentTodo.selectProjectPlaceholder')}</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {item.track === 'life' && !item.dispatch ? (
                <button
                  type="button"
                  disabled={busy || !brokerAvailable}
                  className="intent-todo-btn"
                  onClick={() => void executeDispatch(item, undefined, true)}
                >
                  <IconInline name="message" />
                  <span>{t('intentTodo.openLifeSandboxChat')}</span>
                </button>
              ) : null}

              {item.dispatch ? (
                <button
                  type="button"
                  className="intent-todo-anchor-link"
                  onClick={() => onOpenDispatchedThread?.(item.dispatch!.projectId, item.dispatch!.threadId)}
                >
                  {t('intentTodo.openDispatchedThread')} →
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </article>
    )
  }

  return (
    <DeskDatePageShell
      pageClassName="intent-todo-page"
      hidden={false}
      ariaLabel={t('intentTodo.pageTitle')}
      selectedDate={selectedDate}
      todayDate={todayLogicalDate}
      disableFuture
      calendarMarkers={calendarMarkers}
      getDayState={(dateStr) => {
        const info = calendarDayMap.get(dateStr)
        if (!info) return {}
        return {
          hasPending: info.pendingCount > 0,
          allCleared: info.allCleared,
          hasActivity: info.hasRun,
        }
      }}
      onSelectDate={setSelectedDate}
      onOpenCalendar={() => {
        void window.desktop?.listIntentTodoCalendar?.().then((cal) => {
          if (Array.isArray(cal)) setCalendarDays(cal)
        })
      }}
      topbarRightSlot={
        <button
          type="button"
          className={`intent-todo-topbar-refresh${isAnalyzing ? ' is-spinning' : ''}`}
          disabled={isAnalyzing || needsConsent}
          onClick={() => void handleRefresh()}
        >
          <IconInline name="refresh" />
          <span>{isAnalyzing ? t('intentTodo.refreshing') : t('intentTodo.refreshNow')}</span>
        </button>
      }
      heroMeta={
        overview?.snapshot
          ? t('intentTodo.heroCoverage', {
              n: overview.snapshot.stats.newHumanEntries,
              priv: overview.snapshot.stats.skippedPrivate,
            })
          : undefined
      }
      heroSubline={
        overview && overview.todayTotalCount > 0 ? (
          <div className="intent-todo-hero-left">
            <span>
              {t('intentTodo.dayProgress', {
                decided: overview.todayDecidedCount,
                total: overview.todayTotalCount,
              })}
            </span>
          </div>
        ) : null
      }
      heroRightRef={settingsAnchorRef}
      heroRight={
        <div className="intent-todo-hero-right">
          {renderStateBadge()}
          <button
            type="button"
            className="intent-todo-icon-btn"
            title={t('intentTodo.settingsTitle')}
            aria-label={t('intentTodo.settingsTitle')}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <IconInline name="settings" />
          </button>

          {settingsOpen && overview ? (
            <div className="intent-todo-settings-popover" role="dialog">
              <label className="intent-todo-settings-row">
                <span>{t('intentTodo.autoAnalyzeLabel')}</span>
                <input
                  type="checkbox"
                  checked={overview.config.enabled}
                  onChange={() => void handleToggleAutoEnabled()}
                />
              </label>
              <p className="intent-todo-settings-hint">{t('intentTodo.scheduleTip')}</p>

              <div className="intent-todo-settings-divider" />

              <label className="intent-todo-settings-field">
                <span>{t('intentTodo.modelPickerLabel')}</span>
                <select
                  className="intent-todo-select"
                  disabled={isAnalyzing}
                  value={selectedModelPickKey}
                  onChange={(e) => void handleSelectCloudModel(e.target.value)}
                >
                  <option value="">
                    {t('intentTodo.modelFollowGlobal', { model: defaultModelDisplay })}
                  </option>
                  {cloudModelRows.map((row) => {
                    const provName = providerNameById.get(row.providerId) || row.providerId
                    return (
                      <option key={row.pickKey} value={row.pickKey}>
                        {provName} · {row.anthropicModelId}
                      </option>
                    )
                  })}
                </select>
              </label>
              <p className="intent-todo-settings-hint">{t('intentTodo.modelPickerHint')}</p>

              <div className="intent-todo-settings-actions">
                <button
                  type="button"
                  className="intent-todo-btn is-primary-solid"
                  disabled={isAnalyzing || needsConsent}
                  onClick={() => {
                    setSettingsOpen(false)
                    void handleRefresh()
                  }}
                >
                  {isAnalyzing ? t('intentTodo.refreshing') : t('intentTodo.runNowBtn')}
                </button>
                {onOpenModelSettings ? (
                  <button
                    type="button"
                    className="intent-todo-btn"
                    onClick={() => {
                      setSettingsOpen(false)
                      onOpenModelSettings()
                    }}
                  >
                    {t('intentTodo.manageCloudModels')}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      }
      overlays={
        toast ? (
          <div className="intent-todo-toast" role="status">
            <span>{toast.message}</span>
            {toast.projectId && toast.threadId ? (
              <button
                type="button"
                className="intent-todo-toast-action"
                onClick={() => {
                  onOpenDispatchedThread?.(toast.projectId!, toast.threadId!)
                  setToast(null)
                }}
              >
                {t('intentTodo.openDispatchedThread')}
              </button>
            ) : null}
          </div>
        ) : null
      }
    >
      {needsConsent && overview ? (
        <div className="intent-todo-banner">
          <div className="intent-todo-banner-copy">
            <p className="intent-todo-banner-title">{t('intentTodo.consentTitle')}</p>
            <p className="intent-todo-banner-desc">
              {t('intentTodo.consentDesc', { provider: overview.providerName })}
            </p>
          </div>
          <button
            type="button"
            className="intent-todo-btn is-primary-solid"
            onClick={() => void handleConsentAccept()}
          >
            {t('intentTodo.consentAccept')}
          </button>
        </div>
      ) : null}

      {overview?.runState === 'failed' || overview?.runState === 'needs_config' ? (
        <div className="intent-todo-banner is-error">
          <div className="intent-todo-banner-copy">
            <p className="intent-todo-banner-title">
              {overview.runState === 'needs_config'
                ? t('intentTodo.stateNeedsConfig')
                : t('intentTodo.stateFailed')}
            </p>
            {overview.runError ? (
              <p className="intent-todo-banner-desc">{overview.runError}</p>
            ) : null}
          </div>
          {overview.runState === 'needs_config' && onOpenModelSettings ? (
            <button
              type="button"
              className="intent-todo-btn"
              onClick={onOpenModelSettings}
            >
              {t('intentTodo.goConfigureModel')}
            </button>
          ) : (
            <button
              type="button"
              className="intent-todo-btn"
              onClick={() => void handleRefresh()}
            >
              {t('intentTodo.retryBtn')}
            </button>
          )}
        </div>
      ) : null}

      {!isToday ? (
        <div className="intent-todo-banner is-readonly">
          <span>{t('intentTodo.historyViewingNotice', { date: selectedDate })}</span>
          <button
            type="button"
            className="intent-todo-footer-link"
            onClick={() => setSelectedDate(todayLogicalDate)}
          >
            {t('journal.jumpToday')}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="intent-todo-empty">
          <p className="intent-todo-empty-title">{t('journal.loadingDay')}</p>
        </div>
      ) : !overview ? null : (
        <>
          <div className="intent-todo-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'pending'}
              className={`intent-todo-tab${activeTab === 'pending' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('pending')}
            >
              <span>{t(isToday ? 'intentTodo.tabPendingToday' : 'intentTodo.tabPendingDay')}</span>
              <span className="intent-todo-tab-count">{overview.pendingItems.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'active'}
              className={`intent-todo-tab${activeTab === 'active' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('active')}
            >
              <span>{t('intentTodo.tabActive')}</span>
              <span className="intent-todo-tab-count">{overview.activeItems.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'resolved'}
              className={`intent-todo-tab${activeTab === 'resolved' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('resolved')}
            >
              <span>{t('intentTodo.tabResolved')}</span>
              <span className="intent-todo-tab-count">{overview.resolvedItems.length}</span>
            </button>
          </div>

          {activeTab === 'pending' ? (
            <section className="intent-todo-section">
              {overview.pendingItems.length === 0 ? (
                <div className="intent-todo-empty">
                  <p className="intent-todo-empty-title">
                    {isAnalyzing
                      ? t('intentTodo.emptyAnalyzingTitle')
                      : overview.snapshot
                        ? t('intentTodo.emptyClearedTitle')
                        : t('intentTodo.emptyNoRunTitle')}
                  </p>
                  <p className="intent-todo-empty-sub">
                    {isAnalyzing
                      ? t('intentTodo.emptyAnalyzingSub')
                      : overview.snapshot
                        ? t('intentTodo.emptyClearedSub')
                        : t('intentTodo.emptyNoRunSub')}
                  </p>
                </div>
              ) : (
                <div className="intent-todo-list">
                  {overview.pendingItems.map((item) => renderItemRow(item, 'pending'))}
                </div>
              )}
            </section>
          ) : activeTab === 'active' ? (
            <section className="intent-todo-section">
              {overview.snoozedLaterCount > 0 ? (
                <div className="intent-todo-section-head">
                  <span className="intent-todo-reason-line">
                    {t('intentTodo.snoozedCountHint', { n: overview.snoozedLaterCount })}
                  </span>
                </div>
              ) : null}
              {overview.activeItems.length === 0 ? (
                <div className="intent-todo-empty">
                  <p className="intent-todo-empty-title">{t('intentTodo.emptyActiveTitle')}</p>
                  <p className="intent-todo-empty-sub">{t('intentTodo.emptyActiveSub')}</p>
                </div>
              ) : (
                <div className="intent-todo-list">
                  {overview.activeItems.map((item) => renderItemRow(item, 'active'))}
                </div>
              )}
            </section>
          ) : (
            <section className="intent-todo-section">
              {overview.resolvedItems.length === 0 ? (
                <div className="intent-todo-empty">
                  <p className="intent-todo-empty-title">{t('intentTodo.emptyResolvedTitle')}</p>
                  <p className="intent-todo-empty-sub">{t('intentTodo.emptyResolvedSub')}</p>
                </div>
              ) : (
                <div className="intent-todo-list">
                  {overview.resolvedItems.map((item) => renderItemRow(item, 'resolved'))}
                </div>
              )}
            </section>
          )}

          <footer className="intent-todo-footer">
            <span>
              {overview.snapshot
                ? t('intentTodo.footerSummary', {
                    noise: overview.snapshot.stats.ignoredNoiseCount,
                    priv: overview.snapshot.stats.skippedPrivate,
                    archived: overview.autoArchivedCount,
                  })
                : t('intentTodo.footerNoReport')}
            </span>
            {overview.snapshot?.reportPath ? (
              <button
                type="button"
                className="intent-todo-footer-link"
                onClick={() => void handleOpenReport()}
              >
                {t('intentTodo.openMarkdownReport')}
              </button>
            ) : null}
          </footer>
        </>
      )}
    </DeskDatePageShell>
  )
}
