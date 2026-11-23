/**
 * Deterministic script & quality validator for SentinelDesk Language Push.
 *
 * Ported and strengthened from SentinelLab `vocabulary-ingestion.ts` & `tts.ts`:
 * - Rejects foreign-script token collapse (Arabic, Cyrillic, Hangul, Thai, etc.)
 * - Rejects PRC-Simplified-only Hanzi leaks inside Japanese output (verified against JIS X 0208)
 * - Rejects stray code/romanized artifacts inside Japanese sentences (e.g. `_Manager.vue`, `@unlink`, `kis管理`, `deき`)
 * - Enforces pure kana readings for Japanese (no slashes, no kanji, no Latin) and IPA without pinyin for English
 */

import type {
  LanguagePushCardKind,
  LanguagePushLang,
  LanguagePushPronunciationHint,
} from '../../src/language-push-contract'

const FOREIGN_SCRIPT_RE =
  /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Hangul}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Hebrew}\p{Script=Greek}]/u
const HIRAGANA_RE = /[\u3040-\u309f]/
const KANA_RE = /[\u3040-\u30ff]/
const KANA_ONLY_RE = /^[\u3040-\u30ffー・\s、。〜~]+$/
const CJK_RE = /[\u3400-\u9fff]/
const LATIN_RE = /[A-Za-z]/
const PINYIN_TONE_MARKS_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/
const CODE_ARTIFACT_RE = /(?:https?:\/\/|@[a-z]{2,}|[a-z0-9]_[a-z0-9]|\.(?:vue|tsx?|jsx?|json|py|md|css|html)\b)/i

/**
 * 148 high-frequency PRC Simplified Chinese characters mathematically verified NOT to exist
 * in JIS X 0208 (`euc_jp`), so zero legitimate Japanese Jōyō/Jinmeiyō Kanji are flagged.
 */
const PRC_SIMPLIFIED_ONLY_RE =
  /[动环现际开关说话记录为这们问题业产设计优逻辑错误络页软账标签闭扫链语汇习惯进阶项块测试复归显译读汉简态缓隐础时间报导编删创输应绑鉴滤类炼词释连暂继续转锚筛选顶预损增飞轮传评场领视发负值规门槛积肿馈论择顾边护栏约则让步义务协统备额订阅码钥过仓库图弹权稳滚观拥挤琐验黑雾识频该够经还虽样么东钮单夹查检]/

const CHINESE_LEAK_PHRASES_RE = /(?:人机互动|时间日记|直接动工|开发流程|隐私信息|形态缓和|回合想做|四个好)/

const ALLOWED_TECH_WORDS_IN_JA = new Set([
  'ai', 'api', 'ui', 'ux', 'git', 'github', 'tdd', 'pr', 'app', 'mac', 'macos', 'ios', 'os',
  'web', 'url', 'tts', 'llm', 'bot', 'mvp', 'todo', 'skill', 'skills', 'agent', 'agentos',
  'codex', 'claude', 'deepseek', 'notion', 'second', 'minimax', 'folk', 'feishu', 'slack',
  'ipad', 'iphone', 'pixel', 'esim', 'vps', 'clash', 'ok', 'pc', 'pdf', 'csv', 'json', 'sql',
  'css', 'html', 'sdk', 'ipc', 'cli', 'ide', 'mcp', 'ssh', 'http', 'https', 'pro', 'it', 'sns',
  'rss', 'pdf', 'ocr', 'gpu', 'cpu', 'ram', 'ssd', 'usb', 'wi-fi', 'wifi', 'vpn', 'dns', 'ip',
  'ucloud', '1password', 'sentineldesk', 'sentinellab', 'read-only', 'quick', 'win',
])

export function normalizeCardReading(reading: string | null | undefined, lang: LanguagePushLang): string {
  const raw = (reading || '').normalize('NFKC').trim()
  if (!raw) return ''
  if (lang === 'ja') {
    // Strip accidental English IPA slashes like `/ても、なければならない/`
    const stripped = raw.replace(/^\/+|\/+$/g, '').trim()
    if (!KANA_RE.test(stripped) || CJK_RE.test(stripped) || LATIN_RE.test(stripped) || FOREIGN_SCRIPT_RE.test(stripped)) {
      return ''
    }
    return stripped
  }
  if (PINYIN_TONE_MARKS_RE.test(raw) || CJK_RE.test(raw) || KANA_RE.test(raw) || FOREIGN_SCRIPT_RE.test(raw)) {
    return ''
  }
  return raw
}

