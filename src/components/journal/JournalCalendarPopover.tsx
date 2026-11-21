/**
 * 时间日记年月/日期选择浮层（支持月历选日 + 全年月份记录总览，标示过往有日记的月份和日期）。
 * Editorial calendar & past-month archive popover for Timeline Journal.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import type { JournalDaySummary } from '../../journal-contract'
import {
  getJournalDateParts,
  getMonthCalendarGrid,
  shiftYearMonth,
  summarizeJournalMonths,
} from './journal-ui-helpers'

export type JournalCalendarPopoverProps = {
  selectedDate: string
  todayDate: string
  daySummaries: JournalDaySummary[]
  loading?: boolean
  anchorRef?: React.RefObject<HTMLElement | null>
  onSelectDate: (date: string) => void
  onClose: () => void
}

const ZH_WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'] as const
const EN_WEEKDAY_HEADERS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const
const ZH_MONTH_LABELS = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
] as const
const EN_MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

export function JournalCalendarPopover({
  selectedDate,
  todayDate,
  daySummaries,
  loading = false,
  anchorRef,
  onSelectDate,
  onClose,
}: JournalCalendarPopoverProps) {
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

  const daySummaryMap = useMemo(() => {
    const map = new Map<string, JournalDaySummary>()
    for (const item of daySummaries) {
      if (item && item.date && item.count > 0) {
        map.set(item.date, item)
      }
    }
    return map
  }, [daySummaries])

  const monthActivityMap = useMemo(
    () => summarizeJournalMonths(daySummaries),
    [daySummaries],
  )

  const calendarCells = useMemo(
    () => getMonthCalendarGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  )

  const currentYmKey = `${viewYear}-${String(viewMonth).padStart(2, '0')}`
  const currentMonthActivity = monthActivityMap.get(currentYmKey)
  const todayParts = useMemo(() => getJournalDateParts(todayDate), [todayDate])
  const weekdayHeaders = locale === 'en' ? EN_WEEKDAY_HEADERS : ZH_WEEKDAY_HEADERS
  const monthLabels = locale === 'en' ? EN_MONTH_LABELS : ZH_MONTH_LABELS

  const handleShiftMonth = (delta: number) => {
    const next = shiftYearMonth(viewYear, viewMonth, delta)
    setViewYear(next.year)
    setViewMonth(next.month)
  }

  const handleJumpToday = () => {
    setViewYear(todayParts.year)
    setViewMonth(todayParts.month)
    setPickerMode('days')
    onSelectDate(todayDate)
    onClose()
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
      className="journal-calendar-popover"
      role="dialog"
      aria-label={t('journal.calendarOpenAria')}
    >
      <div className="journal-calendar-header">
        <button
          type="button"
          className="journal-calendar-nav-btn"
          aria-label={
            pickerMode === 'months' ? t('journal.calendarPrevYear') : t('journal.calendarPrevMonth')
          }
          title={
            pickerMode === 'months' ? t('journal.calendarPrevYear') : t('journal.calendarPrevMonth')
          }
          onClick={() => {
            if (pickerMode === 'months') {
              setViewYear((y) => y - 1)
            } else {
              handleShiftMonth(-1)
            }
          }}
        >
          <IconInline name="back" />
        </button>

        <button
          type="button"
          className="journal-calendar-title-btn"
          aria-expanded={pickerMode === 'months'}
          title={
            pickerMode === 'months'
              ? t('journal.calendarSwitchDays')
              : t('journal.calendarSwitchMonths')
          }
          onClick={() => setPickerMode((m) => (m === 'days' ? 'months' : 'days'))}
        >
          <span>{headerTitle}</span>
          <span className="journal-calendar-caret" aria-hidden="true">
            {pickerMode === 'months' ? '▴' : '▾'}
          </span>
        </button>

        <button
          type="button"
          className="journal-calendar-nav-btn"
          aria-label={
            pickerMode === 'months' ? t('journal.calendarNextYear') : t('journal.calendarNextMonth')
          }
          title={
            pickerMode === 'months' ? t('journal.calendarNextYear') : t('journal.calendarNextMonth')
          }
          onClick={() => {
            if (pickerMode === 'months') {
              setViewYear((y) => y + 1)
            } else {
              handleShiftMonth(1)
            }
          }}
        >
          <IconInline name="forward" />
        </button>
      </div>

      {pickerMode === 'months' ? (
        <div className="journal-calendar-months-grid">
          {monthLabels.map((label, idx) => {
            const monthNum = idx + 1
            const ymKey = `${viewYear}-${String(monthNum).padStart(2, '0')}`
            const activity = monthActivityMap.get(ymKey)
            const isViewing = viewYear === initialParts.year && monthNum === initialParts.month
            const isTodayMonth = viewYear === todayParts.year && monthNum === todayParts.month
            return (
              <button
                key={ymKey}
                type="button"
                className={`journal-calendar-month-cell${isViewing ? ' is-active' : ''}${isTodayMonth ? ' is-today' : ''}${activity ? ' is-has-entries' : ''}`}
                onClick={() => {
                  setViewMonth(monthNum)
                  setPickerMode('days')
                }}
              >
                <span className="journal-calendar-month-label">{label}</span>
                {activity ? (
                  <span className="journal-calendar-month-badge">
                    <span className="journal-calendar-month-dot" aria-hidden="true" />
                    <span>{t('journal.calendarMonthDaysBadge', { days: activity.daysCount })}</span>
                  </span>
                ) : (
                  <span className="journal-calendar-month-empty">—</span>
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <>
          <div className="journal-calendar-weekdays" aria-hidden="true">
            {weekdayHeaders.map((wd) => (
              <span key={wd} className="journal-calendar-weekday">
                {wd}
              </span>
            ))}
          </div>

          <div className="journal-calendar-days-grid">
            {calendarCells.map((cell) => {
              const summary = daySummaryMap.get(cell.date)
              const hasEntries = Boolean(summary && summary.count > 0)
              const isSelected = cell.date === selectedDate
              const isToday = cell.date === todayDate
              return (
                <button
                  key={cell.date}
                  type="button"
                  className={`journal-calendar-day-cell${cell.inCurrentMonth ? '' : ' is-outside'}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${hasEntries ? ' is-has-entries' : ''}`}
                  aria-current={isSelected ? 'date' : undefined}
                  aria-label={
                    summary
                      ? t('journal.calendarDayTooltip', { date: cell.date, count: summary.count })
                      : cell.date
                  }
                  title={
                    summary
                      ? t('journal.calendarDayTooltip', { date: cell.date, count: summary.count })
                      : cell.date
                  }
                  onClick={() => {
                    onSelectDate(cell.date)
                    onClose()
                  }}
                >
                  <span className="journal-calendar-day-num">{cell.day}</span>
                  <span
                    className={`journal-calendar-day-dot${hasEntries ? ' is-visible' : ''}`}
                    aria-hidden="true"
                  />
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="journal-calendar-footer">
        <span className="journal-calendar-footer-meta">
          {loading
            ? t('journal.calendarLoading')
            : currentMonthActivity
              ? t('journal.calendarMonthStats', {
                  days: currentMonthActivity.daysCount,
                  entries: currentMonthActivity.entriesCount,
                })
              : t('journal.calendarMonthEmpty')}
        </span>

        <button
          type="button"
          className="journal-calendar-today-btn"
          onClick={handleJumpToday}
        >
          {t('journal.jumpToday')}
        </button>
      </div>
    </div>
  )
}
