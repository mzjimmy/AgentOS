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
  type FeishuBridgeConfigUpdate,
  type FeishuBridgeStatus,
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
  getFeishuJournalBridgeStatus?: () => Promise<FeishuBridgeStatus>
  saveFeishuJournalBridgeConfig?: (update: FeishuBridgeConfigUpdate) => Promise<FeishuBridgeStatus>
  reconnectFeishuJournalBridge?: () => Promise<FeishuBridgeStatus>
  onFeishuJournalBridgeStatus?: (listener: (status: FeishuBridgeStatus) => void) => () => void
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
    const shanghai = formatShanghaiParts(new Date())
    return {
      year: Number(shanghai.year),
      month: Number(shanghai.month),
      day: Number(shanghai.day),
    }
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

export type JournalCalendarCell = {
  date: string
  day: number
  inCurrentMonth: boolean
}

export type JournalMonthActivity = {
  daysCount: number
  entriesCount: number
}

export function getJournalDateParts(dateStr: string): { year: number; month: number; day: number } {
  return parseDateParts(dateStr)
}

/** Shifts `{ year, month }` (1-based month) by `deltaMonths` cleanly across year boundaries. */
export function shiftYearMonth(
  year: number,
  month: number,
  deltaMonths: number,
): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + deltaMonths
  const nextYear = Math.floor(zeroBased / 12)
  const nextMonth = ((zeroBased % 12) + 12) % 12 + 1
  return { year: nextYear, month: nextMonth }
}

/** Returns a Monday-first 6x7 (42-cell) calendar grid for the given 1-based `year` and `month`. */
export function getMonthCalendarGrid(year: number, month: number): JournalCalendarCell[] {
  const firstDayStr = `${year}-${pad2(month)}-01`
  const firstDayUtc = toUtcNoon(firstDayStr)
  const dayOfWeek = firstDayUtc.getUTCDay() // 0 (Sun) .. 6 (Sat)
  const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const gridStart = shiftDateString(firstDayStr, offsetToMonday)
  const targetPrefix = `${year}-${pad2(month)}-`

  return Array.from({ length: 42 }, (_, index) => {
    const date = shiftDateString(gridStart, index)
    const parts = parseDateParts(date)
    return {
      date,
      day: parts.day,
      inCurrentMonth: date.startsWith(targetPrefix),
    }
  })
}

/** Aggregates `JournalDaySummary[]` into `YYYY-MM` -> `{ daysCount, entriesCount }`. */
export function summarizeJournalMonths(
  days: JournalDaySummary[],
): Map<string, JournalMonthActivity> {
  const result = new Map<string, JournalMonthActivity>()
  for (const item of days) {
    if (!item || typeof item.date !== 'string' || item.count <= 0) continue
    const ym = item.date.slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(ym)) continue
    const prev = result.get(ym)
    if (prev) {
      prev.daysCount += 1
      prev.entriesCount += item.count
    } else {
      result.set(ym, { daysCount: 1, entriesCount: item.count })
    }
  }
  return result
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

export type JournalLayoutGroupKind =
  | 'quad-photo-right'
  | 'pair-photo-note'
  | 'pair-note-short'
  | 'pair-editorial-duo'
  | 'ai-boundary'
  | 'single'

export type JournalCardPresentation =
  | 'default'
  | 'compact-thought'
  | 'editorial-thought'
  | 'auto-moment'
  | 'link-bookmark'

