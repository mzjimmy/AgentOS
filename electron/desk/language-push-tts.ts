/**
 * MiniMax HD speech synthesis (`speech-2.8-hd` via `/v1/t2a_v2`) with local disk MP3 cache
 * for SentinelDesk Language Push, ported directly from SentinelLab `services/tts.ts`.
 *
 * Japanese anti-Chinese-accent pipeline:
 * 1. Normalizes Japanese time/amount counters (`7時10分` → `7じ10ぷん`).
 * 2. Applies per-card `exampleReadings` + card surface/reading + curated diary/tech kanji
 *    pronunciation dictionary using `Intl.Segmenter('ja', { granularity: 'word' })` boundary
 *    matching so MiniMax receives unambiguous hiragana for every kanji compound and NEVER
 *    switches to Mandarin Chinese pronunciation.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ClaudeAgentSettingsSnapshot } from '../../src/claude-chat-types'
import {
  LANGUAGE_PUSH_DEFAULT_TTS_MODEL,
  LANGUAGE_PUSH_DEFAULT_VOICE_EN,
  LANGUAGE_PUSH_DEFAULT_VOICE_JA,
  type LanguagePushConfig,
  type LanguagePushLang,
  type LanguagePushPronunciationHint,
  type LanguagePushSpeakInput,
  type LanguagePushSpeakResult,
} from '../../src/language-push-contract'

export type MiniMaxTtsCredentials = {
  apiKey: string
  origin: string
  model: string
}

export type MiniMaxTtsFetchFn = (input: string, init?: RequestInit) => Promise<Response>

type MiniMaxTtsApiResponse = {
  data?: {
    audio?: string
    status?: number
  }
  trace_id?: string
  base_resp?: {
    status_code?: number
    status_msg?: string
  }
}

const DEFAULT_MINIMAX_ORIGIN = 'https://api.minimaxi.com'
const TTS_CACHE_VERSION = 'v2'
const MAX_TTS_TEXT_LENGTH = 1500
const CJK_RE = /[\u3400-\u9fff]/
const KANA_RE = /[\u3040-\u30ff]/
const KANA_ONLY_RE = /^[\u3040-\u30ffー・\s]+$/
const JAPANESE_WORD_CHAR_RE = /[\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff]/u
const JAPANESE_PARTICLE_RE = /^[はがをにへでともやのからまでより]$/
const FULLWIDTH_DIGITS = '０１２３４５６７８９'

/**
 * Safety-net pronunciation dictionary for frequent diary/engineering Japanese kanji compounds
 * that MiniMax TTS otherwise tends to pronounce with a Chinese accent when sent as bare kanji.
 */
