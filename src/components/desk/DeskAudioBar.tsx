/**
 * Unified SentinelDesk playback bar (Option 1 — AI Morning Brief editorial DNA):
 *  - `DeskAudioBar`: inline playback bar (`variant="inset"` inside paper sheets,
 *    `variant="card"` directly on SentinelDesk canvas).
 *  - `DeskAudioStickyStrip`: zero-layout-shift overlay sticky strip rendered inside
 *    `DeskDatePageShell.stickyOverlay` (`position: absolute; top: 0`).
 *  - `useDeskAudioSticky`: passive scroll + rAF + ResizeObserver + Schmitt-trigger
 *    hysteresis hook eliminating half-covered boundary flicker.
 *  - `DeskAudioMiniPlayer`: shared cross-page bottom-right floating capsule driven
 *    by `deskAudioSessionBus`.
 *
 * Intentionally imports ZERO base AgentOS modules so any SentinelDesk page can
 * adopt it without widening the import-boundary ratchet.
 */

import '../../styles/desk-audio-bar.css'
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  attachDeskAudioStickyObserver,
  deskAudioSessionBus,
  formatDeskAudioClock,
  formatDeskAudioSpeed,
  type DeskAudioBarLabels,
  type DeskAudioSessionBus,
  type DeskAudioSurfaceVariant,
} from './desk-audio-bar-contract'

function PlayIcon() {
  return (
    <svg className="desk-audio-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.86-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg className="desk-audio-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" />
    </svg>
  )
}

function LoopIcon() {
  return (
    <svg
      className="desk-audio-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 2l4 4-4 4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 22l-4-4 4-4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  )
}

function PrevIcon() {
  return (
    <svg
      className="desk-audio-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function NextIcon() {
  return (
    <svg
      className="desk-audio-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

export type UseDeskAudioStickyParams = {
  scrollRef: RefObject<HTMLElement | null>
  anchorRef: RefObject<HTMLElement | null>
  active: boolean
  rebindKey?: string | number | null
}

/**
 * Tracks whether the inline audio bar has scrolled above the top edge of `scrollRef`
 * using passive scroll listeners coalesced via `requestAnimationFrame`, `ResizeObserver`,
 * and pure Schmitt-trigger hysteresis (`computeDeskAudioStickyVisible`).
 */
export function useDeskAudioSticky({
  scrollRef,
  anchorRef,
  active,
  rebindKey,
}: UseDeskAudioStickyParams): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!active) {
      setVisible(false)
      return
    }
    const scrollEl = scrollRef.current
    const anchorEl = anchorRef.current
    if (!scrollEl || !anchorEl) {
      setVisible(false)
      return
    }

    return attachDeskAudioStickyObserver({
      scrollEl,
      anchorEl,
      ResizeObserverCtor:
        typeof ResizeObserver !== 'undefined'
          ? (ResizeObserver as unknown as new (cb: () => void) => {
              observe: (target: unknown) => void
              disconnect: () => void
            })
          : undefined,
      requestAnimationFrameFn:
        typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
          ? (cb) => window.requestAnimationFrame(cb)
          : undefined,
      cancelAnimationFrameFn:
        typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
          ? (id) => window.cancelAnimationFrame(id)
          : undefined,
      onChange: (next) => setVisible(next),
    })
  }, [active, scrollRef, anchorRef, rebindKey])

  return active && visible
}

export type DeskAudioBarProps = {
  barRef?: RefObject<HTMLDivElement | null>
  variant?: DeskAudioSurfaceVariant
  title: string
  phaseLabel?: string | null
  subtitle: string
  isPlaying: boolean
  isBusy?: boolean
  disabled?: boolean
  playbackRate: number
  loop: boolean
  canPrev?: boolean
  canNext?: boolean
  onTogglePlay: () => void
  onCycleSpeed: () => void
  onToggleLoop: () => void
  onPrev?: () => void
  onNext?: () => void
  extraActions?: ReactNode
  labels?: DeskAudioBarLabels
  testId?: string
  loopTestId?: string
  className?: string
}

