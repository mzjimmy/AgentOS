/**
 * Module-level singleton audio player store for SentinelDesk Morning Brief.
 *
 * Keeps audio playback alive across React view switches (unmounting MorningBriefPage
 * will NOT pause or cancel audio). Components subscribe via `useSyncExternalStore`.
 */

import type { MorningBriefSpeakSegment } from '../../morning-brief-contract'
import {
  DESK_AUDIO_SPEED_STEPS,
  cycleDeskAudioSpeed,
  deskAudioSessionBus,
  formatDeskAudioClock,
  type DeskAudioSession,
  type DeskAudioSessionBus,
} from '../desk/desk-audio-bar-contract'

export const PLAYBACK_SPEED_STEPS = DESK_AUDIO_SPEED_STEPS
const PLAYBACK_SPEED_STORAGE_KEY = 'agentos:morning-brief:playback-rate:v1'
const PLAYBACK_LOOP_STORAGE_KEY = 'agentos:morning-brief:playback-loop:v1'

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

function loadStoredLoop(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PLAYBACK_LOOP_STORAGE_KEY) === '1'
  } catch {
    /* ignore */
  }
  return false
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
  loop: boolean
  error: string | null
}

type Listener = () => void

export class MorningBriefAudioStore {
  private snapshot: MorningBriefAudioSnapshot = {
    issueDate: null,
    headlineDateLabel: '',
    totalSections: 0,
    audioBusy: false,
    isPlaying: false,
    activeSection: 0,
    elapsedSec: 0,
    playbackRate: loadStoredPlaybackRate(),
    loop: loadStoredLoop(),
    error: null,
  }

  private listeners = new Set<Listener>()
  private readonly sessionBus: DeskAudioSessionBus
  private playbackGen = 0
  private audioEl: HTMLAudioElement | null = null
  private cancelCurrentSegment: (() => void) | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private segmentsCache: { date: string; segments: MorningBriefSpeakSegment[] } | null = null

  constructor(options?: { sessionBus?: DeskAudioSessionBus }) {
    this.sessionBus = options?.sessionBus ?? deskAudioSessionBus
  }

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

  private buildBusSession(): DeskAudioSession {
    const snap = this.snapshot
    const total = Math.max(1, snap.totalSections)
    const current = Math.min(total, Math.max(1, snap.activeSection + 1))
    return {
      sourceId: 'morning-brief',
      viewId: 'morning-brief',
      title: snap.headlineDateLabel ? `每日AI早报 · ${snap.headlineDateLabel}` : '每日AI早报',
      subtitle: snap.audioBusy
        ? '合成语音中…'
        : `${formatDeskAudioClock(snap.elapsedSec)} · ${current}/${total}`,
      currentIndex: snap.activeSection,
      total: snap.totalSections,
      elapsedSec: snap.elapsedSec,
      playbackRate: snap.playbackRate,
      isPlaying: snap.isPlaying,
      isBusy: snap.audioBusy,
      onStop: () => this.stop(),
      onCycleSpeed: () => {
        this.cyclePlaybackRate()
      },
    }
  }

  private syncBusIfActive(): void {
    if (!this.snapshot.isPlaying && !this.snapshot.audioBusy) return
    this.sessionBus.update('morning-brief', this.buildBusSession())
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
        this.syncBusIfActive()
      }
    }, 1000)
  }

  private stopMediaOnly(): void {
    this.playbackGen += 1
    this.stopTimer()
    const cancel = this.cancelCurrentSegment
    this.cancelCurrentSegment = null
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
    cancel?.()
  }

  stop(): void {
    this.stopMediaOnly()
    this.setState({
      isPlaying: false,
      audioBusy: false,
    })
    this.sessionBus.release('morning-brief')
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
    const next = cycleDeskAudioSpeed(prev, PLAYBACK_SPEED_STEPS)
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
    this.syncBusIfActive()
    return next
  }

  setLoop(next: boolean): boolean {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PLAYBACK_LOOP_STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
    }
    this.setState({ loop: next })
    return next
  }

  toggleLoop(): boolean {
    return this.setLoop(!this.snapshot.loop)
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
    this.sessionBus.claim(this.buildBusSession())

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
          this.sessionBus.release('morning-brief')
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
        this.sessionBus.release('morning-brief')
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
    this.syncBusIfActive()
    this.startTimer()

    let cursor = startIdx
    while (gen === this.playbackGen) {
      let playedAny = false
      for (let idx = cursor; idx < segments.length; idx += 1) {
        if (gen !== this.playbackGen) return
        const seg = segments[idx]
        this.setState({ activeSection: seg.sectionIndex })
        this.syncBusIfActive()

        if (seg.audioBase64) {
          const ok = await new Promise<boolean>((resolve) => {
            let settled = false
            const finish = (result: boolean) => {
              if (settled) return
              settled = true
              if (this.cancelCurrentSegment === cancel) {
                this.cancelCurrentSegment = null
              }
              resolve(result)
            }
            const cancel = () => finish(false)
            this.cancelCurrentSegment = cancel

            const audio = new Audio(`data:${seg.mime || 'audio/mpeg'};base64,${seg.audioBase64}`)
            audio.playbackRate = this.snapshot.playbackRate
            this.audioEl = audio
            audio.onended = () => finish(true)
            audio.onerror = () => finish(false)
            void audio.play().catch(() => finish(false))
          })
          if (ok) playedAny = true
        } else if ('speechSynthesis' in window) {
          const ok = await new Promise<boolean>((resolve) => {
            let settled = false
            const finish = (result: boolean) => {
              if (settled) return
              settled = true
              if (this.cancelCurrentSegment === cancel) {
                this.cancelCurrentSegment = null
              }
              resolve(result)
            }
            const cancel = () => finish(false)
            this.cancelCurrentSegment = cancel

            const utter = new SpeechSynthesisUtterance(seg.text)
            utter.lang = 'zh-CN'
            utter.rate = this.snapshot.playbackRate
            utter.onend = () => finish(true)
            utter.onerror = () => finish(false)
            window.speechSynthesis.speak(utter)
          })
          if (ok) playedAny = true
        }
      }

      if (gen !== this.playbackGen) return
      if (!this.snapshot.loop || !playedAny) {
        break
      }
      cursor = 0
      this.setState({
        activeSection: segments[0].sectionIndex,
        elapsedSec: 0,
      })
      this.syncBusIfActive()
    }

    if (gen === this.playbackGen) {
      this.stopTimer()
      this.audioEl = null
      this.setState({
        isPlaying: false,
        activeSection: 0,
        elapsedSec: 0,
      })
      this.sessionBus.release('morning-brief')
    }
  }
}

export const morningBriefAudioStore = new MorningBriefAudioStore()