const BUILTIN_JA_PRONUNCIATIONS: readonly LanguagePushPronunciationHint[] = [
  { surface: '環境構築', reading: 'かんきょうこうちく' },
  { surface: '保守運用', reading: 'ほしゅうんよう' },
  { surface: '意図分析', reading: 'いとぶんせき' },
  { surface: '高頻度', reading: 'こうひんど' },
  { surface: '自動化', reading: 'じどうか' },
  { surface: '疎結合', reading: 'そけつごう' },
  { surface: '生成', reading: 'せいせい' },
  { surface: '有用', reading: 'ゆうよう' },
  { surface: '環境', reading: 'かんきょう' },
  { surface: '開発', reading: 'かいはつ' },
  { surface: '設計', reading: 'せっけい' },
  { surface: '運用', reading: 'うんよう' },
  { surface: '保守', reading: 'ほしゅ' },
  { surface: '協働', reading: 'きょうどう' },
  { surface: '意図', reading: 'いと' },
  { surface: '分析', reading: 'ぶんせき' },
  { surface: '日記', reading: 'にっき' },
  { surface: '日誌', reading: 'にっし' },
  { surface: '機能', reading: 'きのう' },
  { surface: '改善', reading: 'かいぜん' },
  { surface: '効率', reading: 'こうりつ' },
  { surface: '検証', reading: 'けんしょう' },
  { surface: '管理', reading: 'かんり' },
  { surface: '学習', reading: 'がくしゅう' },
  { surface: '表現', reading: 'ひょうげん' },
  { surface: '分野', reading: 'ぶんや' },
  { surface: '知識', reading: 'ちしき' },
  { surface: '吸収', reading: 'きゅうしゅう' },
  { surface: '視野', reading: 'しや' },
  { surface: '負担', reading: 'ふたん' },
  { surface: '価値', reading: 'かち' },
  { surface: '影響', reading: 'えいきょう' },
  { surface: '関係', reading: 'かんけい' },
  { surface: '前提', reading: 'ぜんてい' },
  { surface: '義務', reading: 'ぎむ' },
  { surface: '条件', reading: 'じょうけん' },
  { surface: '実装', reading: 'じっそう' },
  { surface: '同期', reading: 'どうき' },
  { surface: '構成', reading: 'こうせい' },
  { surface: '手順', reading: 'てじゅん' },
  { surface: '整理', reading: 'せいり' },
  { surface: '優先', reading: 'ゆうせん' },
  { surface: '判断', reading: 'はんだん' },
  { surface: '確認', reading: 'かくにん' },
  { surface: '提案', reading: 'ていあん' },
  { surface: '課題', reading: 'かだい' },
  { surface: '解決', reading: 'かいけつ' },
  { surface: '継続', reading: 'けいぞく' },
  { surface: '習慣', reading: 'しゅうかん' },
  { surface: '蓄積', reading: 'ちくせき' },
  { surface: '抽出', reading: 'ちゅうしゅつ' },
  { surface: '翻訳', reading: 'ほんやく' },
  { surface: '語彙', reading: 'ごい' },
  { surface: '文法', reading: 'ぶんぽう' },
  { surface: '発音', reading: 'はつおん' },
  { surface: '例文', reading: 'れいぶん' },
  { surface: '記録', reading: 'きろく' },
  { surface: '思考', reading: 'しこう' },
  { surface: '体験', reading: 'たいけん' },
  { surface: '共有', reading: 'きょうゆう' },
  { surface: '発信', reading: 'はっしん' },
  { surface: '公開', reading: 'こうかい' },
  { surface: '保護', reading: 'ほご' },
  { surface: '安全', reading: 'あんぜん' },
  { surface: '設定', reading: 'せってい' },
  { surface: '変更', reading: 'へんこう' },
  { surface: '修正', reading: 'しゅうせい' },
  { surface: '対応', reading: 'たいおう' },
  { surface: '利用', reading: 'りよう' },
  { surface: '活用', reading: 'かつよう' },
  { surface: '実現', reading: 'じつげん' },
  { surface: '成果', reading: 'せいか' },
  { surface: '品質', reading: 'ひんしつ' },
  { surface: '精度', reading: 'せいど' },
  { surface: '導入', reading: 'どうにゅう' },
  { surface: '見通し', reading: 'みとおし' },
]

function toOrigin(rawBaseUrl?: string | null): string {
  const trimmed = (rawBaseUrl || '').trim()
  if (!trimmed) return DEFAULT_MINIMAX_ORIGIN
  try {
    const parsed = new URL(trimmed)
    return parsed.origin
  } catch {
    return DEFAULT_MINIMAX_ORIGIN
  }
}

export function resolveMiniMaxTtsCredentials(
  snapshot: ClaudeAgentSettingsSnapshot | null | undefined,
  preferredModel?: string,
): MiniMaxTtsCredentials | null {
  const providers = snapshot?.settings?.providers ?? []
  const matched = providers.find((p) => {
    const hasKey = Boolean((p.apiKey || '').trim())
    if (!hasKey) return false
    const preset = (p.presetId || '').toLowerCase()
    const base = (p.baseUrl || '').toLowerCase()
    const name = (p.name || '').toLowerCase()
    return preset.includes('minimax') || base.includes('minimax') || name.includes('minimax')
  })

  const model = (preferredModel || '').trim() || LANGUAGE_PUSH_DEFAULT_TTS_MODEL
  if (matched && matched.apiKey?.trim()) {
    return {
      apiKey: matched.apiKey.trim(),
      origin: toOrigin(matched.baseUrl),
      model,
    }
  }

  const envKey = (process.env.MINIMAX_API_KEY || '').trim()
  if (envKey) {
    return {
      apiKey: envKey,
      origin: toOrigin(process.env.MINIMAX_BASE_URL),
      model,
    }
  }

  return null
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) => String(FULLWIDTH_DIGITS.indexOf(char)))
}

function minuteCounterSuffix(minute: string): 'ふん' | 'ぷん' {
  const value = parseInt(toAsciiDigits(minute), 10)
  if (!Number.isFinite(value) || value === 0) return 'ふん'
  const last = value % 10
  return last === 0 || last === 1 || last === 3 || last === 4 || last === 6 || last === 8 ? 'ぷん' : 'ふん'
}

function normalizeJapaneseCounters(text: string): string {
  let out = text
  out = out.replace(/([0-9０-９]{1,2})\s*時\s*([0-9０-９]{1,2})\s*分/g, (_m, hour: string, minute: string) =>
    `${hour}じ${minute}${minuteCounterSuffix(minute)}`,
  )
  out = out.replace(/([0-9０-９]{1,2})\s*時半/g, '$1じ半')
  out = out.replace(/([0-9０-９]{1,2})\s*時/g, '$1じ')
  return out
}