function renderAudioControls(props: {
  playbackRate: number
  loop: boolean
  disabled?: boolean
  isBusy?: boolean
  canPrev?: boolean
  canNext?: boolean
  onCycleSpeed: () => void
  onToggleLoop: () => void
  onPrev?: () => void
  onNext?: () => void
  extraActions?: ReactNode
  labels?: DeskAudioBarLabels
  loopTestId?: string
}) {
  const {
    playbackRate,
    loop,
    disabled = false,
    isBusy = false,
    canPrev,
    canNext,
    onCycleSpeed,
    onToggleLoop,
    onPrev,
    onNext,
    extraActions,
    labels,
    loopTestId,
  } = props
  const speedLabel = formatDeskAudioSpeed(playbackRate)
  const speedTitle = labels?.speed ?? 'Speed'
  const loopLabel = loop ? (labels?.loopOn ?? 'Loop: On') : (labels?.loopOff ?? 'Loop: Off')

  return (
    <div className="desk-audio-controls">
      <button
        type="button"
        className="desk-audio-speed"
        aria-label={speedTitle}
        title={speedTitle}
        onClick={onCycleSpeed}
      >
        {speedLabel}
      </button>
      <button
        type="button"
        className={loop ? 'desk-audio-nav desk-audio-loop is-active' : 'desk-audio-nav desk-audio-loop'}
        aria-label={loopLabel}
        aria-pressed={loop}
        title={loopLabel}
        data-testid={loopTestId}
        onClick={onToggleLoop}
      >
        <LoopIcon />
      </button>
      {onPrev ? (
        <button
          type="button"
          className="desk-audio-nav"
          disabled={disabled || isBusy || canPrev === false}
          aria-label={labels?.prev ?? 'Previous'}
          title={labels?.prev ?? 'Previous'}
          onClick={onPrev}
        >
          <PrevIcon />
        </button>
      ) : null}
      {onNext ? (
        <button
          type="button"
          className="desk-audio-nav"
          disabled={disabled || isBusy || canNext === false}
          aria-label={labels?.next ?? 'Next'}
          title={labels?.next ?? 'Next'}
          onClick={onNext}
        >
          <NextIcon />
        </button>
      ) : null}
      {extraActions}
    </div>
  )
}

