/**
 * 时间日记主视图（「纸 · 墨 · 黛」散页流 + 周视图 + 图片灯箱 + 底部快记栏 + 飞书/旧库同步）。
 * Editorial Timeline Journal view with "Paper · Ink · Dai" aesthetics, 12-col bento day view,
 * 7-col week overview, image lightbox, sticky composer, legacy SQLite sync, and live fs watch.
 */

import '../../styles/journal-page.css'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  DEFAULT_SENTINEL_DESK_ROOT,
  type CreateJournalEntryInput,
  type FeishuBridgeConfigUpdate,
  type FeishuBridgeStatus,
  type JournalConfig,
  type JournalDaySummary,
  type JournalDiscussTarget,
  type JournalEntry,
  type JournalWeekDay,
  type UpdateJournalEntryInput,
} from '../../journal-contract'
import type { WorkspaceProject } from '../types'
import type { JournalAutoTagEngine, JournalAutoTagStatus } from '../../journal-auto-tag-contract'
import { DeskDatePageShell } from '../desk/DeskDatePageShell'
import { JournalCard } from './JournalCard'
import { JournalComposer } from './JournalComposer'
import { JournalFeishuModal } from './JournalFeishuModal'
import { JournalLightbox, type LightboxImageItem } from './JournalLightbox'
import { JournalWeekView } from './JournalWeekView'
import { useShanghaiToday } from '../desk/useShanghaiToday'
import {
  formatJournalHeroDate,
  getJournalDesktopApi,
  getWeekDates,
  isFutureJournalDate,
  planJournalDayLayout,
  shouldShowLegacySyncButton,
} from './journal-ui-helpers'

function parseJournalAnchorHash(): { date?: string; entryId?: string } {
  if (typeof window === 'undefined') return {}
  const parts = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] !== 'journal') return {}
  const date = parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? parts[1] : undefined
  const entryId = parts[2] ? decodeURIComponent(parts[2]) : undefined
  return { date, entryId }
}

type ViewMode = 'day' | 'week'

type LightboxState = {
  images: LightboxImageItem[]
  activeIndex: number
}

type SyncBannerState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; imported: number; totalScanned: number; latestDate: string | null }
  | { kind: 'error'; message: string }

export type JournalPageProps = {
  hidden?: boolean
  projects: WorkspaceProject[]
  onTodayCountChange?: (count: number) => void
  onDiscussInChat?: (entry: JournalEntry, target: JournalDiscussTarget) => void | Promise<void>
}

