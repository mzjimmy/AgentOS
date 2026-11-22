/**
 * Shared editorial month/year archive calendar popover for SentinelDesk pinned views
 * (Timeline Journal & Intent Todo).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  getJournalDateParts,
  getMonthCalendarGrid,
  shiftYearMonth,
} from '../journal/journal-ui-helpers'

export type DeskCalendarDayMarker = {
  date: string
  hasActivity: boolean
  cleared?: boolean
}

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

  const activeMonths = useMemo(() => {
    const set = new Set<string>()
    for (const item of markers) {
      if (item.hasActivity && item.date.length >= 7) {
        set.add(item.date.slice(0, 7))
      }
    }
    return set
  }, [markers])

  const calendarCells = useMemo(
    () => getMonthCalendarGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  )

  const todayParts = useMemo(() => getJournalDateParts(todayDate), [todayDate])
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
            const hasActivity = activeMonths.has(ymKey)
            const isViewing = viewYear === initialParts.year && monthNum === initialParts.month
            const isTodayMonth = viewYear === todayParts.year && monthNum === todayParts.month
            return (
              <button
                key={ymKey}
                type="button"
                className={`desk-calendar-month-cell${isViewing ? ' is-active' : ''}${isTodayMonth ? ' is-today' : ''}${hasActivity ? ' is-has-activity' : ''}`}
                onClick={() => {
                  setViewMonth(monthNum)
                  setPickerMode('days')
                }}
              >
                <span className="desk-calendar-month-label">{label}</span>
                {hasActivity ? <span className="desk-calendar-month-dot" aria-hidden="true" /> : null}
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
              const isSelected = cell.date === selectedDate
              const isToday = cell.date === todayDate
              const isFuture = disableFuture && cell.date > todayDate
              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={isFuture}
                  className={`desk-calendar-day-cell${cell.inCurrentMonth ? '' : ' is-outside'}${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${isFuture ? ' is-future' : ''}`}
                  onClick={() => {
                    if (isFuture) return
                    onSelectDate(cell.date)
                    onClose()
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
        <span className="desk-calendar-footer-meta">
          {loading ? t('journal.loadingDay') : ''}
        </span>
        <button
          type="button"
          className="desk-calendar-today-btn"
          onClick={() => {
            onSelectDate(todayDate)
            onClose()
          }}
        >
          {t('journal.jumpToday')}
        </button>
      </div>
    </div>
  )
}
