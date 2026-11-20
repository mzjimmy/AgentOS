/**
 * SentinelDesk Journal Store: Markdown persistence, atomic writes, attachment management,
 * idempotency, aggregation, and file system watching.
 */

import { existsSync, mkdirSync, promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_LEGACY_SENTINELLAB_DB_PATH,
  DEFAULT_SENTINELLAB_BRIDGE_SCRIPT_PATH,
  DEFAULT_SENTINEL_DESK_ROOT,
  JOURNAL_TIMEZONE,
  type CreateJournalEntryInput,
  type CreateJournalEntryResult,
  type DeleteJournalEntryResult,
  type JournalAttachmentReadResult,
  type JournalCategory,
  type JournalChangedEvent,
  type JournalConfig,
  type JournalDayResult,
  type JournalDaySummary,
  type JournalEntry,
  type JournalImageAttachment,
  type JournalWeekDay,
  type JournalWeekResult,
  type UpdateJournalEntryInput,
  type UpdateJournalEntryResult,
} from '../../src/journal-contract'
import { parseDayMarkdown, serializeDayMarkdown } from './journal-markdown'

export interface JournalStoreOptions {
  deskRoot?: string
  legacyDbPath?: string
  bridgeScriptPath?: string
  onChange?: (event: JournalChangedEvent) => void
}

export class JournalStore {
  private deskRoot: string
  private legacyDbPath: string
  private bridgeScriptPath: string
  private onChange?: (event: JournalChangedEvent) => void
  private watcher: FSWatcher | null = null
  private internalWriteTimestamps = new Map<string, number>()
  private watchDebounceTimer: NodeJS.Timeout | null = null
  private pendingWatchDates = new Set<string>()
  private pendingWatchPaths = new Set<string>()

  constructor(options: JournalStoreOptions = {}) {
    this.deskRoot = options.deskRoot || process.env.SENTINEL_DESK_ROOT || DEFAULT_SENTINEL_DESK_ROOT
    this.legacyDbPath = options.legacyDbPath || DEFAULT_LEGACY_SENTINELLAB_DB_PATH
    this.bridgeScriptPath = options.bridgeScriptPath || DEFAULT_SENTINELLAB_BRIDGE_SCRIPT_PATH
    this.onChange = options.onChange
  }

  getDeskRoot(): string {
    return this.deskRoot
  }

  getJournalRoot(): string {
    return path.join(this.deskRoot, 'journal')
  }

  getAttachmentsRoot(): string {
    return path.join(this.deskRoot, 'journal', 'attachments')
  }

  getConfig(): JournalConfig {
    return {
      deskRoot: this.deskRoot,
      journalRoot: this.getJournalRoot(),
      legacyDbPath: this.legacyDbPath,
      legacyDbAvailable: existsSync(this.legacyDbPath),
      bridgeScriptPath: this.bridgeScriptPath,
      bridgeScriptAvailable: existsSync(this.bridgeScriptPath),
    }
  }

  setDeskRoot(newDeskRoot: string): JournalConfig {
    this.deskRoot = newDeskRoot
    if (this.watcher) {
      this.unwatch()
      this.watch()
    }
    const config = this.getConfig()
    this.emitChange({
      reason: 'config-changed',
      dates: [],
      timestamp: Date.now(),
    })
    return config
  }

  notifyChange(event: JournalChangedEvent): void {
    this.emitChange(event)
  }

  async importLegacyDayEntries(
    date: string,
    newEntries: JournalEntry[]
  ): Promise<{ imported: number; skipped: number }> {
    const dayResult = await this.getDay(date)
    const existing = dayResult.ok ? dayResult.entries : []
    const existingExtIds = new Set(existing.map((e) => e.externalId).filter(Boolean))

    const toAdd: JournalEntry[] = []
    let skipped = 0

    for (const entry of newEntries) {
      if (entry.externalId && existingExtIds.has(entry.externalId)) {
        skipped++
      } else {
        toAdd.push(entry)
        if (entry.externalId) existingExtIds.add(entry.externalId)
      }
    }

    if (toAdd.length > 0) {
      const merged = [...existing, ...toAdd]
      const filePath = this.getDayFilePath(date)
      const markdown = serializeDayMarkdown(date, merged)
      await this.atomicWriteFile(filePath, markdown)
    }

    return { imported: toAdd.length, skipped }
  }

