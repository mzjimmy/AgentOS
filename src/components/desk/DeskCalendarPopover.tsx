/**
 * Shared editorial month/year archive calendar popover for all SentinelDesk date-archived views.
 * Consolidated from JournalCalendarPopover: rich day tooltips (count), 12-month day-count
 * badges, and footer month stats activate whenever markers carry counts (e.g. Journal)
 * while staying clean for count-free consumers (Intent Todo / Morning Brief / Outbound).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  getJournalDateParts,
  getMonthCalendarGrid,
  shiftYearMonth,
} from '../journal/journal-ui-helpers'
import {
  summarizeDeskCalendarMonths,
  type DeskCalendarDayMarker,
} from './desk-date-framework-contract'

export type { DeskCalendarDayMarker }

export type DeskCalendarPopoverProps = {
  selectedDate: string
  todayDate: string
  markers: DeskCalendarDayMarker[]
  disableFuture?: boolean
  loading?: boolean
  anchorRef?: React.RefObject<HTMLElement | null>
  onSelectDate: (date: string) => void
  onClose: () => void
}

const ZH_WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'] as const
const EN_WEEKDAY_HEADERS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const
const ZH_MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] as const
const EN_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export function DeskCalendarPopover({
  selectedDate,
  todayDate,
  markers,
  disableFuture = false,
  loading = false,
  anchorRef,
  onSelectDate,
  onClose,
}: DeskCalendarPopoverProps) {
  const { locale, t } = useI18n()
  const initialParts = useMemo(() => getJournalDateParts(selectedDate), [selectedDate])
  const [viewYear, setViewYear] = useState(initialParts.year)
  const [viewMonth, setViewMonth] = useState(initialParts.month)
  const [pickerMode, setPickerMode] = useState<'days' | 'months'>('days')
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    setViewYear(initialParts.year)
    setViewMonth(initialParts.month)
    setPickerMode('days')
  }, [initialParts.year, initialParts.month])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        anchorRef?.current?.focus()
      }
    }
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (popoverRef.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [anchorRef])

  const markerMap = useMemo(() => {
    const map = new Map<string, DeskCalendarDayMarker>()
    for (const item of markers) {
      if (item.date && item.hasActivity) {
        map.set(item.date, item)
      }
    }
    return map
  }, [markers])

  const monthSummaryMap = useMemo(() => summarizeDeskCalendarMonths(markers), [markers])

  const calendarCells = useMemo(
    () => getMonthCalendarGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  )

  const todayParts = useMemo(() => getJournalDateParts(todayDate), [todayDate])
  const countBearing = useMemo(
    () => markers.some((item) => item?.hasActivity && typeof item.count === 'number' && item.count > 0),
    [markers],
  )
  const currentYmKey = `${viewYear}-${String(viewMonth).padStart(2, '0')}`
  const currentMonthSummary = monthSummaryMap.get(currentYmKey)
  const footerMeta = loading
    ? t('journal.calendarLoading')
    : !countBearing
      ? null
      : currentMonthSummary
        ? t('journal.calendarMonthStats', {
            days: currentMonthSummary.daysCount,
            entries: currentMonthSummary.totalCount,
          })
        : t('journal.calendarMonthEmpty')
  const weekdayHeaders = locale === 'en' ? EN_WEEKDAY_HEADERS : ZH_WEEKDAY_HEADERS
  const monthLabels = locale === 'en' ? EN_MONTH_LABELS : ZH_MONTH_LABELS

  const handleShiftMonth = (delta: number) => {
    const next = shiftYearMonth(viewYear, viewMonth, delta)
    setViewYear(next.year)
    setViewMonth(next.month)
  }

  const headerTitle =
    pickerMode === 'months'
      ? locale === 'en'
        ? `${viewYear}`
        : `${viewYear} 年`
      : locale === 'en'
        ? `${EN_MONTH_LABELS[viewMonth - 1]} ${viewYear}`
        : `${viewYear} 年 ${viewMonth} 月`

  return (
    <div
      ref={popoverRef}
      className="desk-calendar-popover"
      role="dialog"
      aria-label={t('journal.calendarOpenAria')}
    >
      <div className="desk-calendar-header">
        <button
          type="button"
          className="desk-calendar-nav-btn"
          aria-label={pickerMode === 'months' ? t('journal.calendarPrevYear') : t('journal.calendarPrevMonth')}
          onClick={() => {
            if (pickerMode === 'months') setViewYear((y) => y - 1)
            else handleShiftMonth(-1)
          }}
        >
          <IconInline name="back" />
        </button>

        <button
          type="button"
          className="desk-calendar-title-btn"
          aria-expanded={pickerMode === 'months'}
          onClick={() => setPickerMode((m) => (m === 'days' ? 'months' : 'days'))}
        >
          <span>{headerTitle}</span>
          <span className="desk-year-month-caret" aria-hidden="true">
            {pickerMode === 'months' ? '▴' : '▾'}
          </span>
        </button>

        <button
          type="button"
          className="desk-calendar-nav-btn"
          aria-label={pickerMode === 'months' ? t('journal.calendarNextYear') : t('journal.calendarNextMonth')}
          onClick={() => {
            if (pickerMode === 'months') setViewYear((y) => y + 1)
            else handleShiftMonth(1)
          }}
        >
          <IconInline name="forward" />
        </button>
      </div>

      {pickerMode === 'months' ? (
        <div className="desk-calendar-months-grid">
          {monthLabels.map((label, idx) => {
            const monthNum = idx + 1
            const ymKey = `${viewYear}-${String(monthNum).padStart(2, '0')}`
            const activity = monthSummaryMap.get(ymKey)
            const isViewing = viewYear === initialParts.year && monthNum === initialParts.month
            const isTodayMonth = viewYear === todayParts.year && monthNum === todayParts.month
            return (
              <button
                key={ymKey}
                type="button"
                className={`desk-calendar-month-cell${isViewing ? ' is-active' : ''}${isTodayMonth ? ' is-today' : ''}${activity ? ' is-has-activity' : ''}`}
                onClick={() => {
                  setViewMonth(monthNum)
                  setPickerMode('days')
                }}
              >
                <span className="desk-calendar-month-label">{label}</span>
                {activity ? (
                  <span className="desk-calendar-month-badge">
                    <span className="desk-calendar-month-dot" aria-hidden="true" />
                    <span>{t('journal.calendarMonthDaysBadge', { days: activity.daysCount })}</span>
                  </span>
                ) : (
                  <span className="desk-calendar-month-empty">—</span>
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <>
          <div className="desk-calendar-weekdays" aria-hidden="true">
            {weekdayHeaders.map((wd) => (
              <span key={wd} className="desk-calendar-weekday">
                {wd}
              </span>
            ))}
          </div>

          <div className="desk-calendar-days-grid">
            {calendarCells.map((cell) => {
              const marker = markerMap.get(cell.date)
              const markerCount = typeof marker?.count === 'number' && marker.count > 0 ? marker.count : 0
              const hasEntries = markerCount > 0
              const isSelected = cell.date === selectedDate
              const isToday = cell.date === todayDate
              const isFuture = disableFuture && cell.date > todayDate
              const dayLabel = hasEntries
                ? t('journal.calendarDayTooltip', { date: cell.date, count: markerCount })
                : cell.date
              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={isFuture}
                  className={`desk-calendar-day-cell${cell.inCurrentMonth ? '' : ' is-outside'}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${isFuture ? ' is-future' : ''}${hasEntries ? ' is-has-entries' : ''}`}
                  aria-current={isSelected ? 'date' : undefined}
                  aria-label={dayLabel}
                  title={dayLabel}
                  onClick={() => {
                    if (isFuture) return
                    onSelectDate(cell.date)
                    onClose()
                    anchorRef?.current?.focus()
                  }}
                >
                  <span>{cell.day}</span>
                  <span className="desk-calendar-day-mark" aria-hidden="true">
                    {marker?.hasActivity ? (
                      <span className={`desk-calendar-day-dot${marker.cleared ? ' is-cleared' : ''}`} />
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="desk-calendar-footer">
        <span className="desk-calendar-footer-meta">{footerMeta}</span>
        <button
          type="button"
          className="desk-calendar-today-btn"
          onClick={() => {
            onSelectDate(todayDate)
            onClose()
            anchorRef?.current?.focus()
          }}
        >
          {t('journal.jumpToday')}
        </button>
      </div>
    </div>
  )
}
