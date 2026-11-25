/**
 * Pure playback + accordion controller for SentinelDesk Language Push
 * (Option 3: grouped index list + accordion + auto-expand loop playback).
 *
 * Zero React / DOM dependency: speech, sleeping, prefetch, storage and every
 * UI side effect are injected hooks, so `node --test` can drive the whole
 * state machine deterministically. Mirrors the loop & session-bus architecture
 * of `morning-brief-audio-store.ts` (generation cancellation token, playedAny
 * infinite-loop guard, localStorage-persisted loop & playbackRate flags, and
 * global `DeskAudioSessionBus` single-active coordination).
 */

import type {
  LanguagePushCard,
  LanguagePushLang,
  LanguagePushPronunciationHint,
} from '../../language-push-contract'
import {
  DESK_AUDIO_SPEED_STEPS,
  cycleDeskAudioSpeed,
  deskAudioSessionBus,
  formatDeskAudioClock,
  type DeskAudioSession,
  type DeskAudioSessionBus,
} from '../desk/desk-audio-bar-contract'

export type LanguagePushPlayPhase = 'term' | 'example' | null

export type LanguagePushPlayerSnapshot = {
  /** Accordion row currently expanded (auto-follows playback). */
  openCardId: string | null
  /** Card currently being read aloud. */
  activeCardId: string | null
  /** Surface text of the active card (survives rating-induced removal from todayCards). */
  activeSurface: string
  phase: LanguagePushPlayPhase
  /** 0-based position inside the active queue; -1 when idle. */
  index: number
  total: number
  isPlaylist: boolean
  loop: boolean
  /** Active speech playback rate (persisted override or default cfg rate). */
  playbackRate: number
  /** Elapsed seconds in the current playback pass. */
  elapsedSec: number
}

export type LanguagePushSpeakResult = {
  outcome: 'ok' | 'cancelled' | 'error'
  provider: 'minimax' | 'offline' | 'none'
  fallbackReason?: string
}

export type LanguagePushSpeakParams = {
  text: string
  lang: LanguagePushLang
  speed: number
  voiceId?: string
  pronunciations?: LanguagePushPronunciationHint[]
  isCancelled: () => boolean
}

export type LanguagePushPlayerStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type LanguagePushPlayerHooks = {
  speak: (params: LanguagePushSpeakParams) => Promise<LanguagePushSpeakResult>
  prefetch?: (params: Omit<LanguagePushSpeakParams, 'isCancelled'>) => void
  sleep?: (ms: number, isCancelled: () => boolean) => Promise<boolean>
  stopSpeech?: () => void
  storage?: LanguagePushPlayerStorage
  sessionBus?: DeskAudioSessionBus
  defaultSpeed?: number
  onCardEnter?: (card: LanguagePushCard, index: number) => void
  onResetToTop?: () => void
  onFallbackNotice?: () => void
  onComplete?: (count: number) => void
  onError?: (message: string) => void
  termPauseMs?: number
  cardPauseMs?: number
}

export type LanguagePushPlayOptions = {
  startIndex?: number
  singleOnly?: boolean
  speed?: number
  /** Identifies the view slice (e.g. `${date}:${tab}:${langFilter}`) owning this queue. */
  queueScopeKey?: string
  resolveVoiceId: (lang: LanguagePushLang) => string | undefined
}

export const LANGUAGE_PUSH_LOOP_STORAGE_KEY = 'agentos:language-push:playback-loop:v1'
export const LANGUAGE_PUSH_SPEED_STORAGE_KEY = 'agentos:language-push:playback-rate:v1'

const DEFAULT_TERM_PAUSE_MS = 380
const DEFAULT_CARD_PAUSE_MS = 620
const DEFAULT_SPEECH_RATE = 0.95

function defaultSleep(ms: number, isCancelled: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (isCancelled()) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      clearInterval(check)
      resolve(!isCancelled())
    }, ms)
    const check = setInterval(() => {
      if (isCancelled()) {
        clearTimeout(timer)
        clearInterval(check)
        resolve(false)
      }
    }, 60)
  })
}