function normalizeHint(hint: LanguagePushPronunciationHint): LanguagePushPronunciationHint | null {
  const surface = (hint?.surface || '').normalize('NFKC').trim()
  const reading = (hint?.reading || '').normalize('NFKC').replace(/^\/+|\/+$/g, '').replace(/\s+/g, '').trim()
  if (!surface || !reading) return null
  if (surface === reading) return null
  if (!KANA_RE.test(reading) || !KANA_ONLY_RE.test(reading)) return null
  if (KANA_ONLY_RE.test(surface)) return null
  if (!CJK_RE.test(surface)) return null
  return { surface, reading }
}

function hasJapaneseSurfaceBoundaries(text: string, offset: number, length: number): boolean {
  const before = offset > 0 ? text[offset - 1] : ''
  const after = text[offset + length] ?? ''
  if (after === '(' || after === '（') return false
  // Allow replacement adjacent to kana/particles/punctuation; block splitting inside a larger kanji compound
  if (before && CJK_RE.test(before)) return false
  if (after && CJK_RE.test(after)) return false
  if (before && JAPANESE_WORD_CHAR_RE.test(before) && !JAPANESE_PARTICLE_RE.test(before) && !KANA_RE.test(before)) {
    return false
  }
  if (after && JAPANESE_WORD_CHAR_RE.test(after) && !JAPANESE_PARTICLE_RE.test(after) && !KANA_RE.test(after)) {
    return false
  }
  return true
}

function isStandaloneJapaneseSurfaceMatch(text: string, offset: number, length: number): boolean {
  const SegmenterCtor = (Intl as unknown as { Segmenter?: new (loc: string, opts: { granularity: string }) => { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> } }).Segmenter
  if (typeof SegmenterCtor === 'function') {
    const segmenter = new SegmenterCtor('ja', { granularity: 'word' })
    for (const seg of segmenter.segment(text)) {
      if (seg.index > offset) break
      if (seg.index !== offset) continue
      if (seg.isWordLike && seg.segment.length === length) {
        return hasJapaneseSurfaceBoundaries(text, offset, length)
      }
      break
    }
  }
  return hasJapaneseSurfaceBoundaries(text, offset, length)
}

/**
 * Ported & strengthened from SentinelLab `tts.ts`:
 * Applies caller-supplied per-sentence pronunciation hints first, then built-in Japanese
 * tech/diary kanji readings, replacing standalone kanji compounds with exact hiragana so
 * MiniMax `speech-2.8-hd` pronounces authentic Japanese without Mandarin bleed.
 */
export function prepareMiniMaxTtsText(
  rawText: string,
  lang: LanguagePushLang,
  pronunciations: LanguagePushPronunciationHint[] = [],
): string {
  let text = (rawText || '')
    .normalize('NFKC')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

  if (lang !== 'ja') return text

  // Strip grammar placeholders like `～` and inline furigana brackets `漢字（かんじ）`
  text = text.replace(/[～〜~]/g, '').replace(/[（(][\u3040-\u30ffー・\s]+[）)]/g, '').trim()
  text = normalizeJapaneseCounters(text)

  // Deduplicate hints: caller-supplied hints take precedence over built-in defaults
  const bySurface = new Map<string, LanguagePushPronunciationHint>()
  for (const raw of BUILTIN_JA_PRONUNCIATIONS) {
    const norm = normalizeHint(raw)
    if (norm) bySurface.set(norm.surface, norm)
  }
  for (const raw of pronunciations) {
    const norm = normalizeHint(raw)
    if (norm) bySurface.set(norm.surface, norm)
  }

  // Exact full-text match (e.g. clicking "朗读" on single kanji word "生成") -> direct kana reading
  const exactFull = bySurface.get(text)
  if (exactFull) return exactFull.reading

  const sorted = [...bySurface.values()].sort((a, b) => b.surface.length - a.surface.length)
  for (const { surface, reading } of sorted) {
    const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'g')
    text = text.replace(re, (match, offset: number, fullText: string) => {
      if (!isStandaloneJapaneseSurfaceMatch(fullText, offset, match.length)) return match
      return reading
    })
  }

  return text.replace(/\s+/g, ' ').trim()
}

function resolveDefaultFetch(): MiniMaxTtsFetchFn {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { net?: { fetch?: MiniMaxTtsFetchFn } }
    if (electron?.net?.fetch) {
      return electron.net.fetch.bind(electron.net)
    }
  } catch {
    /* plain Node test environment */
  }
  return globalThis.fetch.bind(globalThis)
}