export type JournalExtractedLink = {
  url: string
  host: string
  platform: string
  displayPath: string
}

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/gi
const URL_EXTRACT_RE = /https?:\/\/[^\s<>"{}|\\^`[\]）】》」，。；！？、]+/gi
const TRAILING_URL_PUNCT_RE = /[.,;:!?'\"\]}。，；！？、）】》」]+$/
const NUMBERED_LIST_RE = /(?:^|\n)\s*(?:\d+[.、)）]|[-*•])\s+/

function stripUnbalancedTrailingParens(urlToken: string): string {
  let out = urlToken
  while (out.length > 0) {
    const trimmedPunct = out.replace(TRAILING_URL_PUNCT_RE, '')
    if (trimmedPunct !== out) {
      out = trimmedPunct
      continue
    }
    if (out.endsWith(')')) {
      const opens = (out.match(/\(/g) ?? []).length
      const closes = (out.match(/\)/g) ?? []).length
      if (closes > opens) {
        out = out.slice(0, -1)
        continue
      }
    }
    break
  }
  return out
}

function resolveLinkPlatform(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '')
  if (h === 'mp.weixin.qq.com' || h.endsWith('.weixin.qq.com')) return '微信公众号'
  if (h === 'github.com' || h.endsWith('.github.com')) return 'GitHub'
  if (
    h === 'notion.so' ||
    h.endsWith('.notion.so') ||
    h.endsWith('.notion.site') ||
    h === 'notion.com' ||
    h.endsWith('.notion.com')
  ) {
    return 'Notion'
  }
  if (h.endsWith('.feishu.cn') || h === 'feishu.cn' || h.endsWith('.larkoffice.com')) return '飞书'
  if (h === 'bilibili.com' || h.endsWith('.bilibili.com') || h === 'b23.tv') return 'B站'
  if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'YouTube'
  if (h === 'x.com' || h === 'twitter.com') return 'X'
  if (h === 'zhihu.com' || h.endsWith('.zhihu.com')) return '知乎'
  if (h === 'xiaohongshu.com' || h.endsWith('.xiaohongshu.com') || h === 'xhslink.com') return '小红书'
  return h
}

function addExtractedUrl(
  rawUrl: string,
  links: JournalExtractedLink[],
  seen: Set<string>,
): boolean {
  const cleaned = stripUnbalancedTrailingParens(rawUrl.replace(TRAILING_URL_PUNCT_RE, ''))
  if (!cleaned) return false
  try {
    const parsed = new URL(cleaned)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const canonical = parsed.toString()
    if (!seen.has(canonical)) {
      seen.add(canonical)
      const host = parsed.hostname.replace(/^www\./, '')
      const pathPart = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
      const rawSuffix = `${pathPart}${parsed.search || ''}`
      const displayPath = rawSuffix.length > 36 ? `${rawSuffix.slice(0, 35)}…` : rawSuffix
      links.push({
        url: canonical,
        host,
        platform: resolveLinkPlatform(host),
        displayPath,
      })
    }
    return true
  } catch {
    return false
  }
}

/**
 * Extracts deduplicated http(s) links with platform metadata and produces a cleaned
 * `displayBody` with markdown links preserved as readable titles and bare URLs collapsed.
 */
export function extractJournalLinks(body: string): {
  links: JournalExtractedLink[]
  displayBody: string
} {
  const raw = String(body || '')
  if (!raw || !/https?:\/\//i.test(raw)) {
    return { links: [], displayBody: raw.trim() }
  }

  const links: JournalExtractedLink[] = []
  const seen = new Set<string>()

  // 1. Replace markdown links `[title](url)` with readable `title` while collecting `url`
  let stripped = raw.replace(MARKDOWN_LINK_RE, (full, label: string, rawUrl: string) => {
    return addExtractedUrl(rawUrl, links, seen) ? label : full
  })

  // 2. Collect remaining bare URLs while preserving balanced parens in URLs (e.g. Wikipedia)
  const matches = stripped.match(URL_EXTRACT_RE) ?? []
  for (const token of matches) {
    const cleaned = stripUnbalancedTrailingParens(token.replace(TRAILING_URL_PUNCT_RE, ''))
    if (!addExtractedUrl(cleaned, links, seen)) continue
    const escapedCleaned = cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Handle parenthesized bare URL `(https://...)` cleanly without leaving orphan `(`
    stripped = stripped.replace(new RegExp(`\\(${escapedCleaned}\\)[。，；、,;]*`), ' ')
    stripped = stripped.replace(new RegExp(`${escapedCleaned}[。，；、,;]*`), ' ')
  }

  const displayBody = stripped
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]*[，。；、:：]+[ \t]*/, '')
    .trim()

  return { links, displayBody }
}

