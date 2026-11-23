/**
 * Unified speech playback engine for SentinelDesk Language Push:
 * - Primary: MiniMax HD (`speech-2.8-hd`) via Electron Main IPC with local MP3 disk cache.
 * - Fallback: Zero-config offline Web Speech synthesis when MiniMax is unavailable/offline.
 * - Supports clean cancellation (generation tokens) and prefetching for gapless playlist playback.
 */

import type { LanguagePushLang, LanguagePushPronunciationHint } from '../../language-push-contract'

export function cleanSpeechTextForBrowser(text: string, lang: LanguagePushLang): string {
  let cleaned = (text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
  if (lang === 'ja') {
    cleaned = cleaned.replace(/[（(][\u3040-\u30ffー・\s]+[）)]/g, '')
  }
  return cleaned.replace(/\s+/g, ' ').trim()
}

function pickPreferredVoice(voices: SpeechSynthesisVoice[], lang: LanguagePushLang): SpeechSynthesisVoice | null {
  const prefix = lang === 'ja' ? 'ja' : 'en'
  const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix))
  if (matches.length === 0) return null
  if (lang === 'ja') {
    return (
      matches.find((v) => /kyoko|otoya|haruka|nanami|google 日本語/i.test(v.name)) ??
      matches.find((v) => v.localService) ??
      matches[0]
    )
  }
  return (
    matches.find((v) => v.lang.toLowerCase() === 'en-us' && /samantha|alex|daniel|google us/i.test(v.name)) ??
    matches.find((v) => v.lang.toLowerCase() === 'en-us' && v.localService) ??
    matches.find((v) => v.localService) ??
    matches[0]
  )
}

export function isOfflineSpeechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  )
}

let activeAudio: HTMLAudioElement | null = null
let activeObjectUrl: string | null = null
let activeCancelResolver: (() => void) | null = null

export function stopAllSpeech(): void {
  if (activeAudio) {
    try {
      activeAudio.pause()
      activeAudio.currentTime = 0
    } catch {
      /* ignore */
    }
    activeAudio = null
  }
  if (activeObjectUrl) {
    try {
      URL.revokeObjectURL(activeObjectUrl)
    } catch {
      /* ignore */
    }
    activeObjectUrl = null
  }
  if (activeCancelResolver) {
    const resolve = activeCancelResolver
    activeCancelResolver = null
    resolve()
  }
  if (isOfflineSpeechSupported()) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
  }
}

function base64ToAudioBlob(base64: string, mime: string): Blob {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mime || 'audio/mpeg' })
}

function playAudioBlob(blob: Blob, isCancelled: () => boolean): Promise<'ended' | 'cancelled' | 'error'> {
  return new Promise((resolve) => {
    if (isCancelled()) {
      resolve('cancelled')
      return
    }
    stopAllSpeech()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    activeAudio = audio
    activeObjectUrl = url

    const finish = (outcome: 'ended' | 'cancelled' | 'error') => {
      if (activeAudio === audio) activeAudio = null
      if (activeObjectUrl === url) {
        URL.revokeObjectURL(url)
        activeObjectUrl = null
      }
      activeCancelResolver = null
      resolve(outcome)
    }

    activeCancelResolver = () => finish('cancelled')
    audio.onended = () => finish('ended')
    audio.onerror = () => finish('error')
    void audio.play().catch(() => finish('error'))
  })
}

