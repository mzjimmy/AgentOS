/**
 * MiniMax HD Mandarin podcast synthesizer & MP3 stitcher for SentinelDesk Morning Brief.
 *
 * - Reuses `resolveMiniMaxTtsCredentials` from `language-push-tts.ts`.
 * - Synthesizes intro + story sections with local SHA-1 MP3 disk caching.
 * - Optionally concatenates CBR MP3 buffers into `<deskRoot>/briefings/issues/YYYY-MM-DD.mp3`
 *   so the user can upload a single complete audio file to WeChat Official Account.
 * - Falls back gracefully with structured `segments` when MiniMax is unconfigured.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  MORNING_BRIEF_DEFAULT_TTS_MODEL,
  MORNING_BRIEF_DEFAULT_VOICE_ZH,
  type MorningBriefConfig,
  type MorningBriefIssue,
  type MorningBriefSpeakResult,
  type MorningBriefSpeakSegment,
} from '../../src/morning-brief-contract'
import type { MiniMaxTtsCredentials, MiniMaxTtsFetchFn } from './language-push-tts'

const TTS_CACHE_VERSION = 'mb-zh-v2'
const FALLBACK_UNIVERSAL_VOICE = 'presenter_male'
const LEADING_ITEM_NUMBER_RE =
  /^(?:第\s*[0-9０-９一二三四五六七八九十两百]+\s*[条节篇个项则]|[0-9０-９]{1,2}\s*[.、:：])\s*[，,、:：.\s]*/u

