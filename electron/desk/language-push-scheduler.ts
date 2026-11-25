/**
 * Pure deterministic scheduler, canonical deduplication, threshold filtering,
 * 7-day translated corpus high-frequency mining, anti-bloat backlog pruning,
 * and TTS text preparation for SentinelDesk Language Push.
 */

import {
  LANGUAGE_PUSH_DEFAULT_BACKLOG_CAP,
  LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS,
  LANGUAGE_PUSH_STALE_ARCHIVE_DAYS,
  LANGUAGE_PUSH_UNFAMILIAR_INTERVAL_DAYS,
  type LanguagePushCard,
  type LanguagePushCardKind,
  type LanguagePushConfig,
  type LanguagePushCorpusItem,
  type LanguagePushFamiliarity,
  type LanguagePushLang,
} from '../../src/language-push-contract'
import { shiftDateString } from './intent-todo-time'

/**
 * Curated basic English words below the default 1500-word threshold.
 * Prevents trivial slips from cloud extraction or corpus mining from wasting daily budget.
 */
const BASIC_EN_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how', 'who', 'what', 'which',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'here', 'there', 'now', 'today', 'tomorrow', 'yesterday',
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'done',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'go', 'get', 'make', 'take', 'come', 'see', 'know', 'think', 'want', 'need', 'use', 'find', 'give', 'tell', 'work',
  'call', 'try', 'ask', 'feel', 'become', 'leave', 'put', 'mean', 'keep', 'let', 'begin', 'seem', 'help', 'talk',
  'turn', 'start', 'show', 'hear', 'play', 'run', 'move', 'like', 'live', 'believe', 'hold', 'bring', 'happen',
  'write', 'sit', 'stand', 'lose', 'pay', 'meet', 'include', 'continue', 'set', 'learn', 'change', 'lead', 'watch',
  'follow', 'stop', 'create', 'speak', 'read', 'allow', 'add', 'spend', 'grow', 'open', 'walk', 'win', 'offer', 'remember',
  'love', 'buy', 'wait', 'serve', 'die', 'send', 'expect', 'build', 'stay', 'fall', 'cut', 'reach', 'kill', 'remain',
  'good', 'bad', 'big', 'small', 'large', 'little', 'long', 'short', 'high', 'low', 'old', 'new', 'young', 'great',
  'right', 'wrong', 'true', 'false', 'early', 'late', 'fast', 'slow', 'hard', 'easy', 'happy', 'sad', 'hot', 'cold',
  'warm', 'cool', 'nice', 'fine', 'ok', 'okay', 'yes', 'no', 'not', 'very', 'much', 'many', 'more', 'most', 'some', 'any',
  'all', 'both', 'each', 'few', 'other', 'another', 'such', 'only', 'own', 'same', 'so', 'than', 'too', 'also', 'just',
  'about', 'after', 'before', 'between', 'into', 'from', 'with', 'without', 'through', 'during', 'under', 'over', 'again',
  'still', 'already', 'really', 'around', 'because', 'while', 'since', 'until', 'though', 'although', 'however', 'instead',
  'time', 'day', 'days', 'year', 'week', 'month', 'hour', 'minute', 'way', 'man', 'woman', 'child', 'people', 'person', 'life',
  'world', 'hand', 'part', 'place', 'case', 'point', 'thing', 'things', 'fact', 'home', 'house', 'room', 'water', 'food', 'money',
  'book', 'car', 'phone', 'friend', 'family', 'school', 'job', 'name', 'number', 'night', 'morning', 'evening', 'hello', 'thanks',
  'using', 'used', 'made', 'making', 'going', 'doing', 'working', 'getting', 'having', 'being', 'trying', 'looking', 'found',
])

/**
 * Curated basic Japanese N5/ultra-common tokens filtered out when jaLevel >= N4.
 */