  private emitChange(event: JournalChangedEvent): void {
    if (this.onChange) {
      try {
        this.onChange(event)
      } catch (err) {
        console.error('[JournalStore] onChange error:', err)
      }
    }
  }

  private getDayFilePath(date: string): string {
    const [year, month] = date.split('-')
    return path.join(this.getJournalRoot(), year, month, `${date}.md`)
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmpName = `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
    const tmpPath = path.join(dir, tmpName)
    await fs.writeFile(tmpPath, content, 'utf8')
    await fs.rename(tmpPath, filePath)
    this.internalWriteTimestamps.set(filePath, Date.now())
  }

  async getDay(date: string): Promise<JournalDayResult> {
    const filePath = this.getDayFilePath(date)
    try {
      if (!existsSync(filePath)) {
        return {
          ok: true,
          date,
          filePath,
          entries: [],
        }
      }
      const content = await fs.readFile(filePath, 'utf8')
      const entries = parseDayMarkdown(date, content)
      return {
        ok: true,
        date,
        filePath,
        entries,
      }
    } catch (err: any) {
      return {
        ok: false,
        date,
        error: err?.message || String(err),
      }
    }
  }

  async createEntry(input: CreateJournalEntryInput): Promise<CreateJournalEntryResult> {
    try {
      const parsedTs = input.ts ? new Date(input.ts) : null
      const baseDate = parsedTs && !Number.isNaN(parsedTs.getTime()) ? parsedTs : new Date()
      const targetDate = input.date || formatLocalDate(baseDate)
      const targetTime = input.time || formatLocalTime(baseDate)
      const targetTs = input.ts || baseDate.toISOString()
      const filePath = this.getDayFilePath(targetDate)

      // 1. Read existing entries to check dedup
      const dayResult = await this.getDay(targetDate)
      const existingEntries = dayResult.ok ? [...dayResult.entries] : []

      if (input.externalId) {
        const existing = existingEntries.find((e) => e.externalId === input.externalId)
        if (existing) {
          return {
            ok: true,
            entry: existing,
            deduplicated: true,
            filePath,
          }
        }
      }

      // 2. Process image attachments if provided
      const processedImages: JournalImageAttachment[] = []
      const [year, month] = targetDate.split('-')
      const attachmentsDir = path.join(this.getAttachmentsRoot(), year, month)

      if (input.images && input.images.length > 0) {
        await fs.mkdir(attachmentsDir, { recursive: true })
        for (let i = 0; i < input.images.length; i++) {
          const imgInput = input.images[i]
          let base64Data = imgInput.dataUrl
          let mimeType = imgInput.mimeType || 'image/png'

          const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,(.+)$/)
          if (dataUrlMatch) {
            mimeType = dataUrlMatch[1]
            base64Data = dataUrlMatch[2]
          }

          const parsedName = path.parse(imgInput.fileName || `img_${i}`)
          const safeBaseName = (parsedName.name || `img_${i}`).replace(/[^a-zA-Z0-9_-]/g, '_')
          const ext = (parsedName.ext.replace('.', '') || (mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : (mimeType.split('/')[1] || 'png'))).toLowerCase()
          const savedFileName = `${Date.now()}_${randomBytes(3).toString('hex')}_${safeBaseName}.${ext}`
          const diskPath = path.join(attachmentsDir, savedFileName)

          await fs.writeFile(diskPath, Buffer.from(base64Data, 'base64'))

          processedImages.push({
            relativePath: `attachments/${year}/${month}/${savedFileName}`,
            fileName: imgInput.fileName || savedFileName,
            mimeType,
            caption: imgInput.caption,
          })
        }
      }

      // 3. Create entry
      const entryId = `je_${targetDate.replace(/-/g, '')}_${targetTime.replace(':', '')}_${randomBytes(3).toString('hex')}`
      const entryKind = input.kind || (processedImages.length > 0 && !input.body.trim() ? 'photo' : 'note')
      const category: JournalCategory = input.category || '未归类'

      const newEntry: JournalEntry = {
        id: entryId,
        date: targetDate,
        time: targetTime,
        ts: targetTs,
        kind: entryKind,
        body: input.body || '',
        category,
        tags: input.tags || [],
        projectRefs: input.projectRefs || [],
        source: input.source || 'local',
        provenance: input.provenance || 'human',
        externalId: input.externalId ?? null,
        images: processedImages,
        relatedNote: input.relatedNote ?? null,
        momentTitle: input.momentTitle ?? null,
        momentSubtitle: input.momentSubtitle ?? null,
      }

      existingEntries.push(newEntry)

      // 4. Serialize & atomic write
      const markdown = serializeDayMarkdown(targetDate, existingEntries)
      await this.atomicWriteFile(filePath, markdown)

      this.emitChange({
        reason: 'created',
        dates: [targetDate],
        timestamp: Date.now(),
      })

      return {
        ok: true,
        entry: newEntry,
        deduplicated: false,
        filePath,
      }
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || String(err),
      }
    }
  }

  async updateEntry(
    date: string,
    entryId: string,
    patch: UpdateJournalEntryInput
  ): Promise<UpdateJournalEntryResult> {
    try {
      const dayResult = await this.getDay(date)
      if (!dayResult.ok) {
        return { ok: false, error: dayResult.error }
      }

      const entries = dayResult.entries
      const targetIndex = entries.findIndex((e) => e.id === entryId)
      if (targetIndex === -1) {
        return { ok: false, error: `Entry not found: ${entryId}` }
      }

      const existing = entries[targetIndex]
      const updated: JournalEntry = {
        ...existing,
        body: patch.body !== undefined ? patch.body : existing.body,
        kind: patch.kind !== undefined ? patch.kind : existing.kind,
        category: patch.category !== undefined ? patch.category : existing.category,
        tags: patch.tags !== undefined ? patch.tags : existing.tags,
        projectRefs: patch.projectRefs !== undefined ? patch.projectRefs : existing.projectRefs,
        relatedNote: patch.relatedNote !== undefined ? patch.relatedNote : existing.relatedNote,
        momentTitle: patch.momentTitle !== undefined ? patch.momentTitle : existing.momentTitle,
        momentSubtitle: patch.momentSubtitle !== undefined ? patch.momentSubtitle : existing.momentSubtitle,
      }

      entries[targetIndex] = updated
      const filePath = this.getDayFilePath(date)
      const markdown = serializeDayMarkdown(date, entries)
      await this.atomicWriteFile(filePath, markdown)

      this.emitChange({
        reason: 'updated',
        dates: [date],
        timestamp: Date.now(),
      })

      return {
        ok: true,
        entry: updated,
      }
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || String(err),
      }
    }
  }

  async deleteEntry(date: string, entryId: string): Promise<DeleteJournalEntryResult> {
    try {
      const dayResult = await this.getDay(date)
      if (!dayResult.ok) {
        return { ok: false, error: dayResult.error }
      }

      const entries = dayResult.entries
      const filtered = entries.filter((e) => e.id !== entryId)
      if (filtered.length === entries.length) {
        return { ok: false, error: `Entry not found: ${entryId}` }
      }

      const filePath = this.getDayFilePath(date)
      const markdown = serializeDayMarkdown(date, filtered)
      await this.atomicWriteFile(filePath, markdown)

      this.emitChange({
        reason: 'deleted',
        dates: [date],
        timestamp: Date.now(),
      })

      return {
        ok: true,
        date,
        entryId,
      }
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || String(err),
      }
    }
  }

  async readAttachment(relativePath: string): Promise<JournalAttachmentReadResult> {
    try {
      // Normalize and guard against path traversal
      const attachmentsBase = path.resolve(this.getAttachmentsRoot())
      const resolved = path.resolve(this.getJournalRoot(), relativePath)

      if (!resolved.startsWith(attachmentsBase + path.sep)) {
        return {
          ok: false,
          error: `Path traversal forbidden: ${relativePath}`,
        }
      }

      if (!existsSync(resolved)) {
        return {
          ok: false,
          error: `Attachment not found: ${relativePath}`,
        }
      }

      const buffer = await fs.readFile(resolved)
      const ext = path.extname(resolved).toLowerCase().replace('.', '')
      let mimeType = `image/${ext}`
      if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg'
      else if (ext === 'svg') mimeType = 'image/svg+xml'

      const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
      return {
        ok: true,
        relativePath,
        mimeType,
        dataUrl,
      }
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message || String(err),
      }
    }
  }

  async listDays(month?: string): Promise<JournalDaySummary[]> {
    const journalRoot = this.getJournalRoot()
    if (!existsSync(journalRoot)) {
      return []
    }

    const summaries: JournalDaySummary[] = []
    const datesFound = new Set<string>()

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [year, m] = month.split('-')
      const monthDir = path.join(journalRoot, year, m)
      if (existsSync(monthDir)) {
        const files = await fs.readdir(monthDir)
        for (const file of files) {
          if (file.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(file)) {
            datesFound.add(file.slice(0, 10))
          }
        }
      }
    } else {
      // Scan all YYYY/MM/
      try {
        const years = await fs.readdir(journalRoot)
        for (const y of years) {
          if (!/^\d{4}$/.test(y)) continue
          const yearDir = path.join(journalRoot, y)
          const months = await fs.readdir(yearDir)
          for (const m of months) {
            if (!/^\d{2}$/.test(m)) continue
            const monthDir = path.join(yearDir, m)
            const files = await fs.readdir(monthDir)
            for (const file of files) {
              if (file.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(file)) {
                datesFound.add(file.slice(0, 10))
              }
            }
          }
        }
      } catch (err) {
        console.error('[JournalStore] listDays error scanning dirs:', err)
      }
    }

    // Read summaries for discovered dates
    const sortedDates = Array.from(datesFound).sort().reverse()
    for (const d of sortedDates) {
      const dayRes = await this.getDay(d)
      if (dayRes.ok) {
        const entries = dayRes.entries
        summaries.push({
          date: d,
          count: entries.length,
          hasImages: entries.some((e) => e.images && e.images.length > 0),
          hasFeishu: entries.some((e) => e.source === 'feishu'),
          hasAi: entries.some((e) => e.source === 'ai' || e.kind === 'ai'),
        })
      }
    }

    return summaries
  }

  async getWeek(anchorDate: string): Promise<JournalWeekResult> {
    try {
      const weekDates = getWeekDates(anchorDate)
      const startDate = weekDates[0]
      const endDate = weekDates[6]
      const days: JournalWeekDay[] = []

      for (const d of weekDates) {
        const dayRes = await this.getDay(d)
        const entries = dayRes.ok ? dayRes.entries : []
        days.push({
          date: d,
          summary: {
            date: d,
            count: entries.length,
            hasImages: entries.some((e) => e.images && e.images.length > 0),
            hasFeishu: entries.some((e) => e.source === 'feishu'),
            hasAi: entries.some((e) => e.source === 'ai' || e.kind === 'ai'),
          },
          entries,
        })
      }

      return {
        ok: true,
        anchorDate,
        startDate,
        endDate,
        days,
      }
    } catch (err: any) {
      return {
        ok: false,
        anchorDate,
        error: err?.message || String(err),
      }
    }
  }

  watch(): { ok: boolean } {
    if (this.watcher) {
      return { ok: true }
    }

    const journalRoot = this.getJournalRoot()
    if (!existsSync(journalRoot)) {
      try {
        mkdirSync(journalRoot, { recursive: true })
      } catch {
        return { ok: false }
      }
    }

    try {
      this.watcher = fsWatch(
        journalRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return
          const normalized = String(filename).replace(/\\/g, '/')
          // Filter out temporary files
          if (normalized.includes('.tmp-')) return

          const dateMatch = normalized.match(/(\d{4}-\d{2}-\d{2})\.md$/)
          if (dateMatch) {
            this.pendingWatchDates.add(dateMatch[1])
          }
          this.pendingWatchPaths.add(normalized)

          // Debounce external write notifications without losing earlier `.md` filenames
          if (this.watchDebounceTimer) {
            clearTimeout(this.watchDebounceTimer)
          }

          this.watchDebounceTimer = setTimeout(() => {
            const changedDates = Array.from(this.pendingWatchDates)
            const changedPaths = Array.from(this.pendingWatchPaths)
            this.pendingWatchDates.clear()
            this.pendingWatchPaths.clear()

            // Check if every observed markdown write was triggered internally within 1500ms
            const now = Date.now()
            const mdPaths = changedPaths.filter((p) => p.endsWith('.md'))
            const checkPaths = mdPaths.length > 0 ? mdPaths : changedPaths
            let allInternal = checkPaths.length > 0
            for (const changed of checkPaths) {
              let matched = false
              for (const [p, ts] of this.internalWriteTimestamps.entries()) {
                if (now - ts < 1500 && p.replace(/\\/g, '/').includes(changed)) {
                  matched = true
                  break
                }
              }
              if (!matched) {
                allInternal = false
                break
              }
            }

            if (!allInternal && (changedDates.length > 0 || mdPaths.length > 0)) {
              this.emitChange({
                reason: 'external-write',
                dates: changedDates,
                timestamp: Date.now(),
              })
            }

            // Cleanup old internal write timestamps
            for (const [p, ts] of this.internalWriteTimestamps.entries()) {
              if (now - ts > 5000) {
                this.internalWriteTimestamps.delete(p)
              }
            }
          }, 150)
        }
      )
      return { ok: true }
    } catch (err) {
      console.error('[JournalStore] watch error:', err)
      return { ok: false }
    }
  }

  unwatch(): { ok: boolean } {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        // ignore
      }
      this.watcher = null
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer)
      this.watchDebounceTimer = null
    }
    return { ok: true }
  }

  dispose(): void {
    this.unwatch()
  }
}

function formatShanghaiParts(d: Date): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JOURNAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hourRaw = get('hour')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hourRaw === '24' ? '00' : hourRaw,
    minute: get('minute'),
  }
}

function formatLocalDate(d: Date): string {
  const { year, month, day } = formatShanghaiParts(d)
  return `${year}-${month}-${day}`
}

function formatLocalTime(d: Date): string {
  const { hour, minute } = formatShanghaiParts(d)
  return `${hour}:${minute}`
}

export function getWeekDates(anchorDate: string): string[] {
  const d = new Date(anchorDate + 'T12:00:00Z')
  const dayOfWeek = d.getUTCDay() // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const monDiff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek

  const mon = new Date(d)
  mon.setUTCDate(d.getUTCDate() + monDiff)

  const dates: string[] = []
  for (let i = 0; i < 7; i++) {
    const cur = new Date(mon)
    cur.setUTCDate(mon.getUTCDate() + i)
    const y = cur.getUTCFullYear()
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0')
    const day = String(cur.getUTCDate()).padStart(2, '0')
    dates.push(`${y}-${m}-${day}`)
  }
  return dates
}
