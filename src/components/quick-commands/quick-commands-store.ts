/**
 * Renderer-only Quick Commands store.
 * Persistence is an envelope in localStorage; an explicit empty list is durable
 * and must not resurrect starter commands.
 */

import {
  DEFAULT_STARTER_COMMANDS,
  QUICK_COMMAND_CATEGORIES,
  QUICK_COMMANDS_SCHEMA_VERSION,
  QUICK_COMMANDS_STORAGE_KEY,
  type QuickCommandCategory,
  type QuickCommandDraftInput,
  type QuickCommandFilter,
  type QuickCommandItem,
  type QuickCommandSendReadiness,
  type QuickCommandStorageLike,
} from '../../quick-commands-contract'

export type QuickCommandClock = {
  now?: () => string
  createId?: () => string
}

function nowIso(clock?: QuickCommandClock): string {
  return clock?.now?.() ?? new Date().toISOString()
}

export function normalizeQuickCommandCategory(value: unknown): QuickCommandCategory {
  return QUICK_COMMAND_CATEGORIES.includes(value as QuickCommandCategory)
    ? (value as QuickCommandCategory)
    : 'other'
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStoredItem(value: unknown, clock?: QuickCommandClock): QuickCommandItem | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = readText(record.id)
  const title = readText(record.title)
  const body = readText(record.body)
  if (!id || !title || !body) return null
  const createdAt = readText(record.createdAt) || nowIso(clock)
  const updatedAt = readText(record.updatedAt) || createdAt
  const lastUsedAt = readText(record.lastUsedAt) || null
  const useCount = typeof record.useCount === 'number' && Number.isFinite(record.useCount)
    ? Math.max(0, Math.floor(record.useCount))
    : 0
  return {
    id,
    title,
    body,
    category: normalizeQuickCommandCategory(record.category),
    pinned: record.pinned === true,
    createdAt,
    updatedAt,
    lastUsedAt,
    useCount,
  }
}

function recoverItems(raw: string, clock?: QuickCommandClock): QuickCommandItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const items = (parsed as { items?: unknown }).items
    if (!Array.isArray(items)) return []
    const seen = new Set<string>()
    const recovered: QuickCommandItem[] = []
    for (const entry of items) {
      const item = normalizeStoredItem(entry, clock)
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      recovered.push(item)
    }
    return recovered
  } catch {
    return []
  }
}

function writeEnvelope(storage: QuickCommandStorageLike, items: readonly QuickCommandItem[]): boolean {
  const envelope = {
    version: QUICK_COMMANDS_SCHEMA_VERSION,
    items,
  }
  try {
    storage.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(envelope))
    return true
  } catch {
    return false
  }
}

function materializeDraft(draft: QuickCommandDraftInput, id: string, now: string): QuickCommandItem {
  return {
    id,
    title: draft.title.trim(),
    body: draft.body.trim(),
    category: normalizeQuickCommandCategory(draft.category),
    pinned: draft.pinned === true,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
  }
}

/**
 * Load the envelope. A missing key seeds starters once; a present key never reseeds
 * and never destructively overwrites unreadable/future-schema payloads on read.
 */
export function loadQuickCommands(
  storage: QuickCommandStorageLike,
  clock?: QuickCommandClock,
): QuickCommandItem[] {
  let raw: string | null = null
  try {
    raw = storage.getItem(QUICK_COMMANDS_STORAGE_KEY)
  } catch {
    return []
  }
  if (raw == null) {
    const now = nowIso(clock)
    const seeded = DEFAULT_STARTER_COMMANDS.map((draft, index) => materializeDraft(
      draft,
      `qc-starter-${index + 1}`,
      now,
    ))
    writeEnvelope(storage, seeded)
    return seeded
  }
  return recoverItems(raw, clock)
}

/** Persist items exactly. An empty array stays empty across reloads. Returns false if storage write fails. */
export function saveQuickCommands(
  storage: QuickCommandStorageLike,
  items: readonly QuickCommandItem[],
): boolean {
  const normalized: QuickCommandItem[] = []
  const seen = new Set<string>()
  for (const entry of items) {
    const item = normalizeStoredItem(entry)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    normalized.push(item)
  }
  return writeEnvelope(storage, normalized)
}

export type QuickCommandRejectReason = 'blank_title' | 'blank_body' | 'not_found'

export type QuickCommandMutationResult =
  | { ok: true; items: QuickCommandItem[]; item: QuickCommandItem }
  | { ok: false; reason: QuickCommandRejectReason }

let fallbackSequence = 0

function nextId(clock?: QuickCommandClock): string {
  if (clock?.createId) return clock.createId()
  fallbackSequence += 1
  const entropy = Math.random().toString(36).slice(2, 8)
  return `qc-${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${entropy}`
}

export function createQuickCommand(
  items: readonly QuickCommandItem[],
  input: QuickCommandDraftInput,
  clock?: QuickCommandClock,
): QuickCommandMutationResult {
  const title = readText(input.title)
  const body = readText(input.body)
  if (!title) return { ok: false, reason: 'blank_title' }
  if (!body) return { ok: false, reason: 'blank_body' }
  const item = materializeDraft({ ...input, title, body }, nextId(clock), nowIso(clock))
  return { ok: true, item, items: [...items, item] }
}

