/**
 * Zero-dependency vertical AI / Coding Agent / DevTools feed fetcher & URL deduplicator
 * for SentinelDesk Morning Brief (evolved from NewsAgent `services/hotspot.ts`).
 *
 * Supports RSS 2.0, Atom, Hugging Face Daily Papers JSON, and AI-filtered Hacker News stories.
 */

import { createHash } from 'node:crypto'
import type {
  MorningBriefRawCandidate,
  MorningBriefSourceConfig,
} from '../../src/morning-brief-contract'

export type MorningBriefFetchFn = (input: string, init?: RequestInit) => Promise<Response>

const SOURCE_TIMEOUT_MS = 12_000
const HN_ITEM_CONCURRENCY = 8
const HN_TOP_SCAN_LIMIT = 40

const AI_RELEVANCE_RE =
  /\b(ai|llm|agent|agents|claude|anthropic|openai|gpt|gemini|deepmind|deepseek|qwen|minimax|mistral|llama|mcp|coding|cursor|codex|copilot|swe|rag|benchmark|inference|transformer|diffusion|vlm|tts|asr|nvidia|gpu|hugging\s*face|arxiv|open-source|model|sdk|cli|sandbox|eval)\b|(人工智能|大模型|智能体|编程|开源|算力|英伟达|推理|多模态|语音合成)/i

function resolveDefaultFetch(): MorningBriefFetchFn {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { net?: { fetch?: MorningBriefFetchFn } }
    if (electron?.net?.fetch) {
      return electron.net.fetch.bind(electron.net)
    }
  } catch {
    /* plain Node test environment */
  }
  return globalThis.fetch.bind(globalThis)
}

async function fetchWithTimeout(
  fetchFn: MorningBriefFetchFn,
  url: string,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, {
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*',
        'User-Agent': 'SentinelDesk-MorningBrief/1.0',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export function decodeXmlEntities(raw: string): string {
  if (!raw) return ''
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
  return withoutCdata
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&#([0-9]+);/g, (_m, dec: string) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

export function stripHtmlToPlainText(raw: string, maxLen = 360): string {
  const decoded = decodeXmlEntities(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (decoded.length <= maxLen) return decoded
  return `${decoded.slice(0, maxLen - 1).trim()}…`
}

function extractXmlTag(block: string, tagNames: readonly string[]): string {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
    const match = block.match(re)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }
  return ''
}

function extractAtomOrRssLink(block: string): string {
  const alternateHref = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
  if (alternateHref?.[1]) return decodeXmlEntities(alternateHref[1].trim())

  const anyHref = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i)
  if (anyHref?.[1]) return decodeXmlEntities(anyHref[1].trim())

  const textLink = extractXmlTag(block, ['link', 'guid'])
  const cleaned = decodeXmlEntities(textLink).trim()
  return /^https?:\/\//i.test(cleaned) ? cleaned : ''
}

function makeCandidateId(sourceId: string, url: string, title: string): string {
  return `mbc_${createHash('sha1').update(`${sourceId}|${url}|${title}`).digest('hex').slice(0, 12)}`
}

export function parseXmlFeedItems(
  xml: string,
  source: Pick<MorningBriefSourceConfig, 'id' | 'name'>,
  perSourceCap = 14,
): MorningBriefRawCandidate[] {
  if (!xml || typeof xml !== 'string') return []
  const items: MorningBriefRawCandidate[] = []

  const rssBlocks = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1])
  const atomBlocks =
    rssBlocks.length > 0
      ? []
      : [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => m[1])

  const blocks = rssBlocks.length > 0 ? rssBlocks : atomBlocks

  for (const block of blocks) {
    if (items.length >= perSourceCap) break
    const rawTitle = extractXmlTag(block, ['title'])
    const title = stripHtmlToPlainText(rawTitle, 180)
    const url = extractAtomOrRssLink(block)
    if (!title || !url || !/^https?:\/\//i.test(url)) continue

    const rawSummary = extractXmlTag(block, [
      'description',
      'summary',
      'content:encoded',
      'content',
    ])
    const summary = stripHtmlToPlainText(rawSummary, 340)
    const rawDate = extractXmlTag(block, ['pubDate', 'published', 'updated', 'dc:date'])
    const parsedTime = rawDate ? Date.parse(decodeXmlEntities(rawDate)) : NaN
    const publishedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : undefined

    items.push({
      id: makeCandidateId(source.id, url, title),
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      summary,
      publishedAt,
      score: AI_RELEVANCE_RE.test(`${title} ${summary}`) ? 20 : 8,
    })
  }

  return items
}

export async function fetchHuggingFacePapers(
  source: MorningBriefSourceConfig,
  fetchFn: MorningBriefFetchFn,
): Promise<MorningBriefRawCandidate[]> {
  const response = await fetchWithTimeout(fetchFn, source.url)
  if (!response.ok) return []
  const data = (await response.json().catch(() => null)) as unknown
  if (!Array.isArray(data)) return []

  const out: MorningBriefRawCandidate[] = []
  for (const entry of data.slice(0, 12)) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as {
      publishedAt?: string
      paper?: { id?: string; title?: string; summary?: string; upvotes?: number }
      title?: string
      summary?: string
    }
    const paperId = rec.paper?.id?.trim()
    const title = stripHtmlToPlainText(rec.paper?.title || rec.title || '', 180)
    if (!paperId || !title) continue
    const url = `https://huggingface.co/papers/${encodeURIComponent(paperId)}`
    const summary = stripHtmlToPlainText(rec.paper?.summary || rec.summary || '', 340)
    const upvotes = typeof rec.paper?.upvotes === 'number' ? rec.paper.upvotes : 0
    out.push({
      id: makeCandidateId(source.id, url, title),
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      summary,
      publishedAt: rec.publishedAt,
      score: 18 + Math.min(20, Math.floor(upvotes / 5)),
    })
  }
  return out
}