const BASIC_JA_STOPWORDS = new Set([
  'これ', 'それ', 'あれ', 'どれ', 'ここ', 'そこ', 'あそこ', 'どこ', 'わたし', '私', 'あなた', '彼', '彼女',
  'する', 'ある', 'いる', 'なる', 'いく', '行く', 'くる', '来る', 'みる', '見る', 'いう', '言う', '思う', 'おもう',
  '食べる', 'たべる', '飲む', 'のむ', '寝る', 'ねる', '起きる', 'おきる', '買う', 'かう', '読む', 'よむ', '書く', 'かく',
  '今日', 'きょう', '明日', 'あした', '昨日', 'きのう', '今', 'いま', '毎日', 'まいにち', '時間', 'じかん',
  '良い', 'いい', 'よい', '悪い', 'わるい', '大きい', '小さい', '新しい', '古い', '多い', '少ない', '高い', '安い',
  '人', 'ひと', 'こと', 'もの', 'とき', 'ところ', 'ため', 'とても', 'すごく', 'ちょっと', 'もう', 'まだ', 'また',
  'はい', 'いいえ', 'ありがとう', 'おはよう', 'こんにちは', 'こんばんは', 'です', 'ます', 'した', 'して', 'いる', 'ない',
  'ため', 'よう', 'など', 'から', 'まで', 'ので', 'のに', 'けど', 'けれど', 'しかし', 'そして', 'また', 'でも',
])

export type CorpusHighFreqTerm = {
  term: string
  wordKey: string
  docDays: number
  totalCount: number
  sampleSentence: string
  sampleDate: string
  sampleEntryId: string
}

export function normalizeCanonicalKey(surface: string, lang: LanguagePushLang): string {
  const nfkc = (surface || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!nfkc) return ''
  return lang === 'en' ? nfkc.toLowerCase() : nfkc
}