export function JournalPage({
  hidden = false,
  projects,
  onTodayCountChange,
  onDiscussInChat,
}: JournalPageProps) {
  const { t } = useI18n()
  const todayDate = useShanghaiToday()
  const initialAnchor = useMemo(() => parseJournalAnchorHash(), [])
  const [selectedDate, setSelectedDate] = useState<string>(initialAnchor.date ?? todayDate)
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(initialAnchor.entryId ?? null)
  const [viewMode, setViewMode] = useState<ViewMode>('day')
  const [dayEntries, setDayEntries] = useState<JournalEntry[]>([])
  const [weekDays, setWeekDays] = useState<JournalWeekDay[]>([])
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<JournalConfig | null>(null)
  const [syncState, setSyncState] = useState<SyncBannerState>({ kind: 'idle' })
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null)
  const [imageCache, setImageCache] = useState<Record<string, string>>({})
  const [lightbox, setLightbox] = useState<LightboxState | null>(null)
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
  const [pageDragOver, setPageDragOver] = useState(false)
  const [saveNotice, setSaveNotice] = useState<'ready' | 'saved'>('ready')
  const [feishuStatus, setFeishuStatus] = useState<FeishuBridgeStatus | null>(null)
  const [feishuModalOpen, setFeishuModalOpen] = useState(false)
  const [autoTagStatus, setAutoTagStatus] = useState<JournalAutoTagStatus | null>(null)
  const [autoTagOpen, setAutoTagOpen] = useState(false)
  const [autoTagRunning, setAutoTagRunning] = useState(false)
  const [autoTagLocalUrlDraft, setAutoTagLocalUrlDraft] = useState('')
  const [autoTagLocalModelDraft, setAutoTagLocalModelDraft] = useState('')
  const autoTagAnchorRef = useRef<HTMLDivElement | null>(null)
  const [allDaySummaries, setAllDaySummaries] = useState<JournalDaySummary[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const calendarRequestSeq = useRef(0)

  const pendingImagesRef = useRef<Set<string>>(new Set())
  const imageCacheRef = useRef<Record<string, string>>({})
  imageCacheRef.current = imageCache
  const selectedDateRef = useRef(selectedDate)
  selectedDateRef.current = selectedDate
  const saveTimerRef = useRef<number | null>(null)

  const loadImageAttachment = useCallback(async (relativePath: string) => {
    if (!relativePath) return
    if (imageCacheRef.current[relativePath] || pendingImagesRef.current.has(relativePath)) {
      return
    }
    const api = getJournalDesktopApi()
    if (!api?.readJournalAttachment) return
    pendingImagesRef.current.add(relativePath)
    try {
      const result = await api.readJournalAttachment(relativePath)
      if (result.ok) {
        setImageCache((prev) =>
          prev[relativePath] === result.dataUrl
            ? prev
            : { ...prev, [relativePath]: result.dataUrl },
        )
      }
    } catch {
      /* ignore unreadable attachment */
    } finally {
      pendingImagesRef.current.delete(relativePath)
    }
  }, [])

  const hydrateImagesForEntries = useCallback(
    (entries: JournalEntry[]) => {
      for (const entry of entries) {
        for (const img of entry.images) {
          void loadImageAttachment(img.relativePath)
        }
      }
    },
    [loadImageAttachment],
  )

  const refreshJournalData = useCallback(
    async (targetDate: string) => {
      const api = getJournalDesktopApi()
      if (!api?.getJournalDay || !api?.getJournalWeek) {
        setLoading(false)
        return
      }
      try {
        const [dayRes, weekRes, todayRes] = await Promise.all([
          api.getJournalDay(targetDate),
          api.getJournalWeek(targetDate),
          targetDate === todayDate ? Promise.resolve(null) : api.getJournalDay(todayDate),
        ])

        if (selectedDateRef.current !== targetDate) return

        if (dayRes.ok) {
          setDayEntries(dayRes.entries)
          hydrateImagesForEntries(dayRes.entries)
          if (targetDate === todayDate) {
            onTodayCountChange?.(dayRes.entries.length)
          }
        } else {
          setDayEntries([])
        }

        if (weekRes.ok) {
          setWeekDays(weekRes.days)
          for (const day of weekRes.days) {
            hydrateImagesForEntries(day.entries)
          }
        } else {
          setWeekDays([])
        }

        if (todayRes?.ok) {
          onTodayCountChange?.(todayRes.entries.length)
        }
      } catch {
        /* ignore transient IPC failure */
      } finally {
        setLoading(false)
      }
    },
    [hydrateImagesForEntries, onTodayCountChange, todayDate],
  )

  useEffect(() => {
    const api = getJournalDesktopApi()
    if (!api) return
    void api.getJournalConfig?.().then((cfg) => {
      if (cfg) setConfig(cfg)
    })
    void api.getFeishuJournalBridgeStatus?.().then((status) => {
      if (status) setFeishuStatus(status)
    }).catch(() => undefined)
    void api.watchJournal?.().catch(() => undefined)
    const unsubscribe = api.onJournalChanged?.((event) => {
      const activeWeek = getWeekDates(selectedDateRef.current)
      const touchesActive =
        event.dates.length === 0 ||
        event.dates.includes(selectedDateRef.current) ||
        event.dates.includes(todayDate) ||
        event.dates.some((date) => activeWeek.includes(date))
      if (touchesActive) {
        void refreshJournalData(selectedDateRef.current)
      }
    })
    const unsubscribeFeishu = api.onFeishuJournalBridgeStatus?.((status) => {
      setFeishuStatus(status)
    })
    return () => {
      unsubscribe?.()
      unsubscribeFeishu?.()
      void api.unwatchJournal?.().catch(() => undefined)
    }
  }, [refreshJournalData, todayDate])

  useEffect(() => {
    setActiveTagFilter(null)
    void refreshJournalData(selectedDate)
  }, [refreshJournalData, selectedDate])

  useEffect(() => {
    const syncFromHash = () => {
      const anchor = parseJournalAnchorHash()
      if (anchor.date) {
        setSelectedDate(anchor.date)
        setViewMode('day')
      }
      if (anchor.entryId) {
        setHighlightedEntryId(anchor.entryId)
      }
    }
    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
  }, [])

  useEffect(() => {
    if (!highlightedEntryId || loading || viewMode !== 'day') return
    const target = dayEntries.find((e) => e.id === highlightedEntryId)
    if (!target) return
    const frame = window.requestAnimationFrame(() => {
      const el = document.querySelector(`[data-entry-id="${CSS.escape(highlightedEntryId)}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    const clearTimer = window.setTimeout(() => {
      setHighlightedEntryId((cur) => (cur === highlightedEntryId ? null : cur))
    }, 3200)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(clearTimer)
    }
  }, [dayEntries, highlightedEntryId, loading, viewMode])

  const handleOpenCalendar = useCallback(() => {
    const api = getJournalDesktopApi()
    if (!api?.listJournalDays) return
    const seq = ++calendarRequestSeq.current
    setCalendarLoading(true)
    void api
      .listJournalDays()
      .then((summaries) => {
        if (seq === calendarRequestSeq.current && Array.isArray(summaries)) {
          setAllDaySummaries(summaries)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (seq === calendarRequestSeq.current) setCalendarLoading(false)
      })
  }, [])

  const handleSelectDate = useCallback((dateStr: string) => {
    setSelectedDate(dateStr)
    setViewMode('day')
  }, [])

  useEffect(() => {
    const api = window.desktop
    if (!api?.getJournalAutoTagStatus) return
    let cancelled = false
    const pullStatus = () => {
      void api
        .getJournalAutoTagStatus?.()
        .then((status) => {
          if (!cancelled && status) setAutoTagStatus(status)
        })
        .catch(() => undefined)
    }
    pullStatus()
    const unsub = api.onJournalAutoTagChanged?.((event) => {
      pullStatus()
      if (event.reason === 'ran' && event.dates.includes(selectedDateRef.current)) {
        void refreshJournalData(selectedDateRef.current)
      }
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [refreshJournalData])

  useEffect(() => {
    if (!autoTagOpen) return
    const onMouseDown = (event: MouseEvent) => {
      if (autoTagAnchorRef.current?.contains(event.target as Node)) return
      setAutoTagOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [autoTagOpen])

  useEffect(() => {
    if (!autoTagStatus?.config) return
    setAutoTagLocalUrlDraft(autoTagStatus.config.localBaseUrl || '')
    setAutoTagLocalModelDraft(autoTagStatus.config.localModel || '')
  }, [autoTagStatus?.config?.localBaseUrl, autoTagStatus?.config?.localModel])

  const handleToggleAutoTagEnabled = async () => {
    const api = window.desktop
    if (!api?.saveJournalAutoTagConfig || !autoTagStatus) return
    const next = await api.saveJournalAutoTagConfig({ enabled: !autoTagStatus.config.enabled })
    setAutoTagStatus((prev) => (prev ? { ...prev, config: next } : prev))
  }

  const handleChangeAutoTagEngine = async (engine: JournalAutoTagEngine) => {
    const api = window.desktop
    if (!api?.saveJournalAutoTagConfig) return
    const next = await api.saveJournalAutoTagConfig({ engine })
    setAutoTagStatus((prev) => (prev ? { ...prev, config: next } : prev))
  }

  const handleSaveAutoTagLocalConfig = async (patch: { localBaseUrl?: string; localModel?: string }) => {
    const api = window.desktop
    if (!api?.saveJournalAutoTagConfig) return
    const next = await api.saveJournalAutoTagConfig(patch)
    setAutoTagStatus((prev) => (prev ? { ...prev, config: next } : prev))
  }

  const handleRunAutoTagNow = async () => {
    const api = window.desktop
    if (!api?.runJournalAutoTag || autoTagRunning) return
    setAutoTagRunning(true)
    try {
      await api.runJournalAutoTag({ date: selectedDate, force: true })
      const fresh = await api.getJournalAutoTagStatus?.().catch(() => null)
      if (fresh) setAutoTagStatus(fresh)
      await refreshJournalData(selectedDate)
    } finally {
      setAutoTagRunning(false)
    }
  }

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  const flashSavedIndicator = useCallback(() => {
    setSaveNotice('saved')
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      setSaveNotice('ready')
      saveTimerRef.current = null
    }, 2400)
  }, [])

  const handleCreateEntry = useCallback(
    async (input: CreateJournalEntryInput): Promise<boolean> => {
      const api = getJournalDesktopApi()
      if (!api?.createJournalEntry) return false
      try {
        const result = await api.createJournalEntry(input)
        if (!result.ok) return false
        flashSavedIndicator()
        await refreshJournalData(selectedDateRef.current)
        return true
      } catch {
        return false
      }
    },
    [flashSavedIndicator, refreshJournalData],
  )

  const handleUpdateEntry = useCallback(
    async (entryId: string, patch: UpdateJournalEntryInput): Promise<boolean> => {
      const api = getJournalDesktopApi()
      if (!api?.updateJournalEntry) return false
      try {
        const result = await api.updateJournalEntry(selectedDateRef.current, entryId, patch)
        if (!result.ok) return false
        flashSavedIndicator()
        await refreshJournalData(selectedDateRef.current)
        return true
      } catch {
        return false
      }
    },
    [flashSavedIndicator, refreshJournalData],
  )

  const handleDeleteEntry = useCallback(
    async (entryId: string): Promise<boolean> => {
      const api = getJournalDesktopApi()
      if (!api?.deleteJournalEntry) return false
      try {
        const result = await api.deleteJournalEntry(selectedDateRef.current, entryId)
        if (!result.ok) return false
        flashSavedIndicator()
        await refreshJournalData(selectedDateRef.current)
        return true
      } catch {
        return false
      }
    },
    [flashSavedIndicator, refreshJournalData],
  )

  const handleSyncLegacy = useCallback(async () => {
    const api = getJournalDesktopApi()
    if (!api?.syncLegacySentinelLabJournal) return
    setSyncState({ kind: 'syncing' })
    try {
      const res = await api.syncLegacySentinelLabJournal()
      if (!res.ok) {
        setSyncState({ kind: 'error', message: res.error })
        return
      }
      setSyncState({
        kind: 'done',
        imported: res.imported,
        totalScanned: res.totalScanned,
        latestDate: res.latestDate,
      })
      await refreshJournalData(selectedDateRef.current)
    } catch (error) {
      setSyncState({
        kind: 'error',
        message: error instanceof Error ? error.message : t('journal.syncFailed'),
      })
    }
  }, [refreshJournalData, t])

  const handleOpenImage = useCallback(
    (entry: JournalEntry, imageIndex: number) => {
      const items: LightboxImageItem[] = entry.images.map((img) => ({
        relativePath: img.relativePath,
        fileName: img.fileName,
        caption: img.caption || entry.body,
        dataUrl: imageCache[img.relativePath],
        metaLabel: `${entry.date} ${entry.time} · ${entry.category}`,
      }))
      setLightbox({ images: items, activeIndex: imageIndex })
    },
    [imageCache],
  )

  useEffect(() => {
    if (!lightbox) return
    setLightbox((prev) => {
      if (!prev) return null
      let changed = false
      const nextImages = prev.images.map((item) => {
        const cached = imageCache[item.relativePath]
        if (cached && cached !== item.dataUrl) {
          changed = true
          return { ...item, dataUrl: cached }
        }
        return item
      })
      return changed ? { ...prev, images: nextImages } : prev
    })
  }, [imageCache, lightbox])

  const weekDayMap = useMemo(() => {
    const map = new Map<string, JournalWeekDay>()
    for (const day of weekDays) {
      map.set(day.date, day)
    }
    return map
  }, [weekDays])

  const suggestedTags = useMemo(() => {
    const set = new Set<string>()
    for (const entry of dayEntries) {
      for (const tag of entry.tags) set.add(tag)
    }
    return [...set].slice(0, 8)
  }, [dayEntries])

  const visibleDayEntries = useMemo(() => {
    if (!activeTagFilter) return dayEntries
    return dayEntries.filter((entry) => entry.tags.includes(activeTagFilter))
  }, [activeTagFilter, dayEntries])

  const dayLayoutItems = useMemo(
    () => planJournalDayLayout(visibleDayEntries),
    [visibleDayEntries],
  )

  const handlePageDrop = (event: DragEvent<HTMLElement>) => {
    const files = event.dataTransfer?.files
    if (!files?.length) return
    const imagesOnly = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (imagesOnly.length === 0) return
    event.preventDefault()
    setPageDragOver(false)
    setDroppedFiles(imagesOnly)
  }

  const calendarMarkers = useMemo(
    () =>
      allDaySummaries
        .filter((summary) => summary && summary.date && summary.count > 0)
        .map((summary) => ({ date: summary.date, hasActivity: true, count: summary.count })),
    [allDaySummaries],
  )

  const getTopbarDayState = useCallback(
    (dateStr: string) => {
      const summary = weekDayMap.get(dateStr)?.summary
      return {
        hasActivity:
          (summary?.count ?? 0) > 0 ||
          (dateStr === selectedDateRef.current && dayEntries.length > 0),
      }
    },
    [weekDayMap, dayEntries],
  )

  if (hidden) {
    return null
  }

  return (
    <DeskDatePageShell
      pageClassName={`journal-page${pageDragOver ? ' is-drag-over' : ''}`}
      hidden={false}
      ariaLabel={t('journal.pageTitle')}
      selectedDate={selectedDate}
      todayDate={todayDate}
      calendarMarkers={calendarMarkers}
      calendarLoading={calendarLoading}
      getDayState={getTopbarDayState}
      onSelectDate={handleSelectDate}
      onOpenCalendar={handleOpenCalendar}
      topbarRightSlot={
        <div className="desk-shell-seg" role="tablist" aria-label={t('journal.viewModeAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'day'}
            className={`desk-shell-seg-btn${viewMode === 'day' ? ' is-active' : ''}`}
            onClick={() => setViewMode('day')}
          >
            {t('journal.modeDay')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'week'}
            className={`desk-shell-seg-btn${viewMode === 'week' ? ' is-active' : ''}`}
            onClick={() => setViewMode('week')}
          >
            {t('journal.modeWeek')}
          </button>
        </div>
      }
      innerClassName="journal-canvas-inner"
      heroMeta={t('journal.entryCount', { n: dayEntries.length })}
      heroLeftExtra={
        activeTagFilter ? (
          <button
            type="button"
            className="journal-filter-pill"
            onClick={() => setActiveTagFilter(null)}
          >
            <span>#{activeTagFilter}</span>
            <IconInline name="x" />
          </button>
        ) : null
      }
      heroRight={
        <>
          {syncState.kind === 'done' ? (
            <div className="journal-sync-feedback">
              <span>
                {syncState.imported > 0
                  ? t('journal.syncedCount', { n: syncState.imported.toLocaleString() })
                  : t('journal.syncUpToDate', { n: syncState.totalScanned.toLocaleString() })}
              </span>
              {syncState.latestDate && syncState.latestDate !== selectedDate ? (
                <button
                  type="button"
                  className="journal-sync-jump"
                  onClick={() => setSelectedDate(syncState.latestDate!)}
                >
                  {t('journal.jumpLatest', { date: formatJournalHeroDate(syncState.latestDate) })}
                </button>
              ) : null}
            </div>
          ) : syncState.kind === 'error' ? (
            <span className="journal-sync-error" title={syncState.message}>
              {t('journal.syncFailed')}
            </span>
          ) : null}

          {!isFutureJournalDate(selectedDate, todayDate) ? (
            <button
              type="button"
              className="journal-sync-btn"
              disabled={syncState.kind === 'syncing' || config?.legacyDbAvailable === false}
              title={
                config?.legacyDbAvailable === false
                  ? t('journal.legacyDbUnavailable')
                  : t('journal.syncLegacyTitle')
              }
              onClick={() => void handleSyncLegacy()}
            >
              <IconInline name="refresh" />
              <span>
                {syncState.kind === 'syncing'
                  ? t('journal.syncingLegacy')
                  : t('journal.syncLegacy')}
              </span>
            </button>
          ) : null}

          {saveNotice === 'saved' ? (
            <span className="journal-status-pill">
              <span className="journal-status-dot" aria-hidden="true" />
              <span>{t('journal.statusSaved')}</span>
            </span>
          ) : null}

          <div className="journal-autotag-anchor" ref={autoTagAnchorRef}>
            <button
              type="button"
              className={`journal-status-pill is-clickable is-autotag-${
                autoTagRunning
                  ? 'running'
                  : !autoTagStatus?.config.enabled
                    ? 'disabled'
                    : autoTagStatus?.lastRun.status === 'local_unreachable' ||
                        autoTagStatus?.lastRun.status === 'failed'
                      ? 'warn'
                      : 'active'
              }`}
              title={t('journal.autoTagPillTitle')}
              aria-expanded={autoTagOpen}
              onClick={() => setAutoTagOpen((open) => !open)}
            >
              <span className="journal-status-dot" aria-hidden="true" />
              <span>
                {autoTagRunning
                  ? t('journal.autoTagPillRunning')
                  : !autoTagStatus?.config.enabled
                    ? t('journal.autoTagPillDisabled')
                    : autoTagStatus.config.engine === 'jev'
                      ? t('journal.autoTagPillJev')
                      : autoTagStatus.config.engine === 'auto'
                        ? t('journal.autoTagPillAuto')
                        : t('journal.autoTagPillLocal')}
              </span>
            </button>

            {autoTagOpen && autoTagStatus ? (
              <div className="journal-autotag-popover" role="dialog">
                <label className="journal-autotag-row">
                  <span>{t('journal.autoTagPopoverTitle')}</span>
                  <input
                    type="checkbox"
                    checked={autoTagStatus.config.enabled}
                    onChange={() => void handleToggleAutoTagEnabled()}
                  />
                </label>

                <label className="journal-autotag-field">
                  <span>{t('journal.autoTagEngineLabel')}</span>
                  <select
                    className="journal-autotag-select"
                    value={autoTagStatus.config.engine || 'local'}
                    onChange={(e) =>
                      void handleChangeAutoTagEngine(e.target.value as JournalAutoTagEngine)
                    }
                  >
                    <option value="local">{t('journal.autoTagEngineLocal')}</option>
                    <option value="jev">{t('journal.autoTagEngineJev')}</option>
                    <option value="auto">{t('journal.autoTagEngineAuto')}</option>
                  </select>
                </label>

                {(autoTagStatus.config.engine || 'local') === 'local' ||
                autoTagStatus.config.engine === 'auto' ? (
                  <>
                    <label className="journal-autotag-field">
                      <span>{t('journal.autoTagLocalBaseUrlLabel')}</span>
                      <input
                        type="text"
                        className="journal-autotag-input"
                        value={autoTagLocalUrlDraft}
                        onChange={(e) => setAutoTagLocalUrlDraft(e.target.value)}
                        onBlur={() =>
                          void handleSaveAutoTagLocalConfig({ localBaseUrl: autoTagLocalUrlDraft })
                        }
                      />
                    </label>
                    <label className="journal-autotag-field">
                      <span>{t('journal.autoTagLocalModelLabel')}</span>
                      <input
                        type="text"
                        className="journal-autotag-input"
                        value={autoTagLocalModelDraft}
                        onChange={(e) => setAutoTagLocalModelDraft(e.target.value)}
                        onBlur={() =>
                          void handleSaveAutoTagLocalConfig({ localModel: autoTagLocalModelDraft })
                        }
                      />
                    </label>
                  </>
                ) : null}

                <p className="journal-autotag-hint">
                  {autoTagStatus.config.engine === 'local'
                    ? t('journal.autoTagLocalOnly')
                    : t('journal.autoTagJevHint')}
                </p>

                <div className="journal-autotag-meta">
                  {(() => {
                    const run = autoTagStatus.lastRunByDate[selectedDate] ?? autoTagStatus.lastRun
                    if (run.status === 'idle') return t('journal.autoTagStatusIdle')
                    if (run.status === 'disabled') return t('journal.autoTagStatusDisabled')
                    if (run.status === 'local_unreachable') return t('journal.autoTagStatusUnreachable')
                    if (run.status === 'failed') {
                      return t('journal.autoTagStatusFailed', { message: run.message || 'error' })
                    }
                    return t('journal.autoTagStatusLastRun', {
                      scanned: run.scanned,
                      decided: run.decided,
                      changed: run.changed,
                    })
                  })()}
                </div>

                {autoTagStatus.lastRun.endpoint ? (
                  <div className="journal-autotag-endpoint">
                    {t('journal.autoTagEndpoint', { endpoint: autoTagStatus.lastRun.endpoint })}
                  </div>
                ) : null}

                <button
                  type="button"
                  className="journal-autotag-run-btn"
                  disabled={autoTagRunning || !autoTagStatus.config.enabled}
                  onClick={() => void handleRunAutoTagNow()}
                >
                  <IconInline name="refresh" />
                  <span>
                    {autoTagRunning ? t('journal.autoTagPillRunning') : t('journal.autoTagRunDayNow')}
                  </span>
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={`journal-status-pill is-clickable is-feishu-${feishuStatus?.state ?? 'disabled'}`}
            title={feishuStatus?.lastError || t('journal.feishuModalTitle')}
            onClick={() => setFeishuModalOpen(true)}
          >
            <span className="journal-status-dot" aria-hidden="true" />
            <span>
              {feishuStatus?.state === 'connected'
                ? t('journal.feishuBridgeConnected')
                : feishuStatus?.state === 'connecting'
                  ? t('journal.feishuBridgeConnecting')
                  : feishuStatus?.state === 'error'
                    ? t('journal.feishuBridgeError')
                    : t('journal.feishuBridgeSetup')}
            </span>
          </button>
        </>
      }
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault()
          setPageDragOver(true)
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPageDragOver(false)
        }
      }}
      onDrop={handlePageDrop}
      footer={
        <JournalComposer
          targetDate={selectedDate}
          projects={projects}
          suggestedTags={suggestedTags}
          externalDroppedFiles={droppedFiles}
          onConsumedExternalDrop={() => setDroppedFiles([])}
          onSubmit={handleCreateEntry}
        />
      }
      overlays={
        <>
          {lightbox ? (
            <JournalLightbox
              images={lightbox.images}
              activeIndex={lightbox.activeIndex}
              onChangeIndex={(nextIndex) =>
                setLightbox((cur) => (cur ? { ...cur, activeIndex: nextIndex } : null))
              }
              onClose={() => setLightbox(null)}
            />
          ) : null}

          {feishuModalOpen ? (
            <JournalFeishuModal
              status={feishuStatus}
              onSave={async (update: FeishuBridgeConfigUpdate) => {
                const api = getJournalDesktopApi()
                if (!api?.saveFeishuJournalBridgeConfig) return
                const next = await api.saveFeishuJournalBridgeConfig(update)
                setFeishuStatus(next)
              }}
              onReconnect={async () => {
                const api = getJournalDesktopApi()
                if (!api?.reconnectFeishuJournalBridge) return
                const next = await api.reconnectFeishuJournalBridge()
                setFeishuStatus(next)
              }}
              onClose={() => setFeishuModalOpen(false)}
            />
          ) : null}
        </>
      }
    >
      {viewMode === 'week' ? (
        <JournalWeekView
          days={weekDays}
          selectedDate={selectedDate}
          todayDate={todayDate}
          imageCache={imageCache}
          onSelectDay={(dateStr) => {
            setSelectedDate(dateStr)
            setViewMode('day')
          }}
        />
      ) : loading ? (
        <div className="journal-empty-state">
          <p className="journal-empty-title">{t('journal.loadingDay')}</p>
        </div>
      ) : visibleDayEntries.length === 0 ? (
        <div className="journal-empty-state">
          <p className="journal-empty-title">
            {activeTagFilter
              ? t('journal.noEntriesForTag', { tag: activeTagFilter })
              : t('journal.emptyDayTitle')}
          </p>
          <p className="journal-empty-subtitle">{t('journal.emptyDayBody')}</p>
          {shouldShowLegacySyncButton(selectedDate, todayDate, config?.legacyDbAvailable) && syncState.kind === 'idle' ? (
            <button
              type="button"
              className="journal-empty-sync-cta"
              onClick={() => void handleSyncLegacy()}
            >
              {t('journal.syncLegacyEmptyCta')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="journal-bento-grid">
          {dayLayoutItems.map((item) => (
            <JournalCard
              key={item.entry.id}
              entry={item.entry}
              index={item.index}
              layout={item}
              projects={projects}
              deskRoot={config?.deskRoot ?? DEFAULT_SENTINEL_DESK_ROOT}
              imageCache={imageCache}
              onOpenImage={handleOpenImage}
              onUpdateEntry={handleUpdateEntry}
              onDeleteEntry={handleDeleteEntry}
              onDiscussInChat={onDiscussInChat}
              highlighted={highlightedEntryId === item.entry.id}
              onFilterByTag={(tag) =>
                setActiveTagFilter((cur) => (cur === tag ? null : tag))
              }
            />
          ))}
        </div>
      )}
    </DeskDatePageShell>
  )
}