export async function fetchHackerNewsAiStories(
  source: MorningBriefSourceConfig,
  fetchFn: MorningBriefFetchFn,
): Promise<MorningBriefRawCandidate[]> {
  const response = await fetchWithTimeout(fetchFn, source.url)
  if (!response.ok) return []
  const ids = (await response.json().catch(() => null)) as unknown
  if (!Array.isArray(ids)) return []

  const topIds = ids.filter((id): id is number => typeof id === 'number').slice(0, HN_TOP_SCAN_LIMIT)
  const stories: Array<{
    id: number
    title?: string
    url?: string
    score?: number
    descendants?: number
    time?: number
  } | null> = []

  for (let i = 0; i < topIds.length; i += HN_ITEM_CONCURRENCY) {
    const batch = topIds.slice(i, i + HN_ITEM_CONCURRENCY)
    const fetched = await Promise.all(
      batch.map(async (id) => {
        try {
          const itemRes = await fetchWithTimeout(
            fetchFn,
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
            7_000,
          )
          if (!itemRes.ok) return null
          return (await itemRes.json().catch(() => null)) as {
            id: number
            title?: string
            url?: string
            score?: number
            descendants?: number
            time?: number
          } | null
        } catch {
          return null
        }
      }),
    )
    stories.push(...fetched)
  }

  const out: MorningBriefRawCandidate[] = []
  for (const story of stories) {
    if (!story?.title) continue
    const title = stripHtmlToPlainText(story.title, 180)
    if (!AI_RELEVANCE_RE.test(title)) continue
    const url =
      story.url && /^https?:\/\//i.test(story.url)
        ? story.url
        : `https://news.ycombinator.com/item?id=${story.id}`
    const points = typeof story.score === 'number' ? story.score : 0
    const comments = typeof story.descendants === 'number' ? story.descendants : 0
    out.push({
      id: makeCandidateId(source.id, url, title),
      title,
      url,
      sourceId: source.id,
      sourceName: source.name,
      summary: `Hacker News ${points} points · ${comments} comments`,
      publishedAt: typeof story.time === 'number' ? new Date(story.time * 1000).toISOString() : undefined,
      score: 15 + Math.min(25, Math.floor(points / 15)),
    })
  }

  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 14)
}

export function normalizeCandidateUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim())
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|spm$)/i.test(key)) {
        parsed.searchParams.delete(key)
      }
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '') || '/'
    const search = parsed.searchParams.toString()
    return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${cleanPath}${search ? `?${search}` : ''}`
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '')
  }
}

export function deduplicateAndRankCandidates(
  candidates: readonly MorningBriefRawCandidate[],
  maxTotal = 42,
): MorningBriefRawCandidate[] {
  const seenUrls = new Set<string>()
  const seenTitles = new Set<string>()
  const unique: MorningBriefRawCandidate[] = []

  const sorted = [...candidates].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0)
    if (scoreDiff !== 0) return scoreDiff
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0
    return tb - ta
  })

  for (const item of sorted) {
    const urlKey = normalizeCandidateUrl(item.url)
    const titleKey = item.title.toLowerCase().replace(/[\s\p{P}]+/gu, '').slice(0, 48)
    if (!urlKey || !titleKey) continue
    if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) continue
    seenUrls.add(urlKey)
    seenTitles.add(titleKey)
    unique.push(item)
    if (unique.length >= maxTotal) break
  }

  return unique
}

export async function fetchAllMorningBriefCandidates(params: {
  sources: readonly MorningBriefSourceConfig[]
  fetchFn?: MorningBriefFetchFn
  maxTotal?: number
}): Promise<{ candidates: MorningBriefRawCandidate[]; sourceHitCount: number }> {
  const fetchFn = params.fetchFn ?? resolveDefaultFetch()
  const enabledSources = params.sources.filter((s) => s.enabled && /^https?:\/\//i.test(s.url.trim()))
  if (enabledSources.length === 0) {
    return { candidates: [], sourceHitCount: 0 }
  }

  const settled = await Promise.allSettled(
    enabledSources.map(async (source) => {
      if (source.kind === 'huggingface_papers') {
        return fetchHuggingFacePapers(source, fetchFn)
      }
      if (source.kind === 'hackernews') {
        return fetchHackerNewsAiStories(source, fetchFn)
      }
      const res = await fetchWithTimeout(fetchFn, source.url)
      if (!res.ok) return []
      const xml = await res.text()
      return parseXmlFeedItems(xml, source)
    }),
  )

  const all: MorningBriefRawCandidate[] = []
  let sourceHitCount = 0
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && outcome.value.length > 0) {
      sourceHitCount += 1
      all.push(...outcome.value)
    }
  }

  return {
    candidates: deduplicateAndRankCandidates(all, params.maxTotal ?? 42),
    sourceHitCount,
  }
}