function isBridgedNoteEntry(entry: JournalEntry): boolean {
  return (
    entry.kind === 'note' &&
    entry.images.length === 0 &&
    (entry.source === 'feishu' || entry.source === 'sentinellab-import')
  )
}

function isAutoMomentCandidate(entry: JournalEntry): boolean {
  if (!isBridgedNoteEntry(entry)) return false
  if (entry.category !== '生活' && entry.category !== '身体') return false
  const trimmed = entry.body.trim()
  if (!trimmed || trimmed.length > 32) return false
  if (countTextLines(trimmed) > 1) return false
  if (NUMBERED_LIST_RE.test(trimmed)) return false
  if (/https?:\/\//i.test(trimmed)) return false
  return true
}

function isLinkBookmarkCandidate(entry: JournalEntry): boolean {
  if (entry.images.length > 0) return false
  // Only auto-morph `note` entries into link-bookmark cards; explicit `thought` cards keep borderless style with native link strips
  if (entry.kind !== 'note') return false
  const { links, displayBody } = extractJournalLinks(entry.body)
  return links.length > 0 && displayBody.length <= 160
}

function isEditorialAutoThoughtCandidate(entry: JournalEntry): boolean {
  if (!isBridgedNoteEntry(entry)) return false
  if (isAutoMomentCandidate(entry) || isLinkBookmarkCandidate(entry)) return false
  const trimmed = entry.body.trim()
  if (!trimmed) return false
  if (NUMBERED_LIST_RE.test(trimmed)) return false
  return trimmed.length <= 95 && countTextLines(trimmed) <= 3
}

function resolveAutoPresentation(
  entry: JournalEntry,
  consecutiveBoxedCount: number,
): JournalCardPresentation {
  if (isLinkBookmarkCandidate(entry)) return 'link-bookmark'
  if (isAutoMomentCandidate(entry)) return 'auto-moment'
  if (isEditorialAutoThoughtCandidate(entry)) return 'editorial-thought'
  if (isBridgedNoteEntry(entry) && consecutiveBoxedCount >= 2) {
    return 'editorial-thought'
  }
  return 'default'
}

function isBoxedVisualPresentation(entry: JournalEntry, presentation: JournalCardPresentation): boolean {
  const species = resolveEffectiveCardKind(entry)
  if (species === 'thought' || species === 'moment' || species === 'ai' || species === 'photo') {
    return false
  }
  return presentation === 'default' || presentation === 'link-bookmark'
}

function isEditorialDuoEligible(entry: JournalEntry): boolean {
  if (entry.images.length > 0) return false
  if (isAutoMomentCandidate(entry)) return false
  const species = resolveEffectiveCardKind(entry)
  return species === 'note' || species === 'thought'
}

export type JournalDayLayoutItem = {
  entry: JournalEntry
  index: number
  groupKind: JournalLayoutGroupKind
  colStart: number
  colSpan: number
  rowStart: number
  rowSpan: number
  presentation: JournalCardPresentation
}

function countTextLines(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\r?\n/).length
}

function getEntryChronoValue(entry: Pick<JournalEntry, 'ts' | 'time'>): number | null {
  if (entry.ts) {
    const parsed = Date.parse(entry.ts)
    if (Number.isFinite(parsed)) return parsed
  }
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(entry.time?.trim() ?? '')
  if (timeMatch) {
    return Number(timeMatch[1]) * 60 + Number(timeMatch[2])
  }
  return null
}

function isChronologicallyMonotonic(entries: ReadonlyArray<Pick<JournalEntry, 'ts' | 'time'>>): boolean {
  const values = entries.map(getEntryChronoValue)
  if (values.some((v) => v === null)) return true
  const nums = values as number[]
  let nonDecreasing = true
  let nonIncreasing = true
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] < nums[i - 1]) nonDecreasing = false
    if (nums[i] > nums[i - 1]) nonIncreasing = false
  }
  return nonDecreasing || nonIncreasing
}

