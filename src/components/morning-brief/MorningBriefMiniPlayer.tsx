/**
 * Compact global floating mini-player shown ONLY while Morning Brief audio is actively
 * playing in the background on another view, allowing instant speed/pause/return control.
 */

import '../../styles/morning-brief-mini-player.css'
import { useSyncExternalStore } from 'react'
import { IconInline } from '../../icon-inline'
import type { AppViewId } from '../types'
import { morningBriefAudioStore } from './morning-brief-audio-store'

function formatMiniClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const m = String(Math.floor(safe / 60)).padStart(2, '0')
  const s = String(safe % 60).padStart(2, '0')
  return `${m}:${s}`
}

export type MorningBriefMiniPlayerProps = {
  activeViewId: AppViewId
}

export function MorningBriefMiniPlayer({ activeViewId }: MorningBriefMiniPlayerProps) {
  const audio = useSyncExternalStore(
    morningBriefAudioStore.subscribe,
    morningBriefAudioStore.getSnapshot,
  )

  if (activeViewId === 'morning-brief' || (!audio.isPlaying && !audio.audioBusy)) {
    return null
  }

  return (
    <div className="mb-mini-player" data-testid="morning-brief-mini-player">
      <button
        type="button"
        className="mb-mini-btn"
        aria-label="Stop"
        onClick={() => morningBriefAudioStore.stop()}
      >
        <IconInline name="pause" />
      </button>

      <button
        type="button"
        className="mb-mini-jump"
        onClick={() => {
          window.location.hash = '#morning-brief'
        }}
      >
        <span className="mb-mini-title">
          每日AI早报{audio.headlineDateLabel ? ` · ${audio.headlineDateLabel}` : ''}
        </span>
        <span className="mb-mini-meta">
          {formatMiniClock(audio.elapsedSec)} · {audio.activeSection + 1}/{Math.max(1, audio.totalSections)}
        </span>
      </button>

      <button
        type="button"
        className="mb-mini-speed"
        onClick={() => morningBriefAudioStore.cyclePlaybackRate()}
      >
        {audio.playbackRate.toFixed(audio.playbackRate % 1 === 0 ? 1 : 2).replace(/0$/, '')}x
      </button>
    </div>
  )
}