function buildHints(card: LanguagePushCard): LanguagePushPronunciationHint[] | undefined {
  if (card.lang !== 'ja') return undefined
  return [
    ...(card.example.pronunciations ?? []),
    ...(card.reading ? [{ surface: card.surface, reading: card.reading }] : []),
  ]
}

export class LanguagePushPlayerController {
  private hooks: LanguagePushPlayerHooks
  private readonly sessionBus: DeskAudioSessionBus
  private snapshot: LanguagePushPlayerSnapshot
  private readonly listeners = new Set<() => void>()
  private gen = 0
  private queue: readonly LanguagePushCard[] = []
  private activeScopeKey: string | null = null
  private lastOptions: LanguagePushPlayOptions | null = null
  private hasCustomPlaybackRate = false
  private elapsedTimer: ReturnType<typeof setInterval> | null = null

  constructor(hooks: LanguagePushPlayerHooks) {
    this.hooks = { ...hooks }
    this.sessionBus = hooks.sessionBus ?? deskAudioSessionBus
    const storedRate = this.readStoredPlaybackRate()
    if (storedRate !== null) {
      this.hasCustomPlaybackRate = true
    }
    const initialRate =
      storedRate ??
      (typeof hooks.defaultSpeed === 'number' && Number.isFinite(hooks.defaultSpeed) && hooks.defaultSpeed > 0
        ? hooks.defaultSpeed
        : DEFAULT_SPEECH_RATE)

    this.snapshot = {
      openCardId: null,
      activeCardId: null,
      activeSurface: '',
      phase: null,
      index: -1,
      total: 0,
      isPlaylist: false,
      loop: this.readStoredLoop(),
      playbackRate: initialRate,
      elapsedSec: 0,
    }
  }

  getSnapshot = (): LanguagePushPlayerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Updates runtime/UI hooks on a shared singleton without interrupting active playback. */
  updateHooks(patch: Partial<LanguagePushPlayerHooks>): void {
    this.hooks = { ...this.hooks, ...patch }
    if (patch.storage) {
      const storedLoop = this.readStoredLoop()
      const storedRate = this.readStoredPlaybackRate()
      const nextPatch: Partial<LanguagePushPlayerSnapshot> = {}
      if (storedLoop !== this.snapshot.loop) nextPatch.loop = storedLoop
      if (storedRate !== null) {
        this.hasCustomPlaybackRate = true
        if (storedRate !== this.snapshot.playbackRate) nextPatch.playbackRate = storedRate
      }
      if (Object.keys(nextPatch).length > 0) {
        this.setState(nextPatch)
      }
    }
  }

  /** Syncs configured default speed from settings when the user has not chosen a bar override. */
  syncDefaultSpeed(rate: number): void {
    if (this.hasCustomPlaybackRate) return
    if (!Number.isFinite(rate) || rate <= 0) return
    if (rate !== this.snapshot.playbackRate) {
      this.setState({ playbackRate: rate })
      this.syncBusIfActive()
    }
  }

