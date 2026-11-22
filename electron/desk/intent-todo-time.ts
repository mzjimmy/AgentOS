/**
 * Pure Asia/Shanghai timezone and 04:00 logical-day cutover helpers for Intent Todo.
 * Completely immune to host OS timezone (e.g. America/Los_Angeles PST/PDT & DST transitions).
 */

import { JOURNAL_TIMEZONE } from '../../src/journal-contract'
import { INTENT_TODO_CUTOVER_HOUR } from '../../src/intent-todo-contract'

export type ShanghaiParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  dateString: string
  timeString: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatShanghaiParts(date: Date = new Date()): ShanghaiParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JOURNAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const rawHour = get('hour')
  const hourStr = rawHour === '24' ? '00' : rawHour
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(hourStr)
  const minute = Number(get('minute'))
  const second = Number(get('second'))

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateString: `${year}-${pad2(month)}-${pad2(day)}`,
    timeString: `${pad2(hour)}:${pad2(minute)}`,
  }
}

export function getShanghaiDateString(date: Date = new Date()): string {
  return formatShanghaiParts(date).dateString
}

export function shiftDateString(dateStr: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!match) return dateStr
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0))
  dt.setUTCDate(dt.getUTCDate() + deltaDays)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

export function diffDateDays(earlierDateStr: string, laterDateStr: string): number {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(earlierDateStr.trim())
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(laterDateStr.trim())
  if (!m1 || !m2) return 0
  const t1 = Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]), 12, 0, 0)
  const t2 = Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]), 12, 0, 0)
  return Math.round((t2 - t1) / 86_400_000)
}

/**
 * Returns the active logical Todo day in Asia/Shanghai.
 * Before `cutoverHour` (default 04:00), still belongs to previous calendar date's logical day.
 */
export function getShanghaiLogicalDay(
  date: Date = new Date(),
  cutoverHour: number = INTENT_TODO_CUTOVER_HOUR,
): string {
  const parts = formatShanghaiParts(date)
  if (parts.hour < cutoverHour) {
    return shiftDateString(parts.dateString, -1)
  }
  return parts.dateString
}

/**
 * True if Shanghai clock is at or past `cutoverHour:00` of the current Shanghai calendar date.
 */
export function hasPassedShanghaiCutover(
  date: Date = new Date(),
  cutoverHour: number = INTENT_TODO_CUTOVER_HOUR,
): boolean {
  return formatShanghaiParts(date).hour >= cutoverHour
}

/**
 * Returns explicit `+08:00` ISO string for the cutover moment of `logicalDate`
 * (e.g. `2026-11-22T04:00:00+08:00`) — safe for `git log --since=...` regardless of host TZ.
 */
export function getShanghaiCutoverIso(
  logicalDate: string,
  cutoverHour: number = INTENT_TODO_CUTOVER_HOUR,
): string {
  return `${logicalDate}T${pad2(cutoverHour)}:00:00+08:00`
}

/**
 * Parses an entry timestamp into epoch ms, falling back to `date + time` in `+08:00`.
 */
export function parseJournalEntryTimestampMs(entry: { ts?: string; date: string; time: string }): number {
  if (entry.ts) {
    const parsed = Date.parse(entry.ts)
    if (Number.isFinite(parsed)) return parsed
  }
  const timeNorm = /^\d{2}:\d{2}$/.test(entry.time) ? entry.time : '00:00'
  const fallback = Date.parse(`${entry.date}T${timeNorm}:00+08:00`)
  return Number.isFinite(fallback) ? fallback : Date.now()
}
