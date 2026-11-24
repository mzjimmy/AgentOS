/**
 * 主窗口尺寸与位置持久化（支持多屏断连兜底、最大化还原与防抖保存）。
 * Persists main BrowserWindow bounds in userData/main-window-bounds.json.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type Rect = {
  x: number
  y: number
  width: number
  height: number
}

export type DisplayWorkArea = {
  workArea: Rect
}

export type MainWindowBoundsState = {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

export type ResolvedWindowBounds = {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
}

export type TrackableBrowserWindow = {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  getBounds(): Rect
  getNormalBounds?: () => Rect
  maximize(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export const MAIN_WINDOW_BOUNDS_FILE = 'main-window-bounds.json'
export const DEFAULT_MAIN_WINDOW_WIDTH = 1280
export const DEFAULT_MAIN_WINDOW_HEIGHT = 820
export const MIN_MAIN_WINDOW_WIDTH = 640
export const MIN_MAIN_WINDOW_HEIGHT = 480

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(Math.round(value), min), max)
}

function intersectionArea(a: Rect, b: Rect): { width: number; height: number } {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return {
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

export function normalizeStoredBounds(raw: unknown): MainWindowBoundsState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isFiniteInt(o.width) || !isFiniteInt(o.height)) return null
  const width = Math.round(o.width)
  const height = Math.round(o.height)
  if (width < MIN_MAIN_WINDOW_WIDTH || height < MIN_MAIN_WINDOW_HEIGHT) return null
  const hasPos = isFiniteInt(o.x) && isFiniteInt(o.y)
  return {
    width,
    height,
    ...(hasPos ? { x: Math.round(o.x as number), y: Math.round(o.y as number) } : {}),
    ...(o.isMaximized === true ? { isMaximized: true } : {}),
  }
}

export function resolveInitialMainWindowBounds(
  stored: MainWindowBoundsState | null,
  displays: ReadonlyArray<DisplayWorkArea>,
  primaryDisplay?: DisplayWorkArea,
): ResolvedWindowBounds {
  const primaryWorkArea = primaryDisplay?.workArea ?? displays[0]?.workArea ?? null

  if (!stored) {
    if (!primaryWorkArea) {
      return {
        width: DEFAULT_MAIN_WINDOW_WIDTH,
        height: DEFAULT_MAIN_WINDOW_HEIGHT,
        isMaximized: false,
      }
    }
    return {
      width: clamp(DEFAULT_MAIN_WINDOW_WIDTH, MIN_MAIN_WINDOW_WIDTH, primaryWorkArea.width),
      height: clamp(DEFAULT_MAIN_WINDOW_HEIGHT, MIN_MAIN_WINDOW_HEIGHT, primaryWorkArea.height),
      isMaximized: false,
    }
  }

  // Find the display with the largest visible overlap if saved coordinates exist
  if (typeof stored.x === 'number' && typeof stored.y === 'number' && displays.length > 0) {
    const savedRect: Rect = {
      x: stored.x,
      y: stored.y,
      width: stored.width,
      height: stored.height,
    }
    let bestDisplay: DisplayWorkArea | null = null
    let bestArea = 0
    for (const display of displays) {
      const overlap = intersectionArea(savedRect, display.workArea)
      const titlebarVisible =
        savedRect.y >= display.workArea.y - 24 && savedRect.y <= display.workArea.y + display.workArea.height - 60
      if (overlap.width >= 120 && overlap.height >= 80 && titlebarVisible) {
        const area = overlap.width * overlap.height
        if (area > bestArea) {
          bestArea = area
          bestDisplay = display
        }
      }
    }

    if (bestDisplay) {
      const wa = bestDisplay.workArea
      const width = clamp(stored.width, MIN_MAIN_WINDOW_WIDTH, wa.width)
      const height = clamp(stored.height, MIN_MAIN_WINDOW_HEIGHT, wa.height)
      const x = clamp(stored.x, wa.x, wa.x + wa.width - width)
      const y = clamp(stored.y, wa.y, wa.y + wa.height - height)
      return {
        width,
        height,
        x,
        y,
        isMaximized: stored.isMaximized === true,
      }
    }
  }

  // Off-screen or no displays available: preserve preferred size clamped to primary workArea, let OS center
  const width = primaryWorkArea
    ? clamp(stored.width, MIN_MAIN_WINDOW_WIDTH, primaryWorkArea.width)
    : Math.max(MIN_MAIN_WINDOW_WIDTH, stored.width)
  const height = primaryWorkArea
    ? clamp(stored.height, MIN_MAIN_WINDOW_HEIGHT, primaryWorkArea.height)
    : Math.max(MIN_MAIN_WINDOW_HEIGHT, stored.height)

  return {
    width,
    height,
    isMaximized: stored.isMaximized === true,
  }
}

export class MainWindowBoundsStore {
  readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, MAIN_WINDOW_BOUNDS_FILE)
  }

  read(): MainWindowBoundsState | null {
    if (!existsSync(this.filePath)) return null
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return normalizeStoredBounds(raw)
    } catch {
      return null
    }
  }

  save(state: MainWindowBoundsState): MainWindowBoundsState | null {
    const normalized = normalizeStoredBounds(state)
    if (!normalized) return null
    mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, this.filePath)
    return normalized
  }
}

export function attachMainWindowBoundsPersistence(
  win: TrackableBrowserWindow,
  store: MainWindowBoundsStore,
  initialResolved: ResolvedWindowBounds,
  debounceMs = 250,
): { flushNow: () => void; dispose: () => void } {
  let lastNormalBounds: Rect | null =
    typeof initialResolved.x === 'number' && typeof initialResolved.y === 'number'
      ? {
          x: initialResolved.x,
          y: initialResolved.y,
          width: initialResolved.width,
          height: initialResolved.height,
        }
      : {
          x: 0,
          y: 0,
          width: initialResolved.width,
          height: initialResolved.height,
        }
  let hasKnownPosition = typeof initialResolved.x === 'number' && typeof initialResolved.y === 'number'
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const captureCurrentState = (): MainWindowBoundsState | null => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return null
    const maximized = win.isMaximized()
    if (!maximized) {
      const bounds = win.getBounds()
      if (bounds.width >= MIN_MAIN_WINDOW_WIDTH && bounds.height >= MIN_MAIN_WINDOW_HEIGHT) {
        lastNormalBounds = { ...bounds }
        hasKnownPosition = true
      }
      return lastNormalBounds
        ? {
            width: lastNormalBounds.width,
            height: lastNormalBounds.height,
            ...(hasKnownPosition ? { x: lastNormalBounds.x, y: lastNormalBounds.y } : {}),
            isMaximized: false,
          }
        : null
    }

    const normal = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : lastNormalBounds
    if (normal && normal.width >= MIN_MAIN_WINDOW_WIDTH && normal.height >= MIN_MAIN_WINDOW_HEIGHT) {
      lastNormalBounds = { ...normal }
      hasKnownPosition = true
    }
    if (!lastNormalBounds) return null
    return {
      width: lastNormalBounds.width,
      height: lastNormalBounds.height,
      ...(hasKnownPosition ? { x: lastNormalBounds.x, y: lastNormalBounds.y } : {}),
      isMaximized: true,
    }
  }

  const flushNow = () => {
    if (disposed) return
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const state = captureCurrentState()
    if (state) {
      try {
        store.save(state)
      } catch {
        /* ignore transient disk write error */
      }
    }
  }

  const scheduleSave = () => {
    if (disposed) return
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushNow()
    }, debounceMs)
  }

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)
  win.on('close', flushNow)
  win.on('hide', flushNow)
  win.on('closed', () => {
    disposed = true
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  })

  if (initialResolved.isMaximized && !win.isDestroyed()) {
    win.maximize()
  }

  return {
    flushNow,
    dispose: () => {
      disposed = true
      if (saveTimer !== null) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
    },
  }
}