/**
 * Determines whether an entry qualifies as a compact short record for day-view grouping.
 * Reuses existing length thresholds while also guarding against multi-line bodies, images, and heavy metadata.
 */
export function isCompactShortEntry(entry: JournalEntry): boolean {
  const species = resolveEffectiveCardKind(entry)
  if (species === 'ai' || species === 'photo') return false
  if (entry.images.length > 0) return false

  const trimmed = entry.body.trim()
  const textLen = trimmed.length
  const lineCount = countTextLines(trimmed)
  if (lineCount > 2) return false
  if (entry.tags.length + entry.projectRefs.length > 2) return false

  if (species === 'moment' || species === 'judgment') {
    return textLen <= 45
  }
  if (species === 'thought' || species === 'note') {
    return textLen <= 40
  }
  return false
}

function isLongNoteEntry(entry: JournalEntry): boolean {
  return resolveEffectiveCardKind(entry) === 'note' && !isCompactShortEntry(entry)
}

function isPhotoEntry(entry: JournalEntry): boolean {
  return resolveEffectiveCardKind(entry) === 'photo'
}

function canUseCompactThoughtStyle(entry: JournalEntry): boolean {
  const species = resolveEffectiveCardKind(entry)
  return (species === 'note' || species === 'thought') && entry.images.length === 0
}

function canFormQuadPhotoRight(entries: readonly JournalEntry[], startIndex: number): boolean {
  if (startIndex + 3 >= entries.length) return false
  const e0 = entries[startIndex]
  const e1 = entries[startIndex + 1]
  const e2 = entries[startIndex + 2]
  const e3 = entries[startIndex + 3]

  // Natural reading order of the 4-entry bento block is:
  // top-left (longNote) -> right 2-row photo -> bottom-left (short 3 cols) -> bottom-middle (short 4 cols).
  // Any other permutation would visually jump reading order, so it falls back to 2-entry rules.
  if (!isLongNoteEntry(e0) || !isPhotoEntry(e1) || !isCompactShortEntry(e2) || !isCompactShortEntry(e3)) {
    return false
  }

  // Verify chronological monotonicity in natural reading order.
  if (!isChronologicallyMonotonic([e0, e1, e2, e3])) {
    return false
  }

  // Height balance guards:
  // - Photo on the right spans 2 rows best when it has a single image and a concise caption.
  // - Top-left long note should not be so tall that row 1 alone dwarfs the right photo.
  const noteTrimmed = e0.body.trim()
  if (e0.images.length > 0 || noteTrimmed.length > 180 || countTextLines(noteTrimmed) > 4) {
    return false
  }
  const photoTrimmed = e1.body.trim()
  if (e1.images.length !== 1 || photoTrimmed.length > 90 || countTextLines(photoTrimmed) > 3) {
    return false
  }

  return true
}

/**
 * Plans the 12-column day-view layout for consecutive visible entries by selecting
 * group layouts first (4-entry photo-span quad, 2-entry photo+note, 2-entry note+short,
 * AI full-width boundary, or single fallback) and assigning explicit column/row coordinates.
 */
