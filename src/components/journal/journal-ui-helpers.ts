/**
 * 时间日记 Pure UI 辅助工具：日历周计算、12 列卡片跨度分类、#标签/@项目 提取与分类配色。
 * Pure UI helpers for Timeline Journal: week calendar math, deterministic 12-col card spans,
 * inline #tag/@project token extraction, and category metadata.
 */

import {
  JOURNAL_CATEGORIES,
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
  type JournalDiscussTarget,
  type JournalEntry,
  type JournalEntryKind,
  type JournalWeekResult,
  type LegacyJournalSyncOptions,
  type LegacyJournalSyncResult,
  type UpdateJournalEntryInput,
  type UpdateJournalEntryResult,
} from '../../journal-contract'

export type JournalDesktopApi = {
  getJournalConfig?: () => Promise<JournalConfig>
  setJournalDeskRoot?: (deskRoot: string) => Promise<JournalConfig>
  listJournalDays?: (month?: string) => Promise<JournalDaySummary[]>
  getJournalDay?: (date: string) => Promise<JournalDayResult>
  getJournalWeek?: (anchorDate: string) => Promise<JournalWeekResult>
  createJournalEntry?: (input: CreateJournalEntryInput) => Promise<CreateJournalEntryResult>
  updateJournalEntry?: (date: string, entryId: string, patch: UpdateJournalEntryInput) => Promise<UpdateJournalEntryResult>
  deleteJournalEntry?: (date: string, entryId: string) => Promise<DeleteJournalEntryResult>
  readJournalAttachment?: (relativePath: string) => Promise<JournalAttachmentReadResult>
  syncLegacySentinelLabJournal?: (options?: LegacyJournalSyncOptions) => Promise<LegacyJournalSyncResult>
  watchJournal?: () => Promise<{ ok: boolean }>
  unwatchJournal?: () => Promise<{ ok: boolean }>
  onJournalChanged?: (listener: (event: JournalChangedEvent) => void) => () => void
}

export function getJournalDesktopApi(): JournalDesktopApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.desktop as JournalDesktopApi | undefined
}

const ZH_WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const
const ZH_SHORT_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const EN_SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const CATEGORY_SLUGS: Record<JournalCategory, string> = {
  身体: 'body',
  工作: 'work',
  事务: 'affairs',
  学习: 'study',
  生活: 'life',
  工程: 'engineering',
  未归类: 'uncategorized',
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!match) {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
}

function toUtcNoon(dateStr: string): Date {
  const { year, month, day } = parseDateParts(dateStr)
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
}

function formatUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function formatShanghaiParts(date: Date): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JOURNAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
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

/** Calendar date `YYYY-MM-DD` strictly in `Asia/Shanghai` (UTC+8). */
export function toLocalDateString(date: Date = new Date()): string {
  const { year, month, day } = formatShanghaiParts(date)
  return `${year}-${month}-${day}`
}

/** Clock time `HH:mm` strictly in `Asia/Shanghai` (UTC+8). */
export function toLocalTimeString(date: Date = new Date()): string {
  const { hour, minute } = formatShanghaiParts(date)
  return `${hour}:${minute}`
}

/** Add/subtract calendar days without timezone/DST drift. */
export function shiftDateString(dateStr: string, deltaDays: number): string {
  const dt = toUtcNoon(dateStr)
  dt.setUTCDate(dt.getUTCDate() + deltaDays)
  return formatUtcDate(dt)
}

/** Returns 7 `YYYY-MM-DD` strings from Monday through Sunday containing `anchorDate`. */
export function getWeekDates(anchorDate: string): string[] {
  const dt = toUtcNoon(anchorDate)
  const dayOfWeek = dt.getUTCDay() // 0 (Sun) .. 6 (Sat)
  const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = shiftDateString(anchorDate, offsetToMonday)
  return Array.from({ length: 7 }, (_, index) => shiftDateString(monday, index))
}

/** Formats `YYYY-MM-DD` -> `MM.DD` for the hero date display. */
export function formatJournalHeroDate(dateStr: string): string {
  const { month, day } = parseDateParts(dateStr)
  return `${pad2(month)}.${pad2(day)}`
}

/** Formats `YYYY-MM-DD` -> `YYYY / MM` for the top calendar strip. */
export function formatJournalYearMonth(dateStr: string): string {
  const { year, month } = parseDateParts(dateStr)
  return `${year} / ${pad2(month)}`
}

/** Day of month number string without leading zero for compact calendar cells. */
export function formatCalendarDayNumber(dateStr: string): string {
  return String(parseDateParts(dateStr).day)
}

export function formatWeekdayLabel(dateStr: string, locale: 'zh' | 'en' | string): string {
  const dayIndex = toUtcNoon(dateStr).getUTCDay()
  return locale === 'en' ? EN_WEEKDAYS[dayIndex] : ZH_WEEKDAYS[dayIndex]
}

export function formatShortWeekday(dateStr: string, locale: 'zh' | 'en' | string): string {
  const dayIndex = toUtcNoon(dateStr).getUTCDay()
  return locale === 'en' ? EN_SHORT_WEEKDAYS[dayIndex] : ZH_SHORT_WEEKDAYS[dayIndex]
}

/**
 * Resolves the effective visual species for an entry:
 * - Explicit `ai`, `judgment`, `moment`, `thought`, `photo` stay as specified.
 * - A `note` carrying image attachments with a concise caption renders in the `photo` frame.
 */
export function resolveEffectiveCardKind(entry: Pick<JournalEntry, 'kind' | 'body' | 'images'>): JournalEntryKind {
  if (entry.kind === 'photo') return 'photo'
  if (entry.kind === 'note' && entry.images.length > 0 && entry.body.trim().length <= 140) {
    return 'photo'
  }
  return entry.kind
}

