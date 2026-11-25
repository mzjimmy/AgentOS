/**
 * Frozen contract, pure state helpers, and global session bus for the unified
 * SentinelDesk playback bar (`DeskAudioBar` — Option 1: editorial inline bar +
 * zero-layout-shift overlay sticky strip + shared cross-page mini-player).
 *
 * Intentionally imports ZERO base AgentOS modules so any SentinelDesk page can
 * adopt it without widening the import-boundary ratchet.
 */

export const DESK_AUDIO_SPEED_STEPS = [0.85, 1.0, 1.25, 1.5, 1.75, 2.0] as const

/** Inline bar must completely clear the scroll viewport top before sticky strip enters. */
export const DESK_AUDIO_STICKY_ENTER_PX = 0

/** At least 28px of the inline bar must re-enter view before sticky strip hides (deadband prevents flicker). */
export const DESK_AUDIO_STICKY_EXIT_PX = 28

export type DeskAudioSurfaceVariant = 'inset' | 'card'

export type DeskAudioBarLabels = {
  play?: string
  pause?: string
  prev?: string
  next?: string
  speed?: string
  loopOn?: string
  loopOff?: string
  stop?: string
}

export type DeskAudioStickyParams = {
  /** Current sticky visibility state before this evaluation. */
  prevVisible: boolean
  /** True only while playback is active or synthesizing. */
  active: boolean
  /**
   * Bottom edge of the inline audio bar relative to the scroll container's top edge
   * (`inlineRect.bottom - scrollRect.top`), or `null` when unavailable.
   */
  anchorBottomOffsetPx: number | null
  enterThresholdPx?: number
  exitThresholdPx?: number
}

export type DeskAudioSession = {
  /** Unique source identifier (e.g. 'morning-brief', 'language-push'). */
  sourceId: string
  /** Target SentinelDesk view id used to hide mini-player on the owner view and jump back on click. */
  viewId: string
  title: string
  subtitle: string
  currentIndex: number
  total: number
  elapsedSec: number
  playbackRate: number
  isPlaying: boolean
  isBusy: boolean
  onStop: () => void
  onCycleSpeed?: () => void
  onNavigate?: () => void
}

export type DeskAudioSessionPatch = Partial<
  Omit<DeskAudioSession, 'sourceId' | 'viewId' | 'onStop'>
> & {
  onStop?: () => void
}

/** Formats elapsed seconds as `MM:SS` (clamps negative/NaN/Infinity to `00:00`). */
export function formatDeskAudioClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
  const safe = Math.floor(seconds)
  const m = String(Math.floor(safe / 60)).padStart(2, '0')
  const s = String(safe % 60).padStart(2, '0')
  return `${m}:${s}`
}

/**
 * Formats playback rate cleanly without stripping the tenth zero on whole numbers:
 * `1 -> "1.0x"`, `2 -> "2.0x"`, `1.5 -> "1.5x"`, `0.85 -> "0.85x"`, `1.25 -> "1.25x"`.
 */
export function formatDeskAudioSpeed(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '1.0x'
  const rounded = Math.round(rate * 100) / 100
  if (Number.isInteger(rounded)) return `${rounded.toFixed(1)}x`
  const fixed = rounded.toFixed(2)
  return `${fixed.endsWith('0') ? fixed.slice(0, -1) : fixed}x`
}

/** Cycles to the next playback speed in `steps` (handles off-grid rates like `0.95` smoothly). */
export function cycleDeskAudioSpeed(
  current: number,
  steps: readonly number[] = DESK_AUDIO_SPEED_STEPS,
): number {
  if (steps.length === 0) return 1.0
  if (!Number.isFinite(current) || current <= 0) {
    return steps.includes(1.0) ? 1.0 : steps[0]
  }
  const exactIdx = steps.findIndex((step) => Math.abs(step - current) < 1e-6)
  if (exactIdx >= 0) {
    return steps[(exactIdx + 1) % steps.length]
  }
  const nextAbove = steps.find((step) => step > current + 1e-6)
  return nextAbove ?? steps[0]
}

/** Computes clamped 0..100 section/item progress percentage. */
export function computeDeskAudioProgressPct(activeIndex: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(activeIndex) || activeIndex < 0) {
    return 0
  }
  const pct = Math.round(((activeIndex + 1) / total) * 100)
  return Math.max(0, Math.min(100, pct))
}

/**
 * Pure Schmitt-trigger hysteresis state machine for the overlay sticky strip.
 * Eliminates boundary oscillation when the inline bar is half-covered.
 */
