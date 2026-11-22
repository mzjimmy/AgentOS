/**
 * Reactive Asia/Shanghai calendar/logical-day hook that re-evaluates on visibilitychange,
 * minute ticks, and external refresh tokens — preventing stale "today" across midnight or 04:00 cutover.
 */

import { useEffect, useState } from 'react'
import { JOURNAL_TIMEZONE } from '../../journal-contract'
import { shiftDateString } from '../journal/journal-ui-helpers'

function computeShanghaiToday(cutoverHour?: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JOURNAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date())

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`
  const hourRaw = get('hour')
  const hour = Number(hourRaw === '24' ? '00' : hourRaw)

  if (typeof cutoverHour === 'number' && hour < cutoverHour) {
    return shiftDateString(dateStr, -1)
  }
  return dateStr
}

export function useShanghaiToday(options?: { cutoverHour?: number; refreshToken?: number }): string {
  const cutoverHour = options?.cutoverHour
  const refreshToken = options?.refreshToken ?? 0
  const [today, setToday] = useState<string>(() => computeShanghaiToday(cutoverHour))

  useEffect(() => {
    const sync = () => {
      const next = computeShanghaiToday(cutoverHour)
      setToday((prev) => (prev === next ? prev : next))
    }

    sync()
    const timer = window.setInterval(sync, 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', sync)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', sync)
    }
  }, [cutoverHour, refreshToken])

  return today
}