export function normalizeReadingKey(reading: string | null | undefined): string {
  return (reading || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 3-tier familiarity SRS calculation:
 * - `'unfamiliar'` (陌生): always re-surfaces in +1 day.
 * - `'fuzzy'` (模糊): progresses through [3, 7, 14, 30] days based on prior exposures.
 */
export function scheduleNextReview(
  exposuresBefore: number,
  today: string,
  familiarity: Exclude<LanguagePushFamiliarity, 'familiar'> = 'fuzzy',
): string {
  if (familiarity === 'unfamiliar') {
    return shiftDateString(today, LANGUAGE_PUSH_UNFAMILIAR_INTERVAL_DAYS)
  }
  const index = Math.min(
    Math.max(0, Math.floor(Number.isFinite(exposuresBefore) ? exposuresBefore : 0)),
    LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS.length - 1,
  )
  const days = LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS[index]
  return shiftDateString(today, days)
}

/**
 * Deterministic floor guard so basic words below threshold never consume daily budget.
 */
export function isBelowDifficultyThreshold(
  surface: string,
  lang: LanguagePushLang,
  kind: LanguagePushCardKind,
  _config: Pick<LanguagePushConfig, 'enLevel' | 'jaLevel'>,
): boolean {
  const key = normalizeCanonicalKey(surface, lang)
  if (!key) return true
  if (kind === 'grammar') {
    return key.length < 2
  }
  if (lang === 'en') {
    if (key.length <= 2) return true
    if (/^\d+$/.test(key)) return true
    return BASIC_EN_STOPWORDS.has(key)
  }
  if (lang === 'ja') {
    if (key.length <= 1 && /^[\u3040-\u309f\u30a0-\u30ff]$/.test(key)) return true
    return BASIC_JA_STOPWORDS.has(key)
  }
  return false
}

/**
 * Mines threshold-passing high-frequency terms from recent translated corpus items
 * (default 7-day sliding window). Pure & zero external dependency.
 */
export function extractCorpusHighFreqTerms(
  corpusItems: readonly LanguagePushCorpusItem[],
  lang: LanguagePushLang,
  config: Pick<LanguagePushConfig, 'enLevel' | 'jaLevel'>,
  excludedWordKeys: ReadonlySet<string>,
  maxTerms = 14,
): CorpusHighFreqTerm[] {
  const stats = new Map<
    string,
    {
      term: string
      days: Set<string>
      count: number
      sampleSentence: string
      sampleDate: string
      sampleEntryId: string
    }
  >()

  const minEnLen = config.enLevel === '5000' ? 6 : config.enLevel === '3000' ? 5 : 4
  const jaSegmenter =
    lang === 'ja' && typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('ja', { granularity: 'word' })
      : null

  for (const item of corpusItems) {
    if (item.lang !== lang || !item.translatedText?.trim()) continue
    const text = item.translatedText.trim()
    const snippet = text.slice(0, 140)

    const tokens: string[] = []
    if (lang === 'en') {
      const matches = text.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? []
      for (const m of matches) {
        const cleaned = m.replace(/^['-]+|['-]+$/g, '')
        if (cleaned.length >= minEnLen) tokens.push(cleaned)
      }
    } else {
      // Extract contiguous Kanji compounds (2..8 chars) & Katakana loanwords (3..16 chars)
      // so technical compounds like 疎結合 / 保守性 are preserved intact, then supplement with
      // Intl.Segmenter word segments when they add distinct multi-char kanji words.
      const seenInItem = new Set<string>()
      const compoundMatches = text.match(/[\u4e00-\u9fff]{2,8}|[\u30a0-\u30ffー]{3,16}/g) ?? []
      for (const m of compoundMatches) {
        tokens.push(m)
        seenInItem.add(m)
      }
      if (jaSegmenter) {
        for (const seg of jaSegmenter.segment(text)) {
          if (!seg.isWordLike) continue
          const w = seg.segment.trim()
          if (w.length < 2 || seenInItem.has(w)) continue
          if (/[\u4e00-\u9fff]/.test(w) && /[\u3040-\u309f]/.test(w)) {
            tokens.push(w)
            seenInItem.add(w)
          }
        }
      }
    }

    for (const token of tokens) {
      if (isBelowDifficultyThreshold(token, lang, 'vocab', config)) continue
      const key = normalizeCanonicalKey(token, lang)
      if (!key || excludedWordKeys.has(key)) continue
      const existing = stats.get(key)
      if (existing) {
        existing.count += 1
        existing.days.add(item.sourceDate)
        if (item.sourceDate > existing.sampleDate) {
          existing.sampleDate = item.sourceDate
          existing.sampleSentence = snippet
          existing.sampleEntryId = item.entryId
        }
      } else {
        stats.set(key, {
          term: lang === 'en' ? key : token,
          days: new Set([item.sourceDate]),
          count: 1,
          sampleSentence: snippet,
          sampleDate: item.sourceDate,
          sampleEntryId: item.entryId,
        })
      }
    }
  }

  return [...stats.entries()]
    .map(([wordKey, entry]) => ({
      term: entry.term,
      wordKey,
      docDays: entry.days.size,
      totalCount: entry.count,
      sampleSentence: entry.sampleSentence,
      sampleDate: entry.sampleDate,
      sampleEntryId: entry.sampleEntryId,
    }))
    .sort((a, b) => {
      if (a.docDays !== b.docDays) return b.docDays - a.docDays
      if (a.totalCount !== b.totalCount) return b.totalCount - a.totalCount
      if (a.sampleDate !== b.sampleDate) return b.sampleDate.localeCompare(a.sampleDate)
      return b.term.length - a.term.length
    })
    .slice(0, maxTerms)
}

/**
 * Cleans markdown emphasis and inline furigana brackets (`漢字（かんじ）` / `漢字(かんじ)`)
 * so offline Web Speech synthesis speaks naturally without spelling out parenthetical readings.
 */
export function prepareSpeechText(text: string, lang: LanguagePushLang): string {
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

function familiarityPriorityRank(card: LanguagePushCard): number {
  if (card.familiarity === 'unfamiliar') return 3
  if (card.familiarity === 'fuzzy') return 2
  return 1
}

function compareCardPriority(a: LanguagePushCard, b: LanguagePushCard, today: string): number {
  const aUnfamiliar = a.familiarity === 'unfamiliar' ? 1 : 0
  const bUnfamiliar = b.familiarity === 'unfamiliar' ? 1 : 0
  if (aUnfamiliar !== bUnfamiliar) return bUnfamiliar - aUnfamiliar

  const aOverdue = a.dueAt < today ? 1 : 0
  const bOverdue = b.dueAt < today ? 1 : 0
  if (aOverdue !== bOverdue) return bOverdue - aOverdue

  const aRank = familiarityPriorityRank(a)
  const bRank = familiarityPriorityRank(b)
  if (aRank !== bRank) return bRank - aRank

  if (a.seenDays !== b.seenDays) return b.seenDays - a.seenDays
  const aFreq = a.corpusFreq ?? 1
  const bFreq = b.corpusFreq ?? 1
  if (aFreq !== bFreq) return bFreq - aFreq
  if (a.lastSeenDate !== b.lastSeenDate) return b.lastSeenDate.localeCompare(a.lastSeenDate)
  return b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * Retention score comparator for anti-bloat backlog pruning (higher priority kept in active pool).
 */
function compareRetentionPriority(a: LanguagePushCard, b: LanguagePushCard): number {
  const aRank = familiarityPriorityRank(a)
  const bRank = familiarityPriorityRank(b)
  if (aRank !== bRank) return bRank - aRank
  if (a.seenDays !== b.seenDays) return b.seenDays - a.seenDays
  const aFreq = a.corpusFreq ?? 1
  const bFreq = b.corpusFreq ?? 1
  if (aFreq !== bFreq) return bFreq - aFreq
  if (a.lastSeenDate !== b.lastSeenDate) return b.lastSeenDate.localeCompare(a.lastSeenDate)
  return b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * Anti-bloat guard:
 * 1. Auto-archives stale untouched single-day cards older than `LANGUAGE_PUSH_STALE_ARCHIVE_DAYS` (14d).
 * 2. Caps active backlog cards to `config.backlogCap` (default 40), archiving the lowest-priority overflow.
 * Mutates `cards` statuses in-place and returns the list of newly archived card IDs.
 */
export function pruneActiveBacklog(
  cards: LanguagePushCard[],
  today: string,
  config: LanguagePushConfig,
  nowIso: string,
): string[] {
  const archivedIds: string[] = []
  const staleCutoff = shiftDateString(today, -LANGUAGE_PUSH_STALE_ARCHIVE_DAYS)

  // Pass 1: TTL decay for untouched single-day cards
  for (const card of cards) {
    if (card.status !== 'active') continue
    const untouched = !card.familiarity && card.exposures === 0
    if (untouched && card.seenDays <= 1 && card.lastSeenDate <= staleCutoff) {
      card.status = 'archived'
      card.updatedAt = nowIso
      archivedIds.push(card.id)
    }
  }

  // Pass 2: Enforce hard backlog cap (excluding today's active queue slots)
  const backlogCap = Math.max(
    15,
    Math.min(120, Math.floor(config.backlogCap || LANGUAGE_PUSH_DEFAULT_BACKLOG_CAP)),
  )
  const { todayCards, backlogCards } = buildDailyQueue(cards, today, config)
  if (backlogCards.length <= backlogCap) {
    return archivedIds
  }

  const todayIdSet = new Set(todayCards.map((c) => c.id))
  const candidates = cards
    .filter((c) => c.status === 'active' && !todayIdSet.has(c.id))
    .sort(compareRetentionPriority)

  const overflow = candidates.slice(backlogCap)
  for (const card of overflow) {
    card.status = 'archived'
    card.updatedAt = nowIso
    archivedIds.push(card.id)
  }

  return archivedIds
}

/**
 * Selects up to `limit` cards while fairly interleaving enabled languages so neither EN nor JA
 * starves the other, while still honoring `unfamiliar` reinforcement cards first.
 */
function selectBalancedByLang(
  candidates: LanguagePushCard[],
  limit: number,
  enabledLangs: readonly LanguagePushLang[],
): LanguagePushCard[] {
  if (limit <= 0 || candidates.length === 0) return []
  const priority = candidates.filter((c) => c.familiarity === 'unfamiliar')
  const regular = candidates.filter((c) => c.familiarity !== 'unfamiliar')

  const picked: LanguagePushCard[] = []
  for (const card of priority) {
    if (picked.length >= limit) return picked
    picked.push(card)
  }

  const remaining = limit - picked.length
  if (remaining <= 0) return picked

  const activeLangs = enabledLangs.length > 0 ? enabledLangs : (['en', 'ja'] as const)
  const buckets = new Map<LanguagePushLang, LanguagePushCard[]>()
  for (const lang of activeLangs) buckets.set(lang, [])
  for (const card of regular) {
    const bucket = buckets.get(card.lang)
    if (bucket) bucket.push(card)
  }

  let progressed = true
  while (picked.length < limit && progressed) {
    progressed = false
    for (const lang of activeLangs) {
      if (picked.length >= limit) break
      const bucket = buckets.get(lang)
      if (bucket && bucket.length > 0) {
        picked.push(bucket.shift()!)
        progressed = true
      }
    }
  }

  return picked
}

export function buildDailyQueue(
  cards: readonly LanguagePushCard[],
  today: string,
  config: LanguagePushConfig,
): {
  todayCards: LanguagePushCard[]
  backlogCards: LanguagePushCard[]
  masteredCards: LanguagePushCard[]
  archivedCards: LanguagePushCard[]
} {
  const enabledSet = new Set<LanguagePushLang>(
    config.enabledLangs.length > 0 ? config.enabledLangs : ['en', 'ja'],
  )

  const activeAll: LanguagePushCard[] = []
  const masteredCards: LanguagePushCard[] = []
  const archivedCards: LanguagePushCard[] = []

  for (const card of cards) {
    if (card.status === 'mastered') {
      masteredCards.push(card)
    } else if (card.status === 'archived') {
      archivedCards.push(card)
    } else if (enabledSet.has(card.lang)) {
      activeAll.push(card)
    }
  }

  const dueNow = activeAll
    .filter((c) => c.dueAt <= today)
    .sort((a, b) => compareCardPriority(a, b, today))

  const dueVocab = dueNow.filter((c) => c.kind === 'vocab')
  const dueGrammar = dueNow.filter((c) => c.kind === 'grammar')

  const dailyLimit = Math.max(1, Math.min(24, Math.floor(config.dailyLimit || 8)))
  const grammarCap = Math.min(dailyLimit, Math.max(0, Math.floor(config.dailyGrammarLimit ?? 2)))
  const vocabCap = Math.min(dailyLimit, Math.max(0, Math.floor(config.dailyVocabLimit ?? 6)))

  const pickedGrammar = selectBalancedByLang(dueGrammar, grammarCap, config.enabledLangs)
  const vocabSlots = Math.min(
    vocabCap + Math.max(0, grammarCap - pickedGrammar.length),
    dailyLimit - pickedGrammar.length,
  )
  const pickedVocab = selectBalancedByLang(dueVocab, vocabSlots, config.enabledLangs)

  const pickedIds = new Set<string>([...pickedVocab.map((c) => c.id), ...pickedGrammar.map((c) => c.id)])
  const todayCards = [...pickedVocab, ...pickedGrammar]
  if (todayCards.length < dailyLimit) {
    for (const card of dueNow) {
      if (todayCards.length >= dailyLimit) break
      if (!pickedIds.has(card.id)) {
        todayCards.push(card)
        pickedIds.add(card.id)
      }
    }
  }

  todayCards.sort((a, b) => compareCardPriority(a, b, today))

  const backlogCards = activeAll
    .filter((c) => !pickedIds.has(c.id))
    .sort((a, b) => {
      const aRank = familiarityPriorityRank(a)
      const bRank = familiarityPriorityRank(b)
      if (aRank !== bRank) return bRank - aRank
      if (a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt)
      if (a.seenDays !== b.seenDays) return b.seenDays - a.seenDays
      return b.updatedAt.localeCompare(a.updatedAt)
    })

  masteredCards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  archivedCards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return { todayCards, backlogCards, masteredCards, archivedCards }
}
