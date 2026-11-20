/**
 * Read-Only Legacy SQLite Sync for SentinelDesk.
 * Reads journal_entries from SentinelLab SQLite database via `sqlite3 -readonly -json`
 * with ZERO write access, idempotent import, and tag category inference.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  DEFAULT_LEGACY_SENTINELLAB_DB_PATH,
  JOURNAL_CATEGORIES,
  type JournalCategory,
  type JournalEntry,
  type LegacyJournalSyncOptions,
  type LegacyJournalSyncResult,
} from '../../src/journal-contract'
import type { JournalStore } from './journal-store'

const execFileAsync = promisify(execFile)

interface LegacySqliteRow {
  id: string
  user_id?: string
  date: string
  timestamp: string
  text: string
  tags: string
  created_at?: string
  updated_at?: string
}

export function inferCategoryFromTags(tags: string[]): JournalCategory {
  for (const tag of tags) {
    if (JOURNAL_CATEGORIES.includes(tag as JournalCategory)) {
      return tag as JournalCategory
    }
  }

  for (const tag of tags) {
    const lower = tag.toLowerCase()
    if (/学习|阅读|思考|read|study|book|paper/i.test(lower)) return '学习'
    if (/工作|会议|项目|任务|work|job|meeting|project/i.test(lower)) return '工作'
    if (/事务|办证|账单|task|admin/i.test(lower)) return '事务'
    if (/生活|运动|饮食|休息|life|eat|sport/i.test(lower)) return '生活'
    if (/身体|健康|睡眠|health|sleep/i.test(lower)) return '身体'
    if (/工程|代码|dev|bug|code|git/i.test(lower)) return '工程'
  }

  return '未归类'
}

function formatDateAndTimeInZone(d: Date, timeZone?: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hourRaw = get('hour')
  const hour = hourRaw === '24' ? '00' : hourRaw
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  }
}

export function parseLegacyTimestamp(date: string, timestamp: string): { time: string; ts: string } {
  if (/^\d{1,2}:\d{2}/.test(timestamp)) {
    const time = timestamp.slice(0, 5).padStart(5, '0')
    return {
      time,
      ts: `${date}T${time}:00.000+08:00`,
    }
  }

  try {
    const d = new Date(timestamp)
    if (!isNaN(d.getTime())) {
      // Always align journal times to Asia/Shanghai (UTC+8) regardless of host OS timezone.
      const shanghai = formatDateAndTimeInZone(d, 'Asia/Shanghai')
      return { time: shanghai.time, ts: d.toISOString() }
    }
  } catch {
    // fallback
  }

  return {
    time: '00:00',
    ts: `${date}T00:00:00.000+08:00`,
  }
}

export async function syncLegacySentinelLabJournal(
  store: JournalStore,
  options?: LegacyJournalSyncOptions
): Promise<LegacyJournalSyncResult> {
  const dbPath = options?.dbPath || store.getConfig().legacyDbPath || DEFAULT_LEGACY_SENTINELLAB_DB_PATH

  if (!existsSync(dbPath)) {
    return {
      ok: false,
      dbPath,
      error: `Database file not found: ${dbPath}`,
    }
  }

  const limitClause = options?.limit && options.limit > 0 ? ` LIMIT ${options.limit}` : ''
  const query = `SELECT id, date, timestamp, text, tags FROM journal_entries ORDER BY date ASC, timestamp ASC${limitClause};`

  let stdout = ''
  try {
    const result = await execFileAsync(
      'sqlite3',
      ['-readonly', '-json', dbPath, query],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    stdout = result.stdout || ''
  } catch (err: any) {
    return {
      ok: false,
      dbPath,
      error: `Failed to query SQLite database in read-only mode: ${err?.message || String(err)}`,
    }
  }

  const trimmed = stdout.trim()
  if (!trimmed) {
    return {
      ok: true,
      dbPath,
      totalScanned: 0,
      imported: 0,
      skipped: 0,
      latestDate: null,
      daysTouched: 0,
    }
  }

  let rows: LegacySqliteRow[] = []
  try {
    rows = JSON.parse(trimmed)
  } catch (err: any) {
    return {
      ok: false,
      dbPath,
      error: `Failed to parse SQLite JSON output: ${err?.message || String(err)}`,
    }
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: true,
      dbPath,
      totalScanned: 0,
      imported: 0,
      skipped: 0,
      latestDate: null,
      daysTouched: 0,
    }
  }

  // Group rows by calendar date
  const byDate = new Map<string, LegacySqliteRow[]>()
  let latestDate: string | null = null

  for (const row of rows) {
    if (!row.date) continue
    if (!latestDate || row.date > latestDate) {
      latestDate = row.date
    }
    const list = byDate.get(row.date) || []
    list.push(row)
    byDate.set(row.date, list)
  }

  let totalScanned = rows.length
  let totalImported = 0
  let totalSkipped = 0
  const touchedDates: string[] = []

  for (const [date, dateRows] of byDate.entries()) {
    const entriesToImport: JournalEntry[] = []

    for (const row of dateRows) {
      let parsedTags: string[] = []
      try {
        if (typeof row.tags === 'string') {
          const parsed = JSON.parse(row.tags)
          if (Array.isArray(parsed)) parsedTags = parsed.map(String)
        }
      } catch {
        parsedTags = []
      }

      const category = inferCategoryFromTags(parsedTags)
      const { time, ts } = parseLegacyTimestamp(date, row.timestamp)

      const safeLegacyId = String(row.id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'row'
      const entry: JournalEntry = {
        id: `je_${date.replace(/-/g, '')}_${time.replace(':', '')}_sl_${safeLegacyId}`,
        date,
        time,
        ts,
        kind: 'note',
        body: row.text || '',
        category,
        tags: parsedTags,
        projectRefs: [],
        source: 'sentinellab-import',
        provenance: 'human',
        externalId: `sl:${row.id}`,
        images: [],
        relatedNote: null,
        momentTitle: null,
        momentSubtitle: null,
      }
      entriesToImport.push(entry)
    }

    const { imported, skipped } = await store.importLegacyDayEntries(date, entriesToImport)
    totalImported += imported
    totalSkipped += skipped

    if (imported > 0) {
      touchedDates.push(date)
    }
  }

  if (touchedDates.length > 0) {
    store.notifyChange({
      reason: 'legacy-sync',
      dates: touchedDates,
      timestamp: Date.now(),
    })
  }

  return {
    ok: true,
    dbPath,
    totalScanned,
    imported: totalImported,
    skipped: totalSkipped,
    latestDate,
    daysTouched: touchedDates.length,
  }
}