export function computeDeskAudioStickyVisible(params: DeskAudioStickyParams): boolean {
  const {
    prevVisible,
    active,
    anchorBottomOffsetPx,
    enterThresholdPx = DESK_AUDIO_STICKY_ENTER_PX,
    exitThresholdPx = DESK_AUDIO_STICKY_EXIT_PX,
  } = params
  if (!active || anchorBottomOffsetPx === null || !Number.isFinite(anchorBottomOffsetPx)) {
    return false
  }
  if (!prevVisible) {
    return anchorBottomOffsetPx <= enterThresholdPx
  }
  return anchorBottomOffsetPx < exitThresholdPx
}

export type DeskAudioStickyScrollElement = {
  firstElementChild?: unknown
  getBoundingClientRect: () => { top: number }
  addEventListener: (
    type: 'scroll',
    listener: () => void,
    options?: { passive?: boolean },
  ) => void
  removeEventListener: (type: 'scroll', listener: () => void) => void
}

export type DeskAudioStickyAnchorElement = {
  getBoundingClientRect: () => { bottom: number }
}

export type DeskAudioStickyResizeObserverLike = {
  observe: (target: unknown) => void
  disconnect: () => void
}

export type AttachDeskAudioStickyObserverParams = {
  scrollEl: DeskAudioStickyScrollElement
  anchorEl: DeskAudioStickyAnchorElement
  onChange: (visible: boolean) => void
  enterThresholdPx?: number
  exitThresholdPx?: number
  ResizeObserverCtor?: new (callback: () => void) => DeskAudioStickyResizeObserverLike
  requestAnimationFrameFn?: (cb: () => void) => number
  cancelAnimationFrameFn?: (id: number) => void
}

/**
 * Pure, testable lifecycle binding for `useDeskAudioSticky`.
 * Observes scroll (passive + rAF coalesced) plus `ResizeObserver` on `scrollEl`,
 * `anchorEl`, and `scrollEl.firstElementChild` (catching position-only shifts when
 * banners or cards appear/disappear above the inline bar).
 */
export function attachDeskAudioStickyObserver(
  params: AttachDeskAudioStickyObserverParams,
): () => void {
  const {
    scrollEl,
    anchorEl,
    onChange,
    enterThresholdPx = DESK_AUDIO_STICKY_ENTER_PX,
    exitThresholdPx = DESK_AUDIO_STICKY_EXIT_PX,
    ResizeObserverCtor,
    requestAnimationFrameFn,
    cancelAnimationFrameFn,
  } = params

  let prevVisible = false
  let emittedOnce = false
  let rafId: number | null = null

  const measure = () => {
    rafId = null
    const offset = anchorEl.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top
    const next = computeDeskAudioStickyVisible({
      prevVisible,
      active: true,
      anchorBottomOffsetPx: offset,
      enterThresholdPx,
      exitThresholdPx,
    })
    if (!emittedOnce || next !== prevVisible) {
      emittedOnce = true
      prevVisible = next
      onChange(next)
    }
  }

  const scheduleMeasure = () => {
    if (rafId !== null) return
    if (requestAnimationFrameFn) {
      rafId = requestAnimationFrameFn(measure)
    } else {
      measure()
    }
  }

  measure()
  scrollEl.addEventListener('scroll', scheduleMeasure, { passive: true })

  let resizeObserver: DeskAudioStickyResizeObserverLike | null = null
  if (ResizeObserverCtor) {
    resizeObserver = new ResizeObserverCtor(scheduleMeasure)
    resizeObserver.observe(scrollEl)
    resizeObserver.observe(anchorEl)
    if (scrollEl.firstElementChild) {
      resizeObserver.observe(scrollEl.firstElementChild)
    }
  }

  return () => {
    scrollEl.removeEventListener('scroll', scheduleMeasure)
    resizeObserver?.disconnect()
    if (rafId !== null && cancelAnimationFrameFn) {
      cancelAnimationFrameFn(rafId)
      rafId = null
    }
  }
}

type BusListener = () => void

/**
 * Global single-active audio session bus for SentinelDesk.
 * Claiming a new source automatically stops the previously active source and updates
 * the shared cross-page mini-player (`DeskAudioMiniPlayer`).
 */
export class DeskAudioSessionBus {
  private session: DeskAudioSession | null = null
  private readonly listeners = new Set<BusListener>()

  getSnapshot = (): DeskAudioSession | null => this.session

  subscribe = (listener: BusListener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  claim(next: DeskAudioSession): void {
    const prev = this.session
    this.session = { ...next }
    if (prev && prev.sourceId !== next.sourceId) {
      try {
        prev.onStop()
      } catch {
        /* ignore */
      }
    }
    this.emit()
  }

  update(sourceId: string, patch: DeskAudioSessionPatch): void {
    if (!this.session || this.session.sourceId !== sourceId) return
    this.session = { ...this.session, ...patch }
    this.emit()
  }

  release(sourceId: string): void {
    if (!this.session || this.session.sourceId !== sourceId) return
    this.session = null
    this.emit()
  }
}

export const deskAudioSessionBus = new DeskAudioSessionBus()
