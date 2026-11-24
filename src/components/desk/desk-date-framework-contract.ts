/**
 * Frozen contract & pure helpers for the unified SentinelDesk Date & Week-Slider framework.
 * Shared across all 5 date-archived modules:
 *   journal | intent-todo | language-push | morning-brief | outbound
 */

import { getWeekDates, shiftDateString } from '../journal/journal-ui-helpers'

export const DESK_DATE_ARCHIVED_VIEW_IDS = [
  'journal',
  'intent-todo',
  'language-push',
  'morning-brief',
  'outbound',
] as const

export type DeskDateArchivedViewId = (typeof DESK_DATE_ARCHIVED_VIEW_IDS)[number]

export type DeskCalendarDayMarker = {
  date: string
  hasActivity: boolean
  cleared?: boolean
  /** Optional item/entry count for richer tooltip & month totals (e.g. Journal). */
  count?: number
}

export type DeskDateTopbarDayState = {
  hasPending?: boolean
  allCleared?: boolean
  hasActivity?: boolean
}

export type DeskCalendarMonthSummary = {
  daysCount: number
  totalCount: number
}

/**
 * Aggregates day markers into `YYYY-MM` -> `{ daysCount, totalCount }` for the 12-month
 * overview picker inside `DeskCalendarPopover`.
 */
export function summarizeDeskCalendarMonths(
  markers: readonly DeskCalendarDayMarker[],
): Map<string, DeskCalendarMonthSummary> {
  const result = new Map<string, DeskCalendarMonthSummary>()
  const seenDates = new Set<string>()
  for (const item of markers) {
    if (!item || !item.date || item.date.length < 7 || !item.hasActivity) continue
    if (seenDates.has(item.date)) continue
    seenDates.add(item.date)
    const ym = item.date.slice(0, 7)
    const prev = result.get(ym) ?? { daysCount: 0, totalCount: 0 }
    prev.daysCount += 1
    prev.totalCount += typeof item.count === 'number' ? Math.max(0, item.count) : 1
    result.set(ym, prev)
  }
  return result
}

/**
 * Resolves the target date and disabled state for the Topbar's "Next Week" arrow.
 */
export function resolveNextWeekTargetDate(
  selectedDate: string,
  todayDate: string,
  disableFuture: boolean,
): { targetDate: string; disabled: boolean } {
  const weekDates = getWeekDates(selectedDate)
  const disabled = disableFuture && weekDates[6] >= todayDate
  const shifted = shiftDateString(selectedDate, 7)
  const targetDate = disableFuture && shifted > todayDate ? todayDate : shifted
  return { targetDate, disabled }
}