  private setState(patch: Partial<LanguagePushPlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private readStoredLoop(): boolean {
    try {
      return this.hooks.storage?.getItem(LANGUAGE_PUSH_LOOP_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  }

  private readStoredPlaybackRate(): number | null {
    try {
      const raw = this.hooks.storage?.getItem(LANGUAGE_PUSH_SPEED_STORAGE_KEY)
      if (!raw) return null
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    } catch {
      /* ignore */
    }
    return null
  }

  private buildBusSession(): DeskAudioSession {
    const snap = this.snapshot
    const total = Math.max(1, snap.total)
    const current = Math.min(total, Math.max(1, snap.index + 1))
    return {
      sourceId: 'language-push',
      viewId: 'language-push',
      title: snap.activeSurface || '外语学习',
      subtitle: `${formatDeskAudioClock(snap.elapsedSec)} · ${current}/${total}`,
      currentIndex: Math.max(0, snap.index),
      total: snap.total,
      elapsedSec: snap.elapsedSec,
      playbackRate: snap.playbackRate,
      isPlaying: Boolean(snap.activeCardId),
      isBusy: false,
      onStop: () => this.stop(),
      onCycleSpeed: () => {
        this.cycleSpeed()
      },
    }
  }

  private syncBusIfActive(): void {
    if (!this.snapshot.activeCardId) return
    this.sessionBus.update('language-push', this.buildBusSession())
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
      if (this.snapshot.activeCardId) {
        this.setState({ elapsedSec: this.snapshot.elapsedSec + 1 })
        this.syncBusIfActive()
      }
    }, 1000)
  }

  toggleOpen(cardId: string): void {
    this.setState({ openCardId: this.snapshot.openCardId === cardId ? null : cardId })
  }

  /** Takes effect live, even in the middle of an active playlist pass. */
  setLoop(next: boolean): boolean {
    try {
      this.hooks.storage?.setItem(LANGUAGE_PUSH_LOOP_STORAGE_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
    this.setState({ loop: next })
    return next
  }

  toggleLoop(): boolean {
    return this.setLoop(!this.snapshot.loop)
  }

  /** Sets and persists playback rate; takes effect on the next utterance immediately. */
  setPlaybackRate(next: number): number {
    if (!Number.isFinite(next) || next <= 0) return this.snapshot.playbackRate
    this.hasCustomPlaybackRate = true
    try {
      this.hooks.storage?.setItem(LANGUAGE_PUSH_SPEED_STORAGE_KEY, String(next))
    } catch {
      /* ignore */
    }
    this.setState({ playbackRate: next })
    // Updates both playlist and one-shot preview bus sessions (no-op if not bus owner).
    this.sessionBus.update('language-push', { playbackRate: next })
    return next
  }

  /** Cycles playback rate across `DESK_AUDIO_SPEED_STEPS` and persists to storage. */
  cycleSpeed(): number {
    const next = cycleDeskAudioSpeed(this.snapshot.playbackRate, DESK_AUDIO_SPEED_STEPS)
    return this.setPlaybackRate(next)
  }

  stop(options?: { keepOpen?: boolean }): void {
    this.gen += 1
    this.stopTimer()
    this.activeScopeKey = null
    this.hooks.stopSpeech?.()
    this.setState({
      openCardId: options?.keepOpen ? this.snapshot.openCardId : null,
      activeCardId: null,
      activeSurface: '',
      phase: null,
      index: -1,
      total: 0,
      isPlaylist: false,
      elapsedSec: 0,
    })
    this.sessionBus.release('language-push')
  }

  /**
   * Keeps the live playlist aligned when user ratings remove cards from `todayCards`.
   * Preserves `activeSurface` for the currently speaking card so the playback bar
   * never flickers away mid-utterance, while preventing removed cards from replaying.
   * When `scopeKey` is provided and does not match the active playlist's scope, the
   * call is ignored so remounting or browsing another date/tab never clobbers playback.
   */
  syncQueue(nextQueue: readonly LanguagePushCard[], scopeKey?: string): void {
    if (!this.snapshot.isPlaylist) return
    if (this.activeScopeKey && scopeKey && scopeKey !== this.activeScopeKey) return
    this.queue = nextQueue
    const activeId = this.snapshot.activeCardId
    const newIndex = activeId ? nextQueue.findIndex((c) => c.id === activeId) : -1
    const nextTotal = nextQueue.length
    if (nextTotal !== this.snapshot.total || (newIndex >= 0 && newIndex !== this.snapshot.index)) {
      this.setState({
        total: nextTotal,
        index: newIndex >= 0 ? newIndex : Math.min(this.snapshot.index, Math.max(0, nextTotal - 1)),
      })
      this.syncBusIfActive()
    }
  }

  playSingle(
    card: LanguagePushCard,
    options: Omit<LanguagePushPlayOptions, 'singleOnly' | 'startIndex'>,
  ): Promise<void> {
    return this.playQueue([card], { ...options, singleOnly: true })
  }

  /**
   * One-shot speech (drawer 听词条 / 听例句 micro buttons): cancels any active
   * playlist, keeps the accordion state untouched, speaks a single text.
   */
  async preview(params: {
    text: string
    lang: LanguagePushLang
    speed?: number
    voiceId?: string
    pronunciations?: LanguagePushPronunciationHint[]
  }): Promise<void> {
    this.gen += 1
    const gen = this.gen
    this.stopTimer()
    this.hooks.stopSpeech?.()
    const effectiveSpeed = this.hasCustomPlaybackRate
      ? this.snapshot.playbackRate
      : (params.speed ?? this.snapshot.playbackRate)
    this.setState({
      activeCardId: null,
      activeSurface: '',
      phase: null,
      isPlaylist: false,
      index: -1,
      elapsedSec: 0,
    })
    this.sessionBus.claim({
      sourceId: 'language-push',
      viewId: 'language-push',
      title: params.text,
      subtitle: '',
      currentIndex: 0,
      total: 1,
      elapsedSec: 0,
      playbackRate: effectiveSpeed,
      isPlaying: true,
      isBusy: false,
      onStop: () => this.stop({ keepOpen: true }),
      onCycleSpeed: () => {
        this.cycleSpeed()
      },
    })
    try {
      await this.hooks.speak({
        ...params,
        speed: effectiveSpeed,
        isCancelled: () => gen !== this.gen,
      })
    } finally {
      if (gen === this.gen) {
        this.sessionBus.release('language-push')
      }
    }
  }

  playFromIndex(
    queue: readonly LanguagePushCard[],
    startIndex: number,
    options: Omit<LanguagePushPlayOptions, 'singleOnly' | 'startIndex'>,
  ): Promise<void> {
    return this.playQueue(queue, { ...options, startIndex })
  }

  stepNext(): void {
    this.step(1)
  }

  stepPrev(): void {
    this.step(-1)
  }

  private step(delta: 1 | -1): void {
    if (!this.snapshot.isPlaylist || this.queue.length === 0 || !this.lastOptions) return
    let next = this.snapshot.index + delta
    if (next < 0) {
      if (!this.snapshot.loop) return
      next = this.queue.length - 1
    } else if (next >= this.queue.length) {
      if (!this.snapshot.loop) return
      next = 0
    }
    void this.playQueue(this.queue, { ...this.lastOptions, startIndex: next })
  }

  async playQueue(queue: readonly LanguagePushCard[], options: LanguagePushPlayOptions): Promise<void> {
    this.gen += 1
    const gen = this.gen
    this.stopTimer()
    this.hooks.stopSpeech?.()
    this.queue = queue
    this.activeScopeKey = options.queueScopeKey ?? null
    this.lastOptions = { ...options }
    const isCancelled = () => gen !== this.gen
    const singleOnly = options.singleOnly === true

    if (queue.length === 0) {
      this.setState({
        activeCardId: null,
        activeSurface: '',
        phase: null,
        isPlaylist: false,
        index: -1,
        total: 0,
        elapsedSec: 0,
      })
      this.sessionBus.release('language-push')
      return
    }

    if (
      !this.hasCustomPlaybackRate &&
      typeof options.speed === 'number' &&
      Number.isFinite(options.speed) &&
      options.speed > 0 &&
      options.speed !== this.snapshot.playbackRate
    ) {
      this.setState({ playbackRate: options.speed })
    }

    const getEffectiveSpeed = (): number =>
      this.hasCustomPlaybackRate
        ? this.snapshot.playbackRate
        : (options.speed ?? this.snapshot.playbackRate)

    let cursor = Math.max(0, Math.min(queue.length - 1, Math.floor(options.startIndex ?? 0)))
    const termPauseMs = this.hooks.termPauseMs ?? DEFAULT_TERM_PAUSE_MS
    const cardPauseMs = this.hooks.cardPauseMs ?? DEFAULT_CARD_PAUSE_MS
    const sleep = this.hooks.sleep ?? defaultSleep
    let fallbackNotified = false
    let claimedBus = false

    this.setState({ elapsedSec: 0 })
    this.startTimer()

    while (gen === this.gen) {
      let playedAny = false
      const handleResult = (result: LanguagePushSpeakResult) => {
        if (result.outcome === 'ok') playedAny = true
        if (result.outcome === 'error') this.hooks.onError?.(result.fallbackReason || 'speech_failed')
        if (!fallbackNotified && result.provider === 'offline' && result.fallbackReason) {
          fallbackNotified = true
          this.hooks.onFallbackNotice?.()
        }
      }

      let idx = cursor
      while (gen === this.gen && idx < this.queue.length) {
        if (isCancelled()) return
        const card = this.queue[idx]
        const hints = buildHints(card)
        const voiceId = options.resolveVoiceId(card.lang)
        const currentSpeed = getEffectiveSpeed()

        this.setState({
          openCardId: card.id,
          activeCardId: card.id,
          activeSurface: card.surface,
          phase: 'term',
          index: idx,
          total: this.queue.length,
          isPlaylist: !singleOnly,
        })
        if (!claimedBus) {
          claimedBus = true
          this.sessionBus.claim(this.buildBusSession())
          if (isCancelled()) return
        } else {
          this.syncBusIfActive()
        }
        this.hooks.onCardEnter?.(card, idx)

        const nextCard =
          this.queue[idx + 1] ?? (!singleOnly && this.snapshot.loop && this.queue.length > 1 ? this.queue[0] : undefined)
        if (nextCard && nextCard.id !== card.id && this.hooks.prefetch) {
          const nextHints = buildHints(nextCard)
          const nextVoiceId = options.resolveVoiceId(nextCard.lang)
          this.hooks.prefetch({
            text: nextCard.surface,
            lang: nextCard.lang,
            speed: currentSpeed,
            voiceId: nextVoiceId,
            pronunciations: nextHints,
          })
          if (nextCard.example.sentence) {
            this.hooks.prefetch({
              text: nextCard.example.sentence,
              lang: nextCard.lang,
              speed: currentSpeed,
              voiceId: nextVoiceId,
              pronunciations: nextHints,
            })
          }
        }

        const termResult = await this.hooks.speak({
          text: card.surface,
          lang: card.lang,
          speed: getEffectiveSpeed(),
          voiceId,
          pronunciations: hints,
          isCancelled,
        })
        if (isCancelled()) return
        handleResult(termResult)

        if (card.example.sentence) {
          if (!(await sleep(termPauseMs, isCancelled)) || isCancelled()) return
          this.setState({ phase: 'example' })
          this.syncBusIfActive()
          const exampleResult = await this.hooks.speak({
            text: card.example.sentence,
            lang: card.lang,
            speed: getEffectiveSpeed(),
            voiceId,
            pronunciations: hints,
            isCancelled,
          })
          if (isCancelled()) return
          handleResult(exampleResult)
        }

        if (!(await sleep(cardPauseMs, isCancelled)) || isCancelled()) return

        // Re-anchor against the live queue in case the user rated & removed `card` mid-playback.
        const currentPos = this.queue.findIndex((c) => c.id === card.id)
        idx = currentPos >= 0 ? currentPos + 1 : idx
      }

      if (singleOnly) {
        this.stopTimer()
        // Keep the accordion open on the previewed card; only clear play state.
        this.setState({
          activeCardId: null,
          activeSurface: '',
          phase: null,
          isPlaylist: false,
          index: -1,
          elapsedSec: 0,
        })
        this.sessionBus.release('language-push')
        return
      }
      if (this.snapshot.loop && playedAny && this.queue.length > 0) {
        cursor = 0
        this.setState({ elapsedSec: 0 })
        this.syncBusIfActive()
        continue
      }
      break
    }

    if (gen !== this.gen) return
    this.stopTimer()
    const completedCount = this.queue.length
    this.setState({
      openCardId: null,
      activeCardId: null,
      activeSurface: '',
      phase: null,
      isPlaylist: false,
      index: -1,
      elapsedSec: 0,
    })
    this.sessionBus.release('language-push')
    this.hooks.onResetToTop?.()
    this.hooks.onComplete?.(completedCount)
  }
}

export const languagePushPlayer = new LanguagePushPlayerController({
  speak: async () => ({ outcome: 'error', provider: 'none', fallbackReason: 'not_initialized' }),
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
})