export function planJournalDayLayout(entries: readonly JournalEntry[]): JournalDayLayoutItem[] {
  const items: JournalDayLayoutItem[] = []
  let i = 0
  let currentRow = 1
  let pendingRowCol = 1
  let consecutiveBoxedCount = 0

  const flushPendingRow = () => {
    if (pendingRowCol > 1) {
      currentRow += 1
      pendingRowCol = 1
    }
  }

  const updateBoxRun = (entry: JournalEntry, presentation: JournalCardPresentation) => {
    if (isBoxedVisualPresentation(entry, presentation)) {
      consecutiveBoxedCount += 1
    } else {
      consecutiveBoxedCount = 0
    }
  }

  while (i < entries.length) {
    const current = entries[i]
    const currentSpecies = resolveEffectiveCardKind(current)

    // AI summary is always full-width and acts as a hard group boundary.
    if (currentSpecies === 'ai') {
      flushPendingRow()
      items.push({
        entry: current,
        index: i,
        groupKind: 'ai-boundary',
        colStart: 1,
        colSpan: 12,
        rowStart: currentRow,
        rowSpan: 1,
        presentation: 'default',
      })
      consecutiveBoxedCount = 0
      currentRow += 1
      i += 1
      continue
    }

    // Priority 1: [longNote, photo, short, short] -> 7/5(2-row)/3/4 bento quad
    if (canFormQuadPhotoRight(entries, i)) {
      flushPendingRow()
      const e0 = entries[i]
      const e1 = entries[i + 1]
      const e2 = entries[i + 2]
      const e3 = entries[i + 3]

      const p2: JournalCardPresentation = isAutoMomentCandidate(e2)
        ? 'auto-moment'
        : canUseCompactThoughtStyle(e2)
          ? 'compact-thought'
          : 'default'
      const p3: JournalCardPresentation = isAutoMomentCandidate(e3)
        ? 'auto-moment'
        : canUseCompactThoughtStyle(e3)
          ? 'compact-thought'
          : 'default'

      items.push(
        {
          entry: e0,
          index: i,
          groupKind: 'quad-photo-right',
          colStart: 1,
          colSpan: 7,
          rowStart: currentRow,
          rowSpan: 1,
          presentation: 'default',
        },
        {
          entry: e1,
          index: i + 1,
          groupKind: 'quad-photo-right',
          colStart: 8,
          colSpan: 5,
          rowStart: currentRow,
          rowSpan: 2,
          presentation: 'default',
        },
        {
          entry: e2,
          index: i + 2,
          groupKind: 'quad-photo-right',
          colStart: 1,
          colSpan: 3,
          rowStart: currentRow + 1,
          rowSpan: 1,
          presentation: p2,
        },
        {
          entry: e3,
          index: i + 3,
          groupKind: 'quad-photo-right',
          colStart: 4,
          colSpan: 4,
          rowStart: currentRow + 1,
          rowSpan: 1,
          presentation: p3,
        },
      )

      consecutiveBoxedCount = 0
      currentRow += 2
      i += 4
      continue
    }

    // Priority 2: [photo, longNote] or [longNote, photo] -> 5/7 or 7/5 in original order
    if (i + 1 < entries.length) {
      const next = entries[i + 1]
      const isPhotoThenNote = isPhotoEntry(current) && isLongNoteEntry(next)
      const isNoteThenPhoto = isLongNoteEntry(current) && isPhotoEntry(next)
      if (isPhotoThenNote || isNoteThenPhoto) {
        flushPendingRow()
        const firstSpan = isPhotoThenNote ? 5 : 7
        const secondSpan = isPhotoThenNote ? 7 : 5
        const firstPres: JournalCardPresentation = isPhotoThenNote
          ? 'default'
          : isLinkBookmarkCandidate(current)
            ? 'link-bookmark'
            : 'default'
        const secondPres: JournalCardPresentation = isPhotoThenNote
          ? isLinkBookmarkCandidate(next)
            ? 'link-bookmark'
            : 'default'
          : 'default'
        items.push(
          {
            entry: current,
            index: i,
            groupKind: 'pair-photo-note',
            colStart: 1,
            colSpan: firstSpan,
            rowStart: currentRow,
            rowSpan: 1,
            presentation: firstPres,
          },
          {
            entry: next,
            index: i + 1,
            groupKind: 'pair-photo-note',
            colStart: firstSpan + 1,
            colSpan: secondSpan,
            rowStart: currentRow,
            rowSpan: 1,
            presentation: secondPres,
          },
        )
        consecutiveBoxedCount = isPhotoThenNote ? 1 : 0
        currentRow += 1
        i += 2
        continue
      }

      // Priority 3: [longNote, short] or [short, longNote] -> 8/4 or 4/8 in original order
      const isNoteThenShort = isLongNoteEntry(current) && isCompactShortEntry(next)
      const isShortThenNote = isCompactShortEntry(current) && isLongNoteEntry(next)
      if (isNoteThenShort || isShortThenNote) {
        flushPendingRow()
        const firstSpan = isNoteThenShort ? 8 : 4
        const secondSpan = isNoteThenShort ? 4 : 8
        const firstPres: JournalCardPresentation = isShortThenNote
          ? isAutoMomentCandidate(current)
            ? 'auto-moment'
            : canUseCompactThoughtStyle(current)
              ? 'compact-thought'
              : 'default'
          : isLinkBookmarkCandidate(current)
            ? 'link-bookmark'
            : isBridgedNoteEntry(current) && consecutiveBoxedCount >= 2
              ? 'editorial-thought'
              : 'default'
        const secondPres: JournalCardPresentation = isNoteThenShort
          ? isAutoMomentCandidate(next)
            ? 'auto-moment'
            : canUseCompactThoughtStyle(next)
              ? 'compact-thought'
              : 'default'
          : isLinkBookmarkCandidate(next)
            ? 'link-bookmark'
            : isBridgedNoteEntry(next) && consecutiveBoxedCount >= 2
              ? 'editorial-thought'
              : 'default'
        items.push(
          {
            entry: current,
            index: i,
            groupKind: 'pair-note-short',
            colStart: 1,
            colSpan: firstSpan,
            rowStart: currentRow,
            rowSpan: 1,
            presentation: firstPres,
          },
          {
            entry: next,
            index: i + 1,
            groupKind: 'pair-note-short',
            colStart: firstSpan + 1,
            colSpan: secondSpan,
            rowStart: currentRow,
            rowSpan: 1,
            presentation: secondPres,
          },
        )
        updateBoxRun(current, firstPres)
        updateBoxRun(next, secondPres)
        currentRow += 1
        i += 2
        continue
      }

      // Priority 3.5: Consecutive text entries that would otherwise wrap into half-empty single rows ->
      // pair cleanly into a 12-column editorial duo with contrasting paper/borderless rhythm.
      if (isEditorialDuoEligible(current) && isEditorialDuoEligible(next)) {
        const rawSpanA = classifyJournalCardSpan(current, i)
        const rawSpanB = classifyJournalCardSpan(next, i + 1)
        const hasBridged = isBridgedNoteEntry(current) || isBridgedNoteEntry(next)
        const shouldPairDuo =
          rawSpanA + rawSpanB > 12 ||
          (isBridgedNoteEntry(current) && isBridgedNoteEntry(next)) ||
          (hasBridged && rawSpanA + rawSpanB >= 10)

        if (shouldPairDuo) {
          flushPendingRow()
          const lenA = current.body.trim().length
          const lenB = next.body.trim().length
          let firstSpan = 6
          let secondSpan = 6
          if (lenA > lenB * 1.45 && lenA >= 120) {
            firstSpan = 7
            secondSpan = 5
          } else if (lenB > lenA * 1.45 && lenB >= 120) {
            firstSpan = 5
            secondSpan = 7
          }

          let presA = resolveAutoPresentation(current, consecutiveBoxedCount)
          const boxesAfterA = isBoxedVisualPresentation(current, presA) ? consecutiveBoxedCount + 1 : 0
          let presB = resolveAutoPresentation(next, boxesAfterA)

          const aBoxed = isBoxedVisualPresentation(current, presA)
          const bBoxed = isBoxedVisualPresentation(next, presB)
          const aBridged = isBridgedNoteEntry(current)
          const bBridged = isBridgedNoteEntry(next)

          // Maintain paper-vs-editorial visual contrast inside every editorial duo:
          // 1) Never place two visually boxed cards side-by-side when a non-bookmark bridged note can lighten.
          // 2) Never place two visually borderless cards side-by-side when one is an auto-lightened bridged note
          //    next to an explicit `thought` (or two substantial `editorial-thought`s).
          if (aBoxed && bBoxed) {
            const aCanLighten = aBridged && presA !== 'link-bookmark'
            const bCanLighten = bBridged && presB !== 'link-bookmark'
            if (aCanLighten && bCanLighten) {
              if (lenA < lenB) {
                presA = 'editorial-thought'
              } else {
                presB = 'editorial-thought'
              }
            } else if (bCanLighten) {
              presB = 'editorial-thought'
            } else if (aCanLighten) {
              presA = 'editorial-thought'
            }
          } else if (!aBoxed && !bBoxed) {
            if (presA === 'editorial-thought' && presB === 'editorial-thought') {
              if (lenA >= lenB && lenA >= 80) {
                presA = 'default'
              } else if (lenB > lenA && lenB >= 80) {
                presB = 'default'
              }
            } else if (presA === 'editorial-thought') {
              presA = 'default'
            } else if (presB === 'editorial-thought') {
              presB = 'default'
            }
          }

          items.push(
            {
              entry: current,
              index: i,
              groupKind: 'pair-editorial-duo',
              colStart: 1,
              colSpan: firstSpan,
              rowStart: currentRow,
              rowSpan: 1,
              presentation: presA,
            },
            {
              entry: next,
              index: i + 1,
              groupKind: 'pair-editorial-duo',
              colStart: firstSpan + 1,
              colSpan: secondSpan,
              rowStart: currentRow,
              rowSpan: 1,
              presentation: presB,
            },
          )
          updateBoxRun(current, presA)
          updateBoxRun(next, presB)
          currentRow += 1
          i += 2
          continue
        }
      }
    }

    // Priority 4: Remaining entries use existing single-card span rules in strict order (no dense backfill).
    const presentation = resolveAutoPresentation(current, consecutiveBoxedCount)
    const span =
      presentation === 'auto-moment'
        ? 4
        : presentation === 'link-bookmark'
          ? 6
          : classifyJournalCardSpan(current, i)
    if (pendingRowCol + span - 1 > 12) {
      currentRow += 1
      pendingRowCol = 1
    }
    items.push({
      entry: current,
      index: i,
      groupKind: 'single',
      colStart: pendingRowCol,
      colSpan: span,
      rowStart: currentRow,
      rowSpan: 1,
      presentation,
    })
    updateBoxRun(current, presentation)
    pendingRowCol += span
    if (pendingRowCol > 12) {
      currentRow += 1
      pendingRowCol = 1
    }
    i += 1
  }

  return items
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
  // First match known workspace project names directly (supports spaces / CJK brackets like `【Mitchi Sentinel】AgentOS`)
  const sortedKnownProjects = [...knownProjects]
    .filter((p) => p.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length)
  let remainingForMentions = withoutUrls
  for (const project of sortedKnownProjects) {
    const escaped = project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const knownRe = new RegExp(`(^|[\\s，。！？、；：(\\[])@${escaped}(?=$|[\\s，。！？、；：)\\]])`, 'gi')
    if (knownRe.test(remainingForMentions)) {
      if (!seenProjects.has(project.name)) {
        seenProjects.add(project.name)
        projectRefs.push(project.name)
      }
      remainingForMentions = remainingForMentions.replace(knownRe, '$1 ')
    }
  }

  const mentionRegex = /(?:^|[\s，。！？、；：(\[])@([\p{L}\p{N}_.-]{1,64})/gu
  for (const match of remainingForMentions.matchAll(mentionRegex)) {
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

export const WEEK_VIEW_MAX_VISIBLE_ENTRIES = 12

export function sliceWeekDayEntries<T>(
  entries: readonly T[],
  maxVisible = WEEK_VIEW_MAX_VISIBLE_ENTRIES,
): { visible: T[]; overflowCount: number } {
  const limit = Math.max(0, maxVisible)
  if (entries.length <= limit) {
    return { visible: [...entries], overflowCount: 0 }
  }
  return {
    visible: entries.slice(0, limit),
    overflowCount: entries.length - limit,
  }
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

export type JournalBodyCollapsePolicy = {
  collapsible: boolean
  collapsedLines: number
}

export const NOTE_COLLAPSE_CHAR_THRESHOLD = 180
export const NOTE_COLLAPSE_LINE_THRESHOLD = 6
export const NOTE_COLLAPSED_LINES = 5

export const THOUGHT_COLLAPSE_CHAR_THRESHOLD = 420
export const THOUGHT_COLLAPSE_LINE_THRESHOLD = 12
export const THOUGHT_COLLAPSED_LINES = 10

/**
 * Determines whether a day-view card body should start collapsed with a bottom expand/collapse toggle:
 * - Boxed `note` cards collapse once past the standard long-text threshold (180 chars or 6 lines).
 * - Borderless `thought` cards use a relaxed threshold (420 chars or 12 lines) so only extra-long thoughts fold.
 * - All other card species and compact-short cards stay expanded.
 */
export function resolveJournalBodyCollapsePolicy(
  entry: Pick<JournalEntry, 'kind' | 'body' | 'images'>,
  presentation: JournalCardPresentation = 'default',
): JournalBodyCollapsePolicy {
  if (presentation === 'compact-thought' || presentation === 'auto-moment') {
    return { collapsible: false, collapsedLines: 0 }
  }
  const species = resolveEffectiveCardKind(entry)
  const trimmed = entry.body.trim()
  if (!trimmed) {
    return { collapsible: false, collapsedLines: 0 }
  }
  const textLen = trimmed.length
  const lineCount = countTextLines(trimmed)

  if (presentation === 'editorial-thought') {
    if (textLen > 240 || lineCount > 7) {
      return { collapsible: true, collapsedLines: 6 }
    }
    return { collapsible: false, collapsedLines: 0 }
  }

  if (presentation === 'link-bookmark') {
    const { displayBody } = extractJournalLinks(trimmed)
    if (displayBody.length > 220 || countTextLines(displayBody) > 6) {
      return { collapsible: true, collapsedLines: 5 }
    }
    return { collapsible: false, collapsedLines: 0 }
  }

  if (species === 'note') {
    if (textLen > NOTE_COLLAPSE_CHAR_THRESHOLD || lineCount > NOTE_COLLAPSE_LINE_THRESHOLD) {
      return { collapsible: true, collapsedLines: NOTE_COLLAPSED_LINES }
    }
    return { collapsible: false, collapsedLines: 0 }
  }

  if (species === 'thought') {
    if (textLen > THOUGHT_COLLAPSE_CHAR_THRESHOLD || lineCount > THOUGHT_COLLAPSE_LINE_THRESHOLD) {
      return { collapsible: true, collapsedLines: THOUGHT_COLLAPSED_LINES }
    }
    return { collapsible: false, collapsedLines: 0 }
  }

  return { collapsible: false, collapsedLines: 0 }
}

export type JournalPhotoOrientation = 'portrait' | 'landscape' | 'square'

export function resolvePhotoOrientation(width?: number, height?: number): JournalPhotoOrientation {
  if (!width || !height || width <= 0 || height <= 0) {
    return 'landscape'
  }
  if (height > width) return 'portrait'
  if (width > height) return 'landscape'
  return 'square'
}

/** True when `selectedDate` (`YYYY-MM-DD`) is strictly after `todayDate` (`YYYY-MM-DD`). */
export function isFutureJournalDate(selectedDate: string, todayDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || !/^\d{4}-\d{2}-\d{2}$/.test(todayDate)) {
    return false
  }
  return selectedDate > todayDate
}

/**
 * Legacy SentinelLab history sync only makes sense for today or historical dates;
 * future dates must never display the legacy import CTA.
 */
export function shouldShowLegacySyncButton(
  selectedDate: string,
  todayDate: string,
  legacyDbAvailable?: boolean,
): boolean {
  if (!legacyDbAvailable) return false
  return !isFutureJournalDate(selectedDate, todayDate)
}