export function updateQuickCommand(
  items: readonly QuickCommandItem[],
  id: string,
  input: Partial<QuickCommandDraftInput>,
  clock?: QuickCommandClock,
): QuickCommandMutationResult {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return { ok: false, reason: 'not_found' }
  const current = items[index]
  const title = input.title === undefined ? current.title : readText(input.title)
  const body = input.body === undefined ? current.body : readText(input.body)
  if (!title) return { ok: false, reason: 'blank_title' }
  if (!body) return { ok: false, reason: 'blank_body' }
  const item: QuickCommandItem = {
    ...current,
    title,
    body,
    category: input.category === undefined ? current.category : normalizeQuickCommandCategory(input.category),
    pinned: input.pinned === undefined ? current.pinned : input.pinned === true,
    updatedAt: nowIso(clock),
  }
  const next = items.slice()
  next[index] = item
  return { ok: true, item, items: next }
}

export function togglePinQuickCommand(
  items: readonly QuickCommandItem[],
  id: string,
  clock?: QuickCommandClock,
): QuickCommandItem[] {
  const now = nowIso(clock)
  return items.map((item) => (
    item.id === id ? { ...item, pinned: !item.pinned, updatedAt: now } : item
  ))
}

export function recordCommandUsage(
  items: readonly QuickCommandItem[],
  id: string,
  clock?: QuickCommandClock,
): QuickCommandItem[] {
  const now = nowIso(clock)
  return items.map((item) => (
    item.id === id ? { ...item, useCount: item.useCount + 1, lastUsedAt: now } : item
  ))
}

/**
 * Re-reads storage before incrementing usage so an async send completing across
 * remounts or concurrent edits never clobbers newer commands in localStorage.
 */
export function recordCommandUsageInStorage(
  storage: QuickCommandStorageLike,
  id: string,
  clock?: QuickCommandClock,
): { items: QuickCommandItem[]; saved: boolean } {
  const latest = loadQuickCommands(storage, clock)
  if (!latest.some((entry) => entry.id === id)) {
    return { items: latest, saved: true }
  }
  const next = recordCommandUsage(latest, id, clock)
  const saved = saveQuickCommands(storage, next)
  return { items: next, saved }
}

export function deleteQuickCommand(
  items: readonly QuickCommandItem[],
  id: string,
): QuickCommandItem[] {
  return items.filter((item) => item.id !== id)
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function compareTimestampDesc(left: string, right: string): number {
  const leftMs = parseTimestampMs(left)
  const rightMs = parseTimestampMs(right)
  if (leftMs !== null && rightMs !== null) {
    if (rightMs !== leftMs) return rightMs - leftMs
    return 0
  }
  return right.localeCompare(left)
}

function recencyKey(item: QuickCommandItem): string {
  if (!item.lastUsedAt) return item.updatedAt
  return compareTimestampDesc(item.lastUsedAt, item.updatedAt) <= 0
    ? item.lastUsedAt
    : item.updatedAt
}

/** Pinned commands first. Within each group, the latest use or edit comes first. */
export function filterAndSortQuickCommands(
  items: readonly QuickCommandItem[],
  filter: QuickCommandFilter = {},
): QuickCommandItem[] {
  const category = filter.category && filter.category !== 'all' ? filter.category : null
  const query = filter.query?.trim().toLocaleLowerCase() ?? ''
  const matched = items.filter((item) => {
    if (category && item.category !== category) return false
    if (!query) return true
    const haystack = `${item.title}\n${item.body}`.toLocaleLowerCase()
    return haystack.includes(query)
  })
  return matched
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.pinned !== right.item.pinned) return left.item.pinned ? -1 : 1
      const byRecency = compareTimestampDesc(recencyKey(left.item), recencyKey(right.item))
      if (byRecency !== 0) return byRecency
      return left.index - right.index
    })
    .map((entry) => entry.item)
}

export function resolveCommandSendState(
  project: { id?: string | null; name?: string | null } | null | undefined,
): QuickCommandSendReadiness {
  const projectId = readText(project?.id)
  if (!projectId) return { canSend: false, reason: 'no_active_project' }
  const projectName = readText(project?.name) || projectId
  return { canSend: true, projectId, projectName }
}

export type CopyQuickCommandDeps = {
  writeText?: (value: string) => Promise<void> | void
  fallbackWrite?: (value: string) => boolean
}

export type CopyQuickCommandResult =
  | { ok: true; via: 'clipboard' | 'fallback' }
  | { ok: false; reason: 'empty' | 'copy_failed' }

/** Copy helper with an injectable clipboard. The text is copied as given. */
export async function copyQuickCommandText(
  text: string,
  deps: CopyQuickCommandDeps = {},
): Promise<CopyQuickCommandResult> {
  if (!text.trim()) return { ok: false, reason: 'empty' }
  if (deps.writeText) {
    try {
      await deps.writeText(text)
      return { ok: true, via: 'clipboard' }
    } catch {
      /* fall through */
    }
  }
  if (deps.fallbackWrite?.(text)) return { ok: true, via: 'fallback' }
  return { ok: false, reason: 'copy_failed' }
}
