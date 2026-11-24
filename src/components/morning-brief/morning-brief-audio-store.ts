/**
 * Module-level singleton audio player store for SentinelDesk Morning Brief.
 *
 * Keeps audio playback alive across React view switches (unmounting MorningBriefPage
 * will NOT pause or cancel audio). Components subscribe via `useSyncExternalStore`.
 */

import type { MorningBriefSpeakSegment } from '../../morning-brief-contract'

export const PLAYBACK_SPEED_STEPS = [0.85, 1.0, 1.25, 1.5, 1.75, 2.0] as const
const PLAYBACK_SPEED_STORAGE_KEY = 'agentos:morning-brief:playback-rate:v1'

function loadStoredPlaybackRate(): number {
  if (typeof window === 'undefined') return 1.0
  try {
    const raw = window.localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)
    const parsed = raw ? Number(raw) : NaN
    if (PLAYBACK_SPEED_STEPS.includes(parsed as (typeof PLAYBACK_SPEED_STEPS)[number])) {
      return parsed
    }
  } catch {
    /* ignore */
  }
  return 1.0
}

export type MorningBriefAudioSnapshot = {
  issueDate: string | null
  headlineDateLabel: string
  totalSections: number
  audioBusy: boolean
  isPlaying: boolean
  activeSection: number
  elapsedSec: number
  playbackRate: number
  error: string | null
}

type Listener = () => void

class MorningBriefAudioStore {
  private snapshot: MorningBriefAudioSnapshot = {
    issueDate: null,
    headlineDateLabel: '',
    totalSections: 0,
    audioBusy: false,
    isPlaying: false,
    activeSection: 0,
    elapsedSec: 0,
    playbackRate: loadStoredPlaybackRate(),
    error: null,
  }

  private listeners = new Set<Listener>()
  private playbackGen = 0
  private audioEl: HTMLAudioElement | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private segmentsCache: { date: string; segments: MorningBriefSpeakSegment[] } | null = null

  getSnapshot = (): MorningBriefAudioSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(patch: Partial<MorningBriefAudioSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) {
      listener()
    }
  }

  private stopTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = null
    }
  }

  private startTimer(): void {
    this.stopTimer()
    this.elapsedTimer = setInterval(() => {
      if (this.snapshot.isPlaying) {
        this.setState({ elapsedSec: this.snapshot.elapsedSec + 1 })
      }
    }, 1000)
  }

  private stopMediaOnly(): void {
    this.playbackGen += 1
    this.stopTimer()
    if (this.audioEl) {
      this.audioEl.pause()
      this.audioEl.src = ''
      this.audioEl = null
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    this.stopMediaOnly()
    this.setState({
      isPlaying: false,
      audioBusy: false,
    })
  }

  invalidateDate(date: string): void {
    if (this.segmentsCache?.date === date) {
      this.segmentsCache = null
    }
    if (this.snapshot.issueDate === date) {
      this.stop()
    }
  }

  cyclePlaybackRate(): number {
    const prev = this.snapshot.playbackRate
    const idx = PLAYBACK_SPEED_STEPS.indexOf(prev as (typeof PLAYBACK_SPEED_STEPS)[number])
    const next = PLAYBACK_SPEED_STEPS[(idx + 1) % PLAYBACK_SPEED_STEPS.length]
    if (this.audioEl) {
      this.audioEl.playbackRate = next
    }
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PLAYBACK_SPEED_STORAGE_KEY, String(next))
      } catch {
        /* ignore */
      }
    }
    this.setState({ playbackRate: next })
    return next
  }

  async play(params: {
    date: string
    headlineDateLabel: string
    totalSections: number
    startSection?: number
    onAudioStitched?: () => void
  }): Promise<void> {
    if (typeof window === 'undefined' || !window.desktop?.speakMorningBrief) return

    this.stopMediaOnly()
    const gen = this.playbackGen
    const startIdx = Math.max(0, Math.min(params.totalSections - 1, params.startSection ?? 0))

    this.setState({
      issueDate: params.date,
      headlineDateLabel: params.headlineDateLabel,
      totalSections: params.totalSections,
      activeSection: startIdx,
      audioBusy: true,
      isPlaying: false,
      error: null,
    })

    let segments =
      this.segmentsCache?.date === params.date ? this.segmentsCache.segments : null

    if (!segments) {
      try {
        const res = await window.desktop.speakMorningBrief({
          date: params.date,
          stitchFullIssue: true,
        })
        if (gen !== this.playbackGen) return
        if (res.segments.length === 0) {
          this.setState({
            audioBusy: false,
            isPlaying: false,
            error: !res.ok ? res.message : '暂无可播放内容',
          })
          return
        }
        segments = res.segments
        this.segmentsCache = { date: params.date, segments }
        if (res.ok && res.stitchedAudioPath) {
          params.onAudioStitched?.()
        }
      } catch (err) {
        if (gen !== this.playbackGen) return
        this.setState({
          audioBusy: false,
          isPlaying: false,
          error: err instanceof Error ? err.message : '语音播放失败',
        })
        return
      }
    }

    if (gen !== this.playbackGen) return
    this.setState({
      audioBusy: false,
      isPlaying: true,
      elapsedSec: 0,
      totalSections: segments.length,
    })
    this.startTimer()

    for (let idx = startIdx; idx < segments.length; idx += 1) {
      if (gen !== this.playbackGen) return
      const seg = segments[idx]
      this.setState({ activeSection: seg.sectionIndex })

      if (seg.audioBase64) {
        await new Promise<void>((resolve) => {
          const audio = new Audio(`data:${seg.mime || 'audio/mpeg'};base64,${seg.audioBase64}`)
          audio.playbackRate = this.snapshot.playbackRate
          this.audioEl = audio
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          void audio.play().catch(() => resolve())
        })
      } else if ('speechSynthesis' in window) {
        await new Promise<void>((resolve) => {
          const utter = new SpeechSynthesisUtterance(seg.text)
          utter.lang = 'zh-CN'
          utter.rate = this.snapshot.playbackRate
          utter.onend = () => resolve()
          utter.onerror = () => resolve()
          window.speechSynthesis.speak(utter)
        })
      }
    }

    if (gen === this.playbackGen) {
      this.stopTimer()
      this.audioEl = null
      this.setState({ isPlaying: false })
    }
  }
}

export const morningBriefAudioStore = new MorningBriefAudioStore()