function isHexAudio(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)
}

export async function synthesizeLanguagePushSpeech(params: {
  credentials: MiniMaxTtsCredentials | null
  config: Pick<LanguagePushConfig, 'speechRate' | 'ttsVoiceEn' | 'ttsVoiceJa' | 'ttsModel'>
  input: LanguagePushSpeakInput
  cacheDir: string
  fetchFn?: MiniMaxTtsFetchFn
}): Promise<LanguagePushSpeakResult> {
  const { credentials, config, input, cacheDir } = params
  if (!credentials || !credentials.apiKey.trim()) {
    return {
      ok: false,
      code: 'tts_not_configured',
      message: '未检测到 MiniMax API Key，已自动回退本机离线朗读。',
    }
  }

  const lang: LanguagePushLang = input.lang === 'ja' ? 'ja' : 'en'
  const preparedText = prepareMiniMaxTtsText(input.text, lang, input.pronunciations ?? [])
  if (!preparedText) {
    return { ok: false, code: 'tts_error', message: '朗读文本为空。' }
  }
  if (preparedText.length > MAX_TTS_TEXT_LENGTH) {
    return { ok: false, code: 'tts_error', message: '朗读文本过长。' }
  }

  const voiceId =
    (input.voiceId || '').trim() ||
    (lang === 'ja'
      ? config.ttsVoiceJa || LANGUAGE_PUSH_DEFAULT_VOICE_JA
      : config.ttsVoiceEn || LANGUAGE_PUSH_DEFAULT_VOICE_EN)
  const model = (credentials.model || config.ttsModel || LANGUAGE_PUSH_DEFAULT_TTS_MODEL).trim()
  const speed = Number(
    Math.max(
      0.6,
      Math.min(1.5, typeof input.speed === 'number' && Number.isFinite(input.speed) ? input.speed : config.speechRate || 0.95),
    ).toFixed(2),
  )

  const cacheKey = createHash('sha1')
    .update(JSON.stringify({ v: TTS_CACHE_VERSION, model, voiceId, speed, lang, text: preparedText }))
    .digest('hex')
  const cacheFile = path.join(cacheDir, `${cacheKey}.mp3`)

  if (existsSync(cacheFile)) {
    try {
      const buf = readFileSync(cacheFile)
      if (buf.length > 0) {
        return {
          ok: true,
          audioBase64: buf.toString('base64'),
          mime: 'audio/mpeg',
          voiceId,
          provider: 'minimax',
          cached: true,
        }
      }
    } catch {
      /* ignore corrupt cache and re-synthesize */
    }
  }

  const url = `${credentials.origin.replace(/\/+$/, '')}/v1/t2a_v2`
  const fetchFn = params.fetchFn ?? resolveDefaultFetch()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        text: preparedText,
        stream: false,
        output_format: 'hex',
        voice_setting: {
          voice_id: voiceId,
          speed,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
        language_boost: lang === 'ja' ? 'Japanese' : 'English',
        subtitle_enable: false,
      }),
      signal: controller.signal,
    })

    const payload = (await response.json().catch(() => null)) as MiniMaxTtsApiResponse | null
    if (!response.ok) {
      return {
        ok: false,
        code: 'tts_error',
        message: payload?.base_resp?.status_msg || `MiniMax TTS HTTP ${response.status}`,
      }
    }
    if (payload?.base_resp?.status_code != null && payload.base_resp.status_code !== 0) {
      return {
        ok: false,
        code: 'tts_error',
        message: payload.base_resp.status_msg || `MiniMax TTS error (${payload.base_resp.status_code})`,
      }
    }
    const audioHex = payload?.data?.audio
    if (!audioHex || !isHexAudio(audioHex)) {
      return {
        ok: false,
        code: 'tts_error',
        message: 'MiniMax TTS 未返回有效音频数据。',
      }
    }

    const mp3Buffer = Buffer.from(audioHex, 'hex')
    try {
      mkdirSync(cacheDir, { recursive: true })
      const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, mp3Buffer)
      renameSync(tmp, cacheFile)
    } catch {
      /* cache write failure must not fail playback */
    }

    return {
      ok: true,
      audioBase64: mp3Buffer.toString('base64'),
      mime: 'audio/mpeg',
      voiceId,
      provider: 'minimax',
      cached: false,
    }
  } catch (error) {
    return {
      ok: false,
      code: 'tts_error',
      message: error instanceof Error ? error.message : 'MiniMax TTS 请求失败',
    }
  } finally {
    clearTimeout(timer)
  }
}
