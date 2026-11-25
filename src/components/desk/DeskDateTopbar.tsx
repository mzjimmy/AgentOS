/**
 * Shared SentinelDesk "Date Wheel" topbar (`YYYY / MM ▾`, `[今天]`, 7-day pill ruler, right slot).
 * Used by IntentTodoPage (and aligns visually with JournalPage).
 */

import '../../styles/desk-date-topbar.css'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  formatCalendarDayNumber,
  formatJournalYearMonth,
  formatShortWeekday,
  getWeekDates,
  shiftDateString,
} from '../journal/journal-ui-helpers'
import { DeskCalendarPopover } from './DeskCalendarPopover'
import {
  resolveNextWeekTargetDate,
  type DeskCalendarDayMarker,
  type DeskDateTopbarDayState,
} from './desk-date-framework-contract'

export type { DeskCalendarDayMarker, DeskDateTopbarDayState } from './desk-date-framework-contract'

export type DeskDateTopbarProps = {
  selectedDate: string
  todayDate: string
  disableFuture?: boolean
  calendarMarkers: DeskCalendarDayMarker[]
  calendarLoading?: boolean
  getDayState: (date: string) => DeskDateTopbarDayState
  onSelectDate: (date: string) => void
  onOpenCalendar?: () => void
  rightSlot?: ReactNode
}

export function DeskDateTopbar({
  selectedDate,
  todayDate,
  disableFuture = false,
  calendarMarkers,
  calendarLoading = false,
  getDayState,
  onSelectDate,
  onOpenCalendar,
  rightSlot,
}: DeskDateTopbarProps) {
  const { locale, t } = useI18n()
  const [calendarOpen, setCalendarOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const weekStripDates = useMemo(() => getWeekDates(selectedDate), [selectedDate])
  const { targetDate: nextWeekTarget, disabled: nextWeekDisabled } = resolveNextWeekTargetDate(
    selectedDate,
    todayDate,
    disableFuture,
  )

  return (
    <header className="desk-topbar">
      <div className="desk-topbar-drag" aria-hidden="true" />
      <div className="desk-topbar-left no-drag">
        <div className="desk-calendar-anchor">
          <button
            ref={triggerRef}
            type="button"
            className={`desk-year-month-btn${calendarOpen ? ' is-open' : ''}`}
            aria-label={t('journal.calendarOpenAria')}
            aria-haspopup="dialog"
            aria-expanded={calendarOpen}
            onClick={() => {
              const next = !calendarOpen
              setCalendarOpen(next)
              if (next) onOpenCalendar?.()
            }}
          >
            <span>{formatJournalYearMonth(selectedDate)}</span>
            <span className="desk-year-month-caret" aria-hidden="true">
              {calendarOpen ? '▴' : '▾'}
            </span>
          </button>

          {calendarOpen ? (
            <DeskCalendarPopover
              selectedDate={selectedDate}
              todayDate={todayDate}
              markers={calendarMarkers}
              disableFuture={disableFuture}
              loading={calendarLoading}
              anchorRef={triggerRef}
              onSelectDate={onSelectDate}
              onClose={() => setCalendarOpen(false)}
            />
          ) : null}
        </div>

        {selectedDate !== todayDate ? (
          <button
            type="button"
            className="desk-today-pill"
            onClick={() => onSelectDate(todayDate)}
          >
            {t('journal.jumpToday')}
          </button>
        ) : null}
      </div>

      <nav className="desk-week-strip no-drag" aria-label={t('journal.weekStripAria')}>
        <button
          type="button"
          className="desk-week-arrow"
          aria-label={t('journal.prevWeek')}
          title={t('journal.prevWeek')}
          onClick={() => onSelectDate(shiftDateString(selectedDate, -7))}
        >
          <IconInline name="back" />
        </button>

        <div className="desk-week-days">
          {weekStripDates.map((dateStr) => {
            const isSelected = dateStr === selectedDate
            const isToday = dateStr === todayDate
            const isFuture = disableFuture && dateStr > todayDate
            const dayState = getDayState(dateStr)

            return (
              <button
                key={dateStr}
                type="button"
                disabled={isFuture}
                className={`desk-week-pill${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}${isFuture ? ' is-future' : ''}`}
                aria-current={isSelected ? 'date' : undefined}
                onClick={() => {
                  if (!isFuture) onSelectDate(dateStr)
                }}
              >
                <span className="desk-week-pill-wd">
                  {formatShortWeekday(dateStr, locale)}
                </span>
                <span className="desk-week-pill-day">
                  {formatCalendarDayNumber(dateStr)}
                </span>
                <span className="desk-week-pill-indicator" aria-hidden="true">
                  {dayState.allCleared ? (
                    <span className="desk-week-pill-check">✓</span>
                  ) : dayState.hasPending ? (
                    <span className="desk-week-pill-dot is-pending" />
                  ) : dayState.hasActivity ? (
                    <span className="desk-week-pill-dot is-visible" />
                  ) : (
                    <span className="desk-week-pill-dot" />
                  )}
                </span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className="desk-week-arrow"
          disabled={nextWeekDisabled}
          aria-label={t('journal.nextWeek')}
          title={t('journal.nextWeek')}
          onClick={() => {
            if (nextWeekDisabled) return
            onSelectDate(nextWeekTarget)
          }}
        >
          <IconInline name="forward" />
        </button>
      </nav>

      <div className="desk-topbar-right no-drag">{rightSlot}</div>
    </header>
  )
}