export function DeskAudioBar({
  barRef,
  variant = 'inset',
  title,
  phaseLabel,
  subtitle,
  isPlaying,
  isBusy = false,
  disabled = false,
  playbackRate,
  loop,
  canPrev,
  canNext,
  onTogglePlay,
  onCycleSpeed,
  onToggleLoop,
  onPrev,
  onNext,
  extraActions,
  labels,
  testId,
  loopTestId,
  className,
}: DeskAudioBarProps) {
  const playAria = isPlaying ? (labels?.pause ?? 'Pause') : (labels?.play ?? 'Play')
  const rootClass = [
    'desk-audio-bar',
    `desk-audio-bar--${variant}`,
    isPlaying ? 'is-playing' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={barRef} className={rootClass} data-testid={testId}>
      <div className="desk-audio-left">
        <button
          type="button"
          className="desk-audio-play"
          disabled={disabled || isBusy}
          aria-label={playAria}
          title={playAria}
          onClick={onTogglePlay}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="desk-audio-info">
          <div className="desk-audio-title-row">
            {isPlaying ? (
              <span className="desk-audio-eq" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : null}
            <span className="desk-audio-title">{title}</span>
            {phaseLabel ? <span className="desk-audio-phase">{phaseLabel}</span> : null}
          </div>
          <div className="desk-audio-sub">{subtitle}</div>
        </div>
      </div>

      {renderAudioControls({
        playbackRate,
        loop,
        disabled,
        isBusy,
        canPrev,
        canNext,
        onCycleSpeed,
        onToggleLoop,
        onPrev,
        onNext,
        extraActions,
        labels,
        loopTestId,
      })}
    </div>
  )
}

export type DeskAudioStickyStripProps = {
  visible: boolean
  title: string
  phaseLabel?: string | null
  subtitle: string
  isPlaying: boolean
  isBusy?: boolean
  progressPct: number
  playbackRate: number
  loop: boolean
  canPrev?: boolean
  canNext?: boolean
  onTogglePlay: () => void
  onCycleSpeed: () => void
  onToggleLoop: () => void
  onPrev?: () => void
  onNext?: () => void
  extraActions?: ReactNode
  labels?: DeskAudioBarLabels
  maxWidthPx?: number
  testId?: string
  loopTestId?: string
}

export function DeskAudioStickyStrip({
  visible,
  title,
  phaseLabel,
  subtitle,
  isPlaying,
  isBusy = false,
  progressPct,
  playbackRate,
  loop,
  canPrev,
  canNext,
  onTogglePlay,
  onCycleSpeed,
  onToggleLoop,
  onPrev,
  onNext,
  extraActions,
  labels,
  maxWidthPx,
  testId,
  loopTestId,
}: DeskAudioStickyStripProps) {
  if (!visible) return null

  const playAria = isPlaying ? (labels?.pause ?? 'Pause') : (labels?.play ?? 'Play')
  const clampedPct = Number.isFinite(progressPct) ? Math.max(0, Math.min(100, progressPct)) : 0
  const style = maxWidthPx
    ? ({ '--desk-audio-sticky-max-width': `${maxWidthPx}px` } as CSSProperties)
    : undefined

  return (
    <div className="desk-audio-sticky" data-testid={testId ?? 'desk-audio-sticky-strip'} style={style}>
      <div className="desk-audio-sticky-inner">
        <div className="desk-audio-sticky-meta">
          <button
            type="button"
            className="desk-audio-play desk-audio-play--sm"
            disabled={isBusy}
            aria-label={playAria}
            title={playAria}
            onClick={onTogglePlay}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          {isPlaying ? (
            <span className="desk-audio-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          <span className="desk-audio-title">{title}</span>
          {phaseLabel ? <span className="desk-audio-phase">{phaseLabel}</span> : null}
          <span className="desk-audio-sub">{subtitle}</span>
        </div>

        {renderAudioControls({
          playbackRate,
          loop,
          isBusy,
          canPrev,
          canNext,
          onCycleSpeed,
          onToggleLoop,
          onPrev,
          onNext,
          extraActions,
          labels,
          loopTestId,
        })}
      </div>
      <div className="desk-audio-sticky-progress">
        <div className="desk-audio-sticky-progress-fill" style={{ width: `${clampedPct}%` }} />
      </div>
    </div>
  )
}

export type DeskAudioMiniPlayerProps = {
  activeViewId: string
  sessionBus?: DeskAudioSessionBus
}

export function DeskAudioMiniPlayer({
  activeViewId,
  sessionBus = deskAudioSessionBus,
}: DeskAudioMiniPlayerProps) {
  const session = useSyncExternalStore(sessionBus.subscribe, sessionBus.getSnapshot)

  if (!session || activeViewId === session.viewId || (!session.isPlaying && !session.isBusy)) {
    return null
  }

  const total = Math.max(1, session.total)
  const fallbackMeta = `${formatDeskAudioClock(session.elapsedSec)} · ${Math.min(total, Math.max(1, session.currentIndex + 1))}/${total}`

  return (
    <div className="desk-audio-mini" data-testid="desk-audio-mini-player">
      <button
        type="button"
        className="desk-audio-mini-btn"
        aria-label="Stop"
        onClick={() => session.onStop()}
      >
        <PauseIcon />
      </button>

      <button
        type="button"
        className="desk-audio-mini-jump"
        onClick={() => {
          if (session.onNavigate) {
            session.onNavigate()
          } else if (typeof window !== 'undefined') {
            window.location.hash = `#${session.viewId}`
          }
        }}
      >
        <span className="desk-audio-mini-title">{session.title}</span>
        <span className="desk-audio-mini-meta">{session.subtitle || fallbackMeta}</span>
      </button>

      {session.onCycleSpeed ? (
        <button
          type="button"
          className="desk-audio-mini-speed"
          onClick={() => session.onCycleSpeed?.()}
        >
          {formatDeskAudioSpeed(session.playbackRate)}
        </button>
      ) : null}
    </div>
  )
}
