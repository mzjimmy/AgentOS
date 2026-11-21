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
import { JournalCalendarPopover } from './JournalCalendarPopover'
import { JournalCard } from './JournalCard'
import { JournalComposer } from './JournalComposer'
import { JournalFeishuModal } from './JournalFeishuModal'
import { JournalLightbox, type LightboxImageItem } from './JournalLightbox'
import { JournalWeekView } from './JournalWeekView'
import {
  formatCalendarDayNumber,
  formatJournalHeroDate,
  formatJournalYearMonth,
  formatShortWeekday,
  formatWeekdayLabel,
  getJournalDesktopApi,
  getWeekDates,
  planJournalDayLayout,
  shiftDateString,
  toLocalDateString,
} from './journal-ui-helpers'

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
  const { locale, t } = useI18n()
  const todayDate = useMemo(() => toLocalDateString(), [])
  const [selectedDate, setSelectedDate] = useState<string>(todayDate)
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
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [allDaySummaries, setAllDaySummaries] = useState<JournalDaySummary[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const calendarTriggerRef = useRef<HTMLButtonElement | null>(null)

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
    if (!calendarOpen) return
    const api = getJournalDesktopApi()
    if (!api?.listJournalDays) return
    let cancelled = false
    setCalendarLoading(true)
    void api
      .listJournalDays()
      .then((summaries) => {
        if (!cancelled && Array.isArray(summaries)) {
          setAllDaySummaries(summaries)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCalendarLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [calendarOpen])

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

  const weekStripDates = useMemo(() => getWeekDates(selectedDate), [selectedDate])
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

  if (hidden) {
    return null
  }

  return (
    <section
      className={`journal-page${pageDragOver ? ' is-drag-over' : ''}`}
      aria-label={t('journal.pageTitle')}
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
    >
      <header className="journal-topbar">
        <div className="journal-topbar-left no-drag">
          <div className="journal-calendar-anchor">
            <button
              ref={calendarTriggerRef}
              type="button"
              className={`journal-year-month journal-year-month-btn${calendarOpen ? ' is-open' : ''}`}
              aria-label={t('journal.calendarOpenAria')}
              aria-haspopup="dialog"
              aria-expanded={calendarOpen}
              onClick={() => setCalendarOpen((open) => !open)}
            >
              <span>{formatJournalYearMonth(selectedDate)}</span>
              <span className="journal-year-month-caret" aria-hidden="true">
                {calendarOpen ? '▴' : '▾'}
              </span>
            </button>

            {calendarOpen ? (
              <JournalCalendarPopover
                selectedDate={selectedDate}
                todayDate={todayDate}
                daySummaries={allDaySummaries}
                loading={calendarLoading}
                anchorRef={calendarTriggerRef}
                onSelectDate={(dateStr) => {
                  setSelectedDate(dateStr)
                  setViewMode('day')
                }}
                onClose={() => setCalendarOpen(false)}
              />
            ) : null}
          </div>
          {selectedDate !== todayDate ? (
            <button
              type="button"
              className="journal-today-pill"
              onClick={() => setSelectedDate(todayDate)}
            >
              {t('journal.jumpToday')}
            </button>
          ) : null}
        </div>

        <div className="journal-topbar-spacer draggable" aria-hidden="true" />

        <nav className="journal-week-strip no-drag" aria-label={t('journal.weekStripAria')}>
          <button
            type="button"
            className="journal-week-arrow"
            aria-label={t('journal.prevWeek')}
            title={t('journal.prevWeek')}
            onClick={() => setSelectedDate((cur) => shiftDateString(cur, -7))}
          >
            <IconInline name="back" />
          </button>

          <div className="journal-week-days">
            {weekStripDates.map((dateStr) => {
              const isSelected = dateStr === selectedDate
              const isToday = dateStr === todayDate
              const summary = weekDayMap.get(dateStr)?.summary
              const hasEntries = (summary?.count ?? 0) > 0 || (dateStr === selectedDate && dayEntries.length > 0)
              return (
                <button
                  key={dateStr}
                  type="button"
                  className={`journal-week-pill${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}`}
                  aria-current={isSelected ? 'date' : undefined}
                  onClick={() => setSelectedDate(dateStr)}
                >
                  <span className="journal-week-pill-wd">
                    {formatShortWeekday(dateStr, locale)}
                  </span>
                  <span className="journal-week-pill-day">
                    {formatCalendarDayNumber(dateStr)}
                  </span>
                  <span
                    className={`journal-week-pill-dot${hasEntries ? ' is-visible' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className="journal-week-arrow"
            aria-label={t('journal.nextWeek')}
            title={t('journal.nextWeek')}
            onClick={() => setSelectedDate((cur) => shiftDateString(cur, 7))}
          >
            <IconInline name="forward" />
          </button>
        </nav>

        <div className="journal-topbar-spacer draggable" aria-hidden="true" />

        <div className="journal-topbar-right no-drag">
          <div className="journal-mode-toggle" role="tablist" aria-label={t('journal.viewModeAria')}>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'day'}
              className={`journal-mode-btn${viewMode === 'day' ? ' is-active' : ''}`}
              onClick={() => setViewMode('day')}
            >
              {t('journal.modeDay')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'week'}
              className={`journal-mode-btn${viewMode === 'week' ? ' is-active' : ''}`}
              onClick={() => setViewMode('week')}
            >
              {t('journal.modeWeek')}
            </button>
          </div>
        </div>
      </header>

      <div className="journal-scroll-canvas">
        <div className="journal-canvas-inner">
          <div className="journal-hero">
            <div className="journal-hero-left">
              <h1 className="journal-hero-date">{formatJournalHeroDate(selectedDate)}</h1>
              <span className="journal-hero-meta">
                {formatWeekdayLabel(selectedDate, locale)} ·{' '}
                {t('journal.entryCount', { n: dayEntries.length })}
              </span>
              {activeTagFilter ? (
                <button
                  type="button"
                  className="journal-filter-pill"
                  onClick={() => setActiveTagFilter(null)}
                >
                  <span>#{activeTagFilter}</span>
                  <IconInline name="x" />
                </button>
              ) : null}
            </div>

            <div className="journal-hero-right">
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

              {saveNotice === 'saved' ? (
                <span className="journal-status-pill">
                  <span className="journal-status-dot" aria-hidden="true" />
                  <span>{t('journal.statusSaved')}</span>
                </span>
              ) : null}

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
            </div>
          </div>

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
              {config?.legacyDbAvailable && syncState.kind === 'idle' ? (
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
                  onFilterByTag={(tag) =>
                    setActiveTagFilter((cur) => (cur === tag ? null : tag))
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <JournalComposer
        targetDate={selectedDate}
        projects={projects}
        suggestedTags={suggestedTags}
        externalDroppedFiles={droppedFiles}
        onConsumedExternalDrop={() => setDroppedFiles([])}
        onSubmit={handleCreateEntry}
      />

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
    </section>
  )
}