function playOfflineUtterance(
  text: string,
  lang: LanguagePushLang,
  rate: number,
  isCancelled: () => boolean,
): Promise<'ended' | 'cancelled' | 'error'> {
  return new Promise((resolve) => {
    if (isCancelled()) {
      resolve('cancelled')
      return
    }
    if (!isOfflineSpeechSupported()) {
      resolve('error')
      return
    }
    const cleaned = cleanSpeechTextForBrowser(text, lang)
    if (!cleaned) {
      resolve('ended')
      return
    }
    try {
      stopAllSpeech()
      const utterance = new SpeechSynthesisUtterance(cleaned)
      utterance.lang = lang === 'ja' ? 'ja-JP' : 'en-US'
      utterance.rate = Number.isFinite(rate) ? rate : 0.95
      const preferred = pickPreferredVoice(window.speechSynthesis.getVoices(), lang)
      if (preferred) utterance.voice = preferred
      let settled = false
      const done = (outcome: 'ended' | 'cancelled' | 'error') => {
        if (settled) return
        settled = true
        activeCancelResolver = null
        resolve(outcome)
      }
      activeCancelResolver = () => done('cancelled')
      utterance.onend = () => done('ended')
      utterance.onerror = () => done('error')
      window.speechSynthesis.speak(utterance)
    } catch {
      resolve('error')
    }
  })
}

export type PlaySpeechResult = {
  outcome: 'ended' | 'cancelled' | 'error'
  provider: 'minimax' | 'offline' | 'none'
  fallbackReason?: string
}

export async function playLanguagePushSpeech(params: {
  text: string
  lang: LanguagePushLang
  speed?: number
  voiceId?: string
  pronunciations?: LanguagePushPronunciationHint[]
  isCancelled: () => boolean
}): Promise<PlaySpeechResult> {
  const rate = params.speed ?? 0.95
  if (params.isCancelled()) return { outcome: 'cancelled', provider: 'none' }

  if (window.desktop?.speakLanguagePush) {
    try {
      const res = await window.desktop.speakLanguagePush({
        text: params.text,
        lang: params.lang,
        speed: rate,
        voiceId: params.voiceId,
        pronunciations: params.pronunciations,
      })
      if (params.isCancelled()) return { outcome: 'cancelled', provider: 'none' }
      if (res.ok && res.audioBase64) {
        const blob = base64ToAudioBlob(res.audioBase64, res.mime)
        const outcome = await playAudioBlob(blob, params.isCancelled)
        if (outcome !== 'error') {
          return { outcome, provider: 'minimax' }
        }
      }
      // Graceful fallback to offline Web Speech if MiniMax failed or not configured
      const fallbackOutcome = await playOfflineUtterance(params.text, params.lang, rate, params.isCancelled)
      return {
        outcome: fallbackOutcome,
        provider: fallbackOutcome === 'error' ? 'none' : 'offline',
        fallbackReason: res.ok ? undefined : res.message,
      }
    } catch (error) {
      if (params.isCancelled()) return { outcome: 'cancelled', provider: 'none' }
      const fallbackOutcome = await playOfflineUtterance(params.text, params.lang, rate, params.isCancelled)
      return {
        outcome: fallbackOutcome,
        provider: fallbackOutcome === 'error' ? 'none' : 'offline',
        fallbackReason: error instanceof Error ? error.message : undefined,
      }
    }
  }

  const outcome = await playOfflineUtterance(params.text, params.lang, rate, params.isCancelled)
  return { outcome, provider: outcome === 'error' ? 'none' : 'offline' }
}

/**
 * Quietly warms the Main-process MP3 disk cache for the next card during playlist playback.
 */
export function prefetchLanguagePushSpeech(params: {
  text: string
  lang: LanguagePushLang
  speed?: number
  voiceId?: string
  pronunciations?: LanguagePushPronunciationHint[]
}): void {
  if (!window.desktop?.speakLanguagePush || !params.text.trim()) return
  void window.desktop.speakLanguagePush(params).catch(() => undefined)
}

export function sleepCancellable(ms: number, isCancelled: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (isCancelled()) {
      resolve(false)
      return
    }
    const timer = window.setTimeout(() => resolve(!isCancelled()), ms)
    const check = window.setInterval(() => {
      if (isCancelled()) {
        window.clearTimeout(timer)
        window.clearInterval(check)
        resolve(false)
      }
    }, 60)
    window.setTimeout(() => window.clearInterval(check), ms + 20)
  })
}