/**
 * Deterministically assigns a 12-column grid span (`4..12`) based on card species,
 * text length, images, and index rhythm — never random.
 */
export function classifyJournalCardSpan(entry: JournalEntry, index: number): number {
  const species = resolveEffectiveCardKind(entry)
  const textLen = entry.body.trim().length

  if (species === 'ai') return 12
  if (species === 'judgment') return 4

  if (species === 'photo') {
    if (entry.images.length >= 3) return 7
    if (textLen > 90) return 6
    return index % 2 === 0 ? 5 : 6
  }

  if (species === 'moment') {
    return textLen > 45 ? 5 : 4
  }

  if (species === 'thought') {
    if (textLen <= 40 && !entry.relatedNote) return 4
    if (textLen > 85) return 6
    return 5
  }

  // `note`
  if (textLen >= 110 || entry.tags.length >= 3) return index % 3 === 0 ? 7 : 8
  if (textLen >= 55) return 7
  if (textLen >= 25) return 6
  return 5
}

/** Extracts unique `#tag` and `@project` tokens from composer input while ignoring URL `#` fragments. */
export function extractJournalTokens(
  text: string,
  knownProjects: ReadonlyArray<{ id: string; name: string }> = [],
): { tags: string[]; projectRefs: string[] } {
  const tags: string[] = []
  const seenTags = new Set<string>()
  const projectRefs: string[] = []
  const seenProjects = new Set<string>()

  // Strip URLs before scanning `#tag` / `@mention` so `https://host/#frag` isn't mistaken for a tag
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, ' ')

  const tagRegex = /(?:^|[\s，。！？、；：(\[])#([\p{L}\p{N}_-]{1,40})/gu
  for (const match of withoutUrls.matchAll(tagRegex)) {
    const tag = match[1]?.trim()
    if (tag && !seenTags.has(tag)) {
      seenTags.add(tag)
      tags.push(tag)
    }
  }

  const projectByLowerName = new Map(knownProjects.map((project) => [project.name.toLowerCase(), project.name]))
  const mentionRegex = /(?:^|[\s，。！？、；：(\[])@([\p{L}\p{N}_.-]{1,64})/gu
  for (const match of withoutUrls.matchAll(mentionRegex)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    const canonical = projectByLowerName.get(raw.toLowerCase()) ?? raw
    if (!seenProjects.has(canonical)) {
      seenProjects.add(canonical)
      projectRefs.push(canonical)
    }
  }

  return { tags, projectRefs }
}

export function getJournalCategorySlug(category: JournalCategory): string {
  return CATEGORY_SLUGS[category] ?? 'uncategorized'
}

export function getNextJournalCategory(current: JournalCategory): JournalCategory {
  const index = JOURNAL_CATEGORIES.indexOf(current)
  if (index < 0 || index === JOURNAL_CATEGORIES.length - 1) {
    return JOURNAL_CATEGORIES[0]
  }
  return JOURNAL_CATEGORIES[index + 1]
}

export function stepLightboxIndex(current: number, total: number, delta: -1 | 1): number {
  if (total <= 0) return 0
  return (current + delta + total) % total
}

export function summarizeEntrySnippet(body: string, maxLength = 48): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
}

export function buildJournalDiscussPrompt(entry: JournalEntry): string {
  const metaParts = [`[${entry.date} ${entry.time}]`, `[${entry.category}]`]
  if (entry.tags.length > 0) {
    metaParts.push(entry.tags.map((tag) => `#${tag}`).join(' '))
  }
  if (entry.projectRefs.length > 0) {
    metaParts.push(entry.projectRefs.map((name) => `@${name}`).join(' '))
  }
  return `${metaParts.join(' ')}\n\n${entry.body}`.trim()
}

export type JournalDiscussTargetOption =
  | { kind: 'desk'; deskRoot: string; label: string; matched: boolean }
  | { kind: 'project'; projectId: string; label: string; matched: boolean }

export function buildJournalDiscussTargets(
  entry: Pick<JournalEntry, 'projectRefs'>,
  projects: ReadonlyArray<{ id: string; name: string; path: string }>,
  deskRoot: string,
): JournalDiscussTargetOption[] {
  const normalizedDesk = deskRoot.replace(/[\\/]+$/, '')
  const refSet = new Set(entry.projectRefs.map((r) => r.trim().toLowerCase()).filter(Boolean))
  const deskProject = projects.find((p) => p.path.replace(/[\\/]+$/, '') === normalizedDesk)

  const matchedProjects: JournalDiscussTargetOption[] = []
  const otherProjects: JournalDiscussTargetOption[] = []

  for (const project of projects) {
    if (deskProject && project.id === deskProject.id) continue
    const isMatched = refSet.has(project.name.trim().toLowerCase())
    const option: JournalDiscussTargetOption = {
      kind: 'project',
      projectId: project.id,
      label: project.name,
      matched: isMatched,
    }
    if (isMatched) matchedProjects.push(option)
    else otherProjects.push(option)
  }

  const deskOption: JournalDiscussTargetOption = {
    kind: 'desk',
    deskRoot: normalizedDesk,
    label: 'SentinelDesk',
    matched: false,
  }

  return [...matchedProjects, deskOption, ...otherProjects]
}

export function toJournalDiscussTarget(option: JournalDiscussTargetOption): JournalDiscussTarget {
  return option.kind === 'desk'
    ? { kind: 'desk', deskRoot: option.deskRoot }
    : { kind: 'project', projectId: option.projectId }
}

