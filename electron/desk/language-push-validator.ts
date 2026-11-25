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
/**
 * Same foreign-script net as FOREIGN_SCRIPT_RE but tolerates θ (U+03B8), the
 * standard English IPA voiceless dental fricative. Used ONLY for English
 * `reading` fields; every other Greek letter (α β γ δ ω …) is still rejected.
 */
const FOREIGN_SCRIPT_NON_IPA_RE =
  /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Hangul}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Hebrew}]/u
const GREEK_NON_THETA_RE = /[\u0370-\u03B7\u03B9-\u03FF\u1F00-\u1FFF]/
/** Replacement chars, C0/C1 control chars — classic transport/encoding garble. */
const CORRUPT_CHAR_RE = /[�\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const HIRAGANA_RE = /[\u3040-\u309f]/
const KANA_RE = /[\u3040-\u30ff]/
const KANA_ONLY_RE = /^[\u3040-\u30ffー・\s、。〜~()]+$/
const CJK_RE = /[\u3400-\u9fff]/
const LATIN_RE = /[A-Za-z]/
const PINYIN_TONE_MARKS_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/
const CODE_ARTIFACT_RE = /(?:https?:\/\/|@[a-z]{2,}|[a-z0-9]_[a-z0-9]|\.(?:vue|tsx?|jsx?|json|py|md|css|html)\b)/i
/**
 * Strict English IPA whitelist: ASCII letters + the IPA vowels/consonants used
 * in English dictionaries + stress/length/tie/diacritic marks + `/` `;` `:` for
 * alternate pronunciations and colon length marks. Anything outside this set is garble.
 */
const IPA_ALLOWED_RE =
  /^[A-Za-zɑɒæɐəɚɝɛɜɪɨɔɵʊʌʉɡŋɲɳʃʒðθɾɹɻʔɫɬɮçʝβɸχʁħʕʧʤʦʣãẽĩõũˈˌːˑ:.;'’\-(),\s~…̩̯̃͡ʰʷʲ/]+$/
const IPA_PHONEME_RE = /[A-Za-zɑɒæɐəɚɝɛɜɪɨɔɵʊʌʉɡŋɲɳʃʒðθɾɹɻʔɫɬɮçʝβɸχʁħʕʧʤʦʣ]/
/** Distinctive non-ASCII IPA symbols used to distinguish bare un-slashed IPA from plain English/romaji words. */
const IPA_DISTINCTIVE_RE = /[ɑɒæɐəɚɝɛɜɪɨɔɵʊʌʉɡŋɲɳʃʒðθɾɹɻʔɫɬɮçʝβɸχʁħʕʧʤʦʣˈˌːˑ͡]/
const IPA_GARBAGE_PUNCT_RE = /[@#$%^&*+=<>|{}]|\?{2,}|(?:^|\W)N\/A(?:\W|$)/i
const JP_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff]/

/**
 * 148 high-frequency PRC Simplified Chinese characters mathematically verified NOT to exist
 * in JIS X 0208 (`euc_jp`), so zero legitimate Japanese Jōyō/Jinmeiyō Kanji are flagged.
 */
const PRC_SIMPLIFIED_ONLY_RE =
  /[动环现际开关说话记录为这们问题业产设计优逻辑错误络页软账标签闭扫链语汇习惯进阶项块测试复归显译读汉简态缓隐础时间报导编删创输应绑鉴滤类炼词释连暂继续转锚筛选顶预损增飞轮传评场领视发负值规门槛积肿馈论择顾边护栏约则让步义务协统备额订阅码钥过仓库图弹权稳滚观拥挤琐验黑雾识频该够经还虽样么东钮单夹查检]/

const CHINESE_LEAK_PHRASES_RE = /(?:人机互动|时间日记|直接动工|开发流程|隐私信息|形态缓和|回合想做|四个好|早报语料|单点专栏)/

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
    // Strip accidental English IPA slashes/brackets like `/ても、なければならない/`
    const stripped = raw.replace(/^\/+|\/+$/g, '').replace(/^\[+|\]+$/g, '').trim()
    if (!KANA_RE.test(stripped) || !KANA_ONLY_RE.test(stripped)) {
      return ''
    }
    return stripped
  }
  return normalizeEnglishIpaReading(raw)
}

/**
 * Strict English IPA normalization: trims, collapses whitespace, normalizes ASCII `:`
 * length marks to `ː`, rejects corrupt chars / pinyin / CJK / kana / non-θ foreign
 * scripts / bare plain words without IPA symbols / non-IPA symbols, then wraps bare
 * IPA cleanly in `/.../` without double-wrapping variant labels like `/.../ (US)`.
 */
