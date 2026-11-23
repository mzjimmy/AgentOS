/**
 * Pure deterministic scheduler, canonical deduplication, threshold filtering,
 * and TTS text preparation for SentinelDesk Language Push.
 *
 * Ported from SentinelLab `vocabulary-review.ts` & `tts.ts` without any DB dependency.
 */

import {
  LANGUAGE_PUSH_REVIEW_INTERVAL_DAYS,
  type LanguagePushCard,
  type LanguagePushCardKind,
  type LanguagePushConfig,
  type LanguagePushLang,
} from '../../src/language-push-contract'
import { shiftDateString } from './intent-todo-time'

/**
 * Curated basic English words below the default 1500-word threshold.
 * Prevents trivial slips from cloud extraction from wasting daily card budget.
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
  'time', 'day', 'year', 'week', 'month', 'hour', 'minute', 'way', 'man', 'woman', 'child', 'people', 'person', 'life',
  'world', 'hand', 'part', 'place', 'case', 'point', 'thing', 'fact', 'home', 'house', 'room', 'water', 'food', 'money',
  'book', 'car', 'phone', 'friend', 'family', 'school', 'job', 'name', 'number', 'night', 'morning', 'evening', 'hello', 'thanks',
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
  'はい', 'いいえ', 'ありがとう', 'おはよう', 'こんにちは', 'こんばんは', 'です', 'ます',
])

export function normalizeCanonicalKey(surface: string, lang: LanguagePushLang): string {
  const nfkc = (surface || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!nfkc) return ''
  return lang === 'en' ? nfkc.toLowerCase() : nfkc
}

export function normalizeReadingKey(reading: string | null | undefined): string {
  return (reading || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Pure SRS interval calculation ported from SentinelLab `vocabulary-review.ts`.
 * `exposuresBefore` is how many times the card was already reviewed before today's defer.
 */
export function scheduleNextReview(exposuresBefore: number, today: string): string {
  const index = Math.min(
    Math.max(0, Math.floor(Number.isFinite(exposuresBefore) ? exposuresBefore : 0)),
    LANGUAGE_PUSH_REVIEW_INTERVAL_DAYS.length - 1,
  )
  const days = LANGUAGE_PUSH_REVIEW_INTERVAL_DAYS[index]
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

function compareCardPriority(a: LanguagePushCard, b: LanguagePushCard, today: string): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const aOverdue = a.dueAt < today ? 1 : 0
  const bOverdue = b.dueAt < today ? 1 : 0
  if (aOverdue !== bOverdue) return bOverdue - aOverdue
  const aReviewed = a.exposures > 0 ? 1 : 0
  const bReviewed = b.exposures > 0 ? 1 : 0
  if (aReviewed !== bReviewed) return bReviewed - aReviewed
  if (a.seenDays !== b.seenDays) return b.seenDays - a.seenDays
  if (a.lastSeenDate !== b.lastSeenDate) return b.lastSeenDate.localeCompare(a.lastSeenDate)
  return b.updatedAt.localeCompare(a.updatedAt)
}

/**
 * Selects up to `limit` cards while fairly interleaving enabled languages so neither EN nor JA
 * starves the other, while still honoring pinned cards first.
 */
function selectBalancedByLang(
  candidates: LanguagePushCard[],
  limit: number,
  enabledLangs: readonly LanguagePushLang[],
): LanguagePushCard[] {
  if (limit <= 0 || candidates.length === 0) return []
  const pinned = candidates.filter((c) => c.pinned)
  const regular = candidates.filter((c) => !c.pinned)

  const picked: LanguagePushCard[] = []
  for (const card of pinned) {
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
): { todayCards: LanguagePushCard[]; backlogCards: LanguagePushCard[]; masteredCards: LanguagePushCard[] } {
  const enabledSet = new Set<LanguagePushLang>(
    config.enabledLangs.length > 0 ? config.enabledLangs : ['en', 'ja'],
  )

  const activeAll: LanguagePushCard[] = []
  const masteredCards: LanguagePushCard[] = []

  for (const card of cards) {
    if (card.status === 'mastered') {
      masteredCards.push(card)
    } else if (enabledSet.has(card.lang)) {
      activeAll.push(card)
    }
  }

  const dueNow = activeAll
    .filter((c) => c.dueAt <= today)
    .sort((a, b) => compareCardPriority(a, b, today))

  const dueVocab = dueNow.filter((c) => c.kind === 'vocab')
  const dueGrammar = dueNow.filter((c) => c.kind === 'grammar')

  const dailyLimit = Math.max(1, Math.min(20, Math.floor(config.dailyLimit || 8)))
  const grammarCap = Math.min(dailyLimit, Math.max(0, Math.floor(config.dailyGrammarLimit ?? 2)))
  const vocabCap = Math.min(dailyLimit, Math.max(0, Math.floor(config.dailyVocabLimit ?? 6)))

  const pickedGrammar = selectBalancedByLang(dueGrammar, grammarCap, config.enabledLangs)
  const vocabSlots = Math.min(vocabCap + Math.max(0, grammarCap - pickedGrammar.length), dailyLimit - pickedGrammar.length)
  const pickedVocab = selectBalancedByLang(dueVocab, vocabSlots, config.enabledLangs)

  const pickedIds = new Set<string>([...pickedVocab.map((c) => c.id), ...pickedGrammar.map((c) => c.id)])
  // If vocab was sparse, backfill remaining daily slots from remaining due grammar
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
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt)
      return b.updatedAt.localeCompare(a.updatedAt)
    })

  masteredCards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return { todayCards, backlogCards, masteredCards }
}