export function sanitizePronunciationHints(
  raw: unknown,
): LanguagePushPronunciationHint[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: LanguagePushPronunciationHint[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const surface = typeof rec.surface === 'string' ? rec.surface.normalize('NFKC').trim() : ''
    const reading = typeof rec.reading === 'string'
      ? rec.reading.normalize('NFKC').replace(/^\/+|\/+$/g, '').replace(/\s+/g, '').trim()
      : ''
    if (!surface || !reading) continue
    if (surface === reading) continue
    if (!CJK_RE.test(surface)) continue
    if (!KANA_ONLY_RE.test(reading) || CJK_RE.test(reading) || LATIN_RE.test(reading)) continue
    if (PRC_SIMPLIFIED_ONLY_RE.test(surface)) continue
    const key = `${surface}=>${reading}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ surface, reading })
  }
  return result
}

function findUnexpectedLatinInJapanese(text: string): string | null {
  const matches = text.match(/[A-Za-z][A-Za-z0-9-]*/g)
  if (!matches) return null
  for (const word of matches) {
    const lower = word.toLowerCase()
    if (ALLOWED_TECH_WORDS_IN_JA.has(lower)) continue
    // Allow single-letter grades/variables like N2, B2, A, X
    if (/^[A-Za-z][0-9]?$/.test(word)) continue
    return word
  }
  return null
}

export type CardValidationResult =
  | { ok: true; normalizedReading: string }
  | { ok: false; reason: string }

export function validateLanguageCard(input: {
  lang: LanguagePushLang
  kind: LanguagePushCardKind
  surface: string
  reading?: string | null
  meaning: string
  exampleSentence: string
}): CardValidationResult {
  const surface = (input.surface || '').normalize('NFKC').trim()
  const meaning = (input.meaning || '').normalize('NFKC').trim()
  const sentence = (input.exampleSentence || '').normalize('NFKC').trim()

  if (!surface || !meaning || !sentence) {
    return { ok: false, reason: 'empty_required_field' }
  }

  for (const field of [surface, sentence, input.reading || '']) {
    if (FOREIGN_SCRIPT_RE.test(field)) {
      return { ok: false, reason: 'foreign_script_corruption' }
    }
    if (CODE_ARTIFACT_RE.test(field)) {
      return { ok: false, reason: 'code_artifact_corruption' }
    }
  }

  const normalizedReading = normalizeCardReading(input.reading, input.lang)

  if (input.lang === 'ja') {
    if (PRC_SIMPLIFIED_ONLY_RE.test(surface) || PRC_SIMPLIFIED_ONLY_RE.test(sentence)) {
      return { ok: false, reason: 'simplified_chinese_leak_in_ja' }
    }
    if (CHINESE_LEAK_PHRASES_RE.test(surface) || CHINESE_LEAK_PHRASES_RE.test(sentence)) {
      return { ok: false, reason: 'chinese_phrase_leak_in_ja' }
    }
    if (!HIRAGANA_RE.test(sentence)) {
      return { ok: false, reason: 'ja_example_missing_hiragana' }
    }
    if (!normalizedReading) {
      return { ok: false, reason: 'ja_missing_valid_kana_reading' }
    }
    const strayLatin = findUnexpectedLatinInJapanese(sentence) ?? findUnexpectedLatinInJapanese(surface)
    if (strayLatin) {
      return { ok: false, reason: `ja_unexpected_latin:${strayLatin}` }
    }
    return { ok: true, normalizedReading }
  }

  // English validation
  if (!LATIN_RE.test(surface) || CJK_RE.test(surface) || KANA_RE.test(surface)) {
    return { ok: false, reason: 'en_invalid_surface_script' }
  }
  if (!LATIN_RE.test(sentence) || CJK_RE.test(sentence) || KANA_RE.test(sentence)) {
    return { ok: false, reason: 'en_invalid_example_script' }
  }

  return { ok: true, normalizedReading }
}

export function isCleanJapaneseText(text: string): boolean {
  const normalized = (text || '').normalize('NFKC').trim()
  if (!normalized) return false
  if (FOREIGN_SCRIPT_RE.test(normalized)) return false
  if (CODE_ARTIFACT_RE.test(normalized)) return false
  if (PRC_SIMPLIFIED_ONLY_RE.test(normalized)) return false
  if (CHINESE_LEAK_PHRASES_RE.test(normalized)) return false
  if (!HIRAGANA_RE.test(normalized)) return false
  if (findUnexpectedLatinInJapanese(normalized)) return false
  return true
}