function normalizeEnglishIpaReading(raw: string): string {
  if (raw.length > 120) return ''
  if (CORRUPT_CHAR_RE.test(raw)) return ''
  if (PINYIN_TONE_MARKS_RE.test(raw) || CJK_RE.test(raw) || KANA_RE.test(raw)) return ''
  if (FOREIGN_SCRIPT_NON_IPA_RE.test(raw) || GREEK_NON_THETA_RE.test(raw)) return ''

  const normalized = raw.replace(/\s+/g, ' ').trim()
  const hasSlashSegment = /\/[^/]+\//.test(normalized)
  const hasBracketSegment = /\[[^\]]+\]/.test(normalized)

  let wrapped: 'slash' | 'bracket' | 'multi' | null = null
  let inner = normalized
  if (normalized.length > 2 && normalized.startsWith('/') && normalized.endsWith('/') && !normalized.slice(1, -1).includes('/')) {
    wrapped = 'slash'
    inner = normalized.slice(1, -1)
  } else if (normalized.length > 2 && normalized.startsWith('[') && normalized.endsWith(']') && !normalized.slice(1, -1).includes('[')) {
    wrapped = 'bracket'
    inner = normalized.slice(1, -1)
  } else if (hasSlashSegment || hasBracketSegment) {
    wrapped = 'multi'
    inner = normalized
  }

  inner = inner.replace(/\s+/g, ' ').trim()
  if (!inner) return ''
  if (!IPA_PHONEME_RE.test(inner)) return ''
  if (!IPA_ALLOWED_RE.test(inner)) return ''
  if (IPA_GARBAGE_PUNCT_RE.test(inner)) return ''

  // Normalize ASCII colon `:` used as IPA length mark (e.g. `/di:ˈkʌplɪŋ/` -> `/diːˈkʌplɪŋ/`).
  inner = inner.replace(/(?<=[A-Za-zɑɒæɐəɚɝɛɜɪɨɔɵʊʌʉɡŋɲɳʃʒðθɾɹɻʔɫ]):/g, 'ː')

  // Bare unwrapped strings must contain at least one genuine IPA symbol so plain words
  // like "resilience" or romaji like "yappari" are not mistaken for IPA readings.
  if (wrapped === null && !IPA_DISTINCTIVE_RE.test(inner)) return ''

  if (wrapped === 'bracket') return `[${inner}]`
  if (wrapped === 'multi') {
    return inner.replace(/\/([^/;,\n]+?)\//g, (_m, body: string) => `/${body.trim()}/`)
  }
  return `/${inner}/`
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
  const matches = text.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)
  for (const match of matches) {
    const word = match[0]
    const start = match.index ?? 0
    const prevChar = start > 0 ? text[start - 1] : ''
    const nextChar = start + word.length < text.length ? text[start + word.length] : ''
    const gluedToJapanese = JP_CHAR_RE.test(prevChar) || JP_CHAR_RE.test(nextChar)
    // Token-collapse artifact: any lowercase letter glued to kana/kanji (aき, deき, k管理)
    if (gluedToJapanese && /[a-z]/.test(word)) return word
    const lower = word.toLowerCase()
    if (ALLOWED_TECH_WORDS_IN_JA.has(lower)) continue
    // Allow standalone uppercase grades/levels bounded by non-letters (N2, B2, A, X)
    if (/^[A-Z][0-9]?$/.test(word)) continue
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

  for (const field of [surface, sentence]) {
    if (CORRUPT_CHAR_RE.test(field)) {
      return { ok: false, reason: 'corrupt_char' }
    }
    if (FOREIGN_SCRIPT_RE.test(field)) {
      return { ok: false, reason: 'foreign_script_corruption' }
    }
    if (CODE_ARTIFACT_RE.test(field)) {
      return { ok: false, reason: 'code_artifact_corruption' }
    }
  }
  if (CORRUPT_CHAR_RE.test(meaning)) {
    return { ok: false, reason: 'corrupt_char' }
  }
  if (CODE_ARTIFACT_RE.test(meaning)) {
    return { ok: false, reason: 'code_artifact_corruption' }
  }

  const rawReading = input.reading || ''
  if (CORRUPT_CHAR_RE.test(rawReading)) {
    return { ok: false, reason: 'corrupt_char' }
  }
  if (CODE_ARTIFACT_RE.test(rawReading)) {
    return { ok: false, reason: 'code_artifact_corruption' }
  }
  if (input.lang === 'ja') {
    if (FOREIGN_SCRIPT_RE.test(rawReading)) {
      return { ok: false, reason: 'foreign_script_corruption' }
    }
  } else if (FOREIGN_SCRIPT_NON_IPA_RE.test(rawReading) || GREEK_NON_THETA_RE.test(rawReading)) {
    // θ (U+03B8) is legitimate English IPA; every other foreign script is not.
    return { ok: false, reason: 'foreign_script_corruption' }
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
  if ((input.reading || '').trim() && !normalizedReading) {
    return { ok: false, reason: 'en_invalid_ipa_reading' }
  }

  return { ok: true, normalizedReading }
}

export function isCleanJapaneseText(text: string): boolean {
  const normalized = (text || '').normalize('NFKC').trim()
  if (!normalized) return false
  if (CORRUPT_CHAR_RE.test(normalized)) return false
  if (FOREIGN_SCRIPT_RE.test(normalized)) return false
  if (CODE_ARTIFACT_RE.test(normalized)) return false
  if (PRC_SIMPLIFIED_ONLY_RE.test(normalized)) return false
  if (CHINESE_LEAK_PHRASES_RE.test(normalized)) return false
  if (!HIRAGANA_RE.test(normalized)) return false
  if (findUnexpectedLatinInJapanese(normalized)) return false
  return true
}