type MiniMaxTtsApiResponse = {
  data?: {
    audio?: string
  }
  base_resp?: {
    status_code?: number
    status_msg?: string
  }
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

export function buildMorningBriefSpeakSegments(issue: MorningBriefIssue): MorningBriefSpeakSegment[] {
  const segments: MorningBriefSpeakSegment[] = [
    {
      sectionIndex: 0,
      label: '导读综述',
      text: `每日 AI 早报，${issue.headlineDateLabel}。${issue.introParagraph}`
        .replace(/\s+/g, ' ')
        .trim(),
    },
  ]

  issue.items.forEach((item, idx) => {
    const rawSpoken = (item.spokenText || `${item.title}。${item.body}`).replace(/\s+/g, ' ').trim()
    const cleanedSpoken = rawSpoken.replace(LEADING_ITEM_NUMBER_RE, '').trim() || rawSpoken
    segments.push({
      sectionIndex: idx + 1,
      label: `${idx + 1}. ${item.title}`,
      text: cleanedSpoken,
    })
  })

  return segments
}

async function synthesizeOneMandarinBuffer(params: {
  credentials: MiniMaxTtsCredentials
  text: string
  voiceId: string
  speed: number
  model: string
  cacheDir: string
  fetchFn: MiniMaxTtsFetchFn
}): Promise<{ ok: true; buffer: Buffer } | { ok: false; statusCode?: number; message: string }> {
  const { credentials, text, voiceId, speed, model, cacheDir, fetchFn } = params
  const clipped = text.slice(0, 1450).trim()
  const cacheKey = createHash('sha1')
    .update(JSON.stringify({ v: TTS_CACHE_VERSION, model, voiceId, speed, text: clipped }))
    .digest('hex')
  const cacheFile = path.join(cacheDir, `${cacheKey}.mp3`)

  if (existsSync(cacheFile)) {
    try {
      const buf = readFileSync(cacheFile)
      if (buf.length > 0) return { ok: true, buffer: buf }
    } catch {
      /* regenerate on corrupt cache */
    }
  }

  const url = `${credentials.origin.replace(/\/+$/, '')}/v1/t2a_v2`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        text: clipped,
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
        language_boost: 'Chinese',
        subtitle_enable: false,
      }),
      signal: controller.signal,
    })

    const payload = (await response.json().catch(() => null)) as MiniMaxTtsApiResponse | null
    if (!response.ok) {
      return {
        ok: false,
        statusCode: payload?.base_resp?.status_code,
        message: payload?.base_resp?.status_msg || `MiniMax TTS HTTP ${response.status}`,
      }
    }
    if (payload?.base_resp?.status_code != null && payload.base_resp.status_code !== 0) {
      return {
        ok: false,
        statusCode: payload.base_resp.status_code,
        message: payload.base_resp.status_msg || `MiniMax TTS error (${payload.base_resp.status_code})`,
      }
    }
    const audioHex = payload?.data?.audio
    if (!audioHex || !isHexAudio(audioHex)) {
      return { ok: false, message: 'MiniMax TTS 未返回有效音频数据。' }
    }

    const buffer = Buffer.from(audioHex, 'hex')
    try {
      mkdirSync(cacheDir, { recursive: true })
      const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, buffer)
      renameSync(tmp, cacheFile)
    } catch {
      /* non-fatal */
    }
    return { ok: true, buffer }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'MiniMax TTS 请求失败',
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function synthesizeMorningBriefAudio(params: {
  issue: MorningBriefIssue
  credentials: MiniMaxTtsCredentials | null
  config: Pick<MorningBriefConfig, 'speechRate' | 'ttsVoiceZh' | 'ttsModel'>
  cacheDir: string
  stitchedOutputPath?: string
  sectionIndex?: number
  stitchFullIssue?: boolean
  fetchFn?: MiniMaxTtsFetchFn
}): Promise<MorningBriefSpeakResult> {
  const allSegments = buildMorningBriefSpeakSegments(params.issue)
  const targetSegments =
    typeof params.sectionIndex === 'number' && !params.stitchFullIssue
      ? allSegments.filter((seg) => seg.sectionIndex === params.sectionIndex)
      : allSegments

  if (targetSegments.length === 0) {
    return {
      ok: false,
      code: 'tts_error',
      message: '未找到对应早报小节。',
      segments: [],
    }
  }

  if (!params.credentials || !params.credentials.apiKey.trim()) {
    return {
      ok: false,
      code: 'tts_not_configured',
      message: '未配置 MiniMax 密钥，已切换为本机离线语音播报。',
      segments: targetSegments,
    }
  }

  const fetchFn = params.fetchFn ?? resolveDefaultFetch()
  const model = (params.credentials.model || params.config.ttsModel || MORNING_BRIEF_DEFAULT_TTS_MODEL).trim()
  const speed = 1.0
  let activeVoiceId = (params.config.ttsVoiceZh || MORNING_BRIEF_DEFAULT_VOICE_ZH).trim()

  const buffers: Buffer[] = []
  const resolvedSegments: MorningBriefSpeakSegment[] = []

  for (const seg of targetSegments) {
    let res = await synthesizeOneMandarinBuffer({
      credentials: params.credentials,
      text: seg.text,
      voiceId: activeVoiceId,
      speed,
      model,
      cacheDir: params.cacheDir,
      fetchFn,
    })

    if (!res.ok && activeVoiceId !== FALLBACK_UNIVERSAL_VOICE) {
      activeVoiceId = FALLBACK_UNIVERSAL_VOICE
      res = await synthesizeOneMandarinBuffer({
        credentials: params.credentials,
        text: seg.text,
        voiceId: activeVoiceId,
        speed,
        model,
        cacheDir: params.cacheDir,
        fetchFn,
      })
    }

    if (!res.ok) {
      return {
        ok: false,
        code: 'tts_error',
        message: res.message,
        segments: targetSegments,
      }
    }

    buffers.push(res.buffer)
    resolvedSegments.push({
      ...seg,
      audioBase64: res.buffer.toString('base64'),
      mime: 'audio/mpeg',
    })
  }

  let stitchedAudioPath: string | null = null
  if (params.stitchFullIssue && params.stitchedOutputPath && buffers.length === allSegments.length) {
    try {
      mkdirSync(path.dirname(params.stitchedOutputPath), { recursive: true })
      const combined = Buffer.concat(buffers)
      const tmp = `${params.stitchedOutputPath}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, combined)
      renameSync(tmp, params.stitchedOutputPath)
      stitchedAudioPath = params.stitchedOutputPath
    } catch {
      stitchedAudioPath = null
    }
  }

  return {
    ok: true,
    provider: 'minimax',
    segments: resolvedSegments,
    stitchedAudioPath,
  }
}
