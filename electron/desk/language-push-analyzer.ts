/**
 * Privacy-guarded cloud translator & threshold-aware vocab/grammar extractor
 * for SentinelDesk Language Push.
 *
 * Precision architecture:
 * 1. Hard privacy filter (`isPrivateJournalEntry` + `scrubSecrets`) BEFORE prompt assembly.
 * 2. One focused, dedicated LLM call PER target language (never mixing EN & JA in one stream,
 *    preventing cross-language token drift and Simplified Chinese leakage into Japanese).
 * 3. 7-day translated corpus high-frequency mining: extracts threshold-passing high-frequency
 *    terms from archived non-private translations and feeds them as priority candidates.
 * 4. Familiarity-guided adaptive expansion: injects the user's recent 3-tier familiarity
 *    ratings (陌生 / 模糊 / 熟悉) so the model prioritizes weak zones, expands 1-2 related
 *    collocations/synonyms, and skips already-familiar difficulty bands.
 * 5. Deterministic script & quality validator (`validateLanguageCard`) + 1-pass repair retry.
 * 6. Mandatory `exampleReadings` kanji→kana annotations for Japanese MiniMax TTS accuracy.
 */

import type { ClaudeAgentResolvedConfig } from '../../src/claude-chat-types'
import type { JournalEntry } from '../../src/journal-contract'
import {
  LANGUAGE_PUSH_DEFAULT_SOURCE_KIND,
  LANGUAGE_PUSH_SUPPORTED_LANGS,
  type LanguagePushCardKind,
  type LanguagePushConfig,
  type LanguagePushCorpusItem,
  type LanguagePushCorpusSourceKind,
  type LanguagePushLang,
} from '../../src/language-push-contract'
import {
  callAnthropicMessages,
  type AnthropicCallOptions,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult,
} from '../anthropic-messages-client'
import { isPrivateJournalEntry, scrubSecrets } from './journal-privacy'
import { extractCorpusHighFreqTerms, type CorpusHighFreqTerm } from './language-push-scheduler'
import type { LanguagePushCandidateInput } from './language-push-store'
import {
  isCleanJapaneseText,
  sanitizePronunciationHints,
  validateLanguageCard,
} from './language-push-validator'

const MAX_ENTRIES_PER_RUN = 8
const MAX_TOTAL_INPUT_CHARS = 3_200
const MIN_ENTRY_BODY_CHARS = 10

/** A journal-shaped corpus entry tagged with the provider source it came from. */
export type LanguagePushSourceEntry = JournalEntry & { sourceKind?: LanguagePushCorpusSourceKind }

type EligibleEntry = {
  id: string
  date: string
  time: string
  safeBody: string
  sourceKind: LanguagePushCorpusSourceKind
}

export type LanguagePushFamiliaritySummary = {
  unfamiliar: Array<{ surface: string; kind: LanguagePushCardKind; meaning: string }>
  fuzzy: Array<{ surface: string; kind: LanguagePushCardKind; meaning: string }>
  familiar: string[]
  excludedWordKeys: Set<string>
}

export type LanguagePushLlmCaller = (
  config: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>,
  request: AnthropicMessagesRequest,
  options?: AnthropicCallOptions,
) => Promise<AnthropicMessagesResult>

export type LanguagePushAnalysisInput = {
  logicalDate: string
  entries: LanguagePushSourceEntry[]
  sourceKind?: LanguagePushCorpusSourceKind
  processedEntryIds: Record<string, string>
  recentCorpusItems?: LanguagePushCorpusItem[]
  familiarityByLang?: Partial<Record<LanguagePushLang, LanguagePushFamiliaritySummary>>
  allowCorpusOnlyMine?: boolean
  force?: boolean
  config: LanguagePushConfig
  resolvedModel: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  llmCaller?: LanguagePushLlmCaller
}

export type LanguagePushAnalysisOutput =
  | {
      ok: true
      processedEntryIds: string[]
      corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>>
      candidates: LanguagePushCandidateInput[]
      partialWarnings?: string[]
      statsBase: {
        scannedEntries: number
        eligibleEntries: number
        skippedPrivate: number
        skippedAlreadyProcessed: number
        durationMs: number
        inputTokens?: number
        outputTokens?: number
      }
      modelUsed: string
    }
  | {
      ok: false
      kind: 'needs_config' | 'parse_error' | 'provider_error'
      message: string
    }

function stripThinkingBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function tryParseJsonCandidate(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = text.slice(start, end + 1)
  for (const variant of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed = JSON.parse(variant) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* try next variant */
    }
  }
  return null
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = stripThinkingBlocks(raw)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)
  if (fenced) {
    const parsedFenced = tryParseJsonCandidate(fenced[1].trim())
    if (parsedFenced) return parsedFenced
  }
  const unclosedFence = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  return tryParseJsonCandidate(unclosedFence) ?? tryParseJsonCandidate(cleaned)
}

function buildSystemPromptForLang(lang: LanguagePushLang, config: LanguagePushConfig): string {
  if (lang === 'ja') {
    return [
      'あなたは熟練した日本語教師・翻訳家です。中国語話者の日記・毎朝のニュース早報（モーニングブリーフ）および直近の翻訳コーパスから、高品質な日本語学習カードを作成してください。',
      '以下の厳格なルールを必ず守ってください：',
      `1. 対象レベル：JLPT ${config.jaLevel} 以上。初級の基礎語（これ・する・良い・今日など）や「既知（熟悉）」リストの語彙および同等の易しい語は絶対に選ばないでください。`,
      '2. 【高頻度語優先 ＋ 熟知度に基づく同類展開】',
      '   - 直近コーパスの高頻度候補語が与えられている場合、レベル基準を満たす高頻度語を最優先でカード化してください。',
      '   - ユーザーの「陌生（不慣れ）」「模糊（曖昧）」履歴が与えられている場合、その苦手領域や文脈に近い実践表現・類義語・コロケーションを 1〜2 件展開して含めてください（展開カードには `"isExpansion": true` を付与）。',
      '3. 【文字の純度（最優先・違反厳禁）】',
      '   - すべての日本語テキスト（corpus と exampleSentence）は、100%自然な現代日本語（日本の常用漢字・新字体、ひらがな、カタカナ）のみで書くこと。',
      '   - 中国語の簡体字や中国語表現の直コピーを厳禁する（例：×「人机互动」「环境」「开发流程」「页面」「时间日记」 → ○「人とAIの協働」「環境」「開発フロー」「画面」「タイムライン日記」）。',
      '   - アラビア文字、キリル文字、ハングル、スペイン語、文字化け、意味不明な英字断片（例：_Manager.vue, @unlink, kis, deき 等）を絶対に含めないこと。',
      '4. 【読み仮名（reading）と発音注記（exampleReadings）の厳格ルール】',
      '   - すべてのカードの `reading` は必ず正確なひらがな・カタカナのみで書くこと。スラッシュ（/…/）や漢字やローマ字を絶対に入れないこと。',
      '   - すべてのカードに `exampleReadings` 配列を必須で含め、`exampleSentence` 内に登場する**すべての漢字語・熟語**の正確なひらがな読みを列挙すること（例：[{"surface":"生成","reading":"せいせい"},{"surface":"環境","reading":"かんきょう"}]）。',
      '5. 抽出目安：高品質な語彙（kind: "vocab"）3〜4件 ＋ 実用的な文法表現（kind: "grammar"）1〜2件。例文は日記の文脈に忠実で自然な1文にすること。',
      '6. JSONオブジェクト1つのみを出力すること（前後に説明文を書かないこと）：',
      '{',
      '  "corpus": [',
      '    { "entryId": "je_...", "translatedText": "自然な日本語訳" }',
      '  ],',
      '  "cards": [',
      '    {',
      '      "kind": "vocab" | "grammar",',
      '      "surface": "辞書形または文法表現",',
      '      "reading": "正確なひらがな・カタカナのみ（スラッシュ禁止）",',
      '      "meaning": "简洁中文释义（≤24字）",',
      '      "grammarNote": "简明用法/接续提示（中文；词汇可为 null，语法必填）",',
      '      "levelTag": "N3" | "N2" | "N1",',
      '      "isExpansion": false,',
      '      "exampleSentence": "自然な日本語例文（簡体字・文字化け厳禁）",',
      '      "exampleTranslation": "对应中文译文",',
      '      "exampleReadings": [',
      '        { "surface": "例文中の漢字熟語", "reading": "正確なひらがな読み" }',
      '      ],',
      '      "sourceEntryId": "je_..."',
      '    }',
      '  ]',
      '}',
    ].join('\n')
  }

  return [
    'You are an expert English language coach building a high-precision study deck from a Chinese speaker\'s personal journal, daily morning news briefings, and recent translated corpus.',
    'Follow these strict rules:',
    `1. Target difficulty: above top-${config.enLevel} frequency words (CEFR B2+ / idiomatic engineering & life expressions) and crisp grammar/collocation patterns. NEVER output trivial basic words or words in the user's "Already familiar" list.`,
    '2. [High-Frequency Corpus Priority + Familiarity-Guided Expansion]',
    '   - When recent corpus high-frequency candidates are provided, prioritize threshold-passing high-frequency terms from that list.',
    '   - When user "Unfamiliar" or "Fuzzy" history is provided, include 1-2 closely related high-value collocations, synonyms, or domain expressions grounded in the user\'s journal context (mark expanded cards with `"isExpansion": true`).',
    '3. NEVER include Chinese characters, pinyin, or non-Latin garbled tokens in English text.',
    '4. `reading` MUST be accurate IPA wrapped in slashes (e.g. "/rɪˈzɪliəns/"), NEVER Chinese pinyin.',
    '5. Target output: 3-4 strong vocabulary cards (`kind: "vocab"`) + 1-2 practical grammar patterns (`kind: "grammar"`). Every example sentence must be natural, idiomatic English grounded directly in the user\'s journal context.',
    '6. Output ONLY a single valid JSON object (no prose outside JSON):',
    '{',
    '  "corpus": [',
    '    { "entryId": "je_...", "translatedText": "Natural idiomatic English translation" }',
    '  ],',
    '  "cards": [',
    '    {',
    '      "kind": "vocab" | "grammar",',
    '      "surface": "canonical English lemma, collocation, or grammar pattern",',
    '      "reading": "/IPA/",',
    '      "meaning": "简洁中文释义（≤24字）",',
    '      "grammarNote": "简明用法/搭配提示（中文；词汇可为 null，语法必填）",',
    '      "levelTag": "B2" | "C1",',
    '      "isExpansion": false,',
    '      "exampleSentence": "Natural idiomatic English sentence grounded in the user\'s journal",',
    '      "exampleTranslation": "对应中文译文",',
    '      "sourceEntryId": "je_..."',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

function buildUserPromptForLang(params: {
  logicalDate: string
  lang: LanguagePushLang
  corpusWindowDays: number
  entries: EligibleEntry[]
  highFreqTerms: CorpusHighFreqTerm[]
  familiarity?: LanguagePushFamiliaritySummary
}): string {
  const { logicalDate, lang, corpusWindowDays, entries, highFreqTerms, familiarity } = params
  const lines = [
    `Logical date: ${logicalDate}`,
    `Target language: ${lang === 'ja' ? 'Japanese (ja)' : 'English (en)'}`,
    `Corpus lookback window: recent ${corpusWindowDays} days`,
    '',
  ]

  if (entries.length > 0) {
    lines.push('New entries to translate & extract (journal + daily news briefings; non-private, scrubbed):')
    for (const item of entries) {
      lines.push(
        `--- [${item.id}] (${item.date} ${item.time} · ${item.sourceKind === 'morning_brief' ? 'Morning Brief' : 'Journal'}) ---`,
      )
      lines.push(item.safeBody)
    }
    lines.push('')
  } else {
    lines.push('No brand-new journal entries today; return `"corpus": []` and mine cards directly from the recent high-frequency corpus candidates below.')
    lines.push('')
  }

  if (highFreqTerms.length > 0) {
    lines.push(`Recent ${corpusWindowDays}-day translated corpus high-frequency threshold candidates (prioritize these):`)
    for (const t of highFreqTerms) {
      lines.push(
        `- ${t.term} (days=${t.docDays}, count=${t.totalCount}, entry=${t.sampleEntryId || 'corpus'} @ ${t.sampleDate}): "${t.sampleSentence}"`,
      )
    }
    lines.push('')
  }

  if (familiarity) {
    const hasProfile =
      familiarity.unfamiliar.length > 0 || familiarity.fuzzy.length > 0 || familiarity.familiar.length > 0
    if (hasProfile) {
      lines.push('User familiarity history (use this to calibrate difficulty & expand 1-2 related expressions):')
      if (familiarity.unfamiliar.length > 0) {
        lines.push(
          `- Unfamiliar (陌生 — needs reinforcement & related expansions): ${familiarity.unfamiliar
            .map((x) => `${x.surface} (${x.kind}: ${x.meaning})`)
            .join(', ')}`,
        )
      }
      if (familiarity.fuzzy.length > 0) {
        lines.push(
          `- Fuzzy (模糊 — learning edge i+1): ${familiarity.fuzzy
            .map((x) => `${x.surface} (${x.kind}: ${x.meaning})`)
            .join(', ')}`,
        )
      }
      if (familiarity.familiar.length > 0) {
        lines.push(`- Already familiar (熟悉 — DO NOT pick these or simpler words): ${familiarity.familiar.join(', ')}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n').trim()
}

type SingleLangParseSummary = {
  corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>>
  validCandidates: LanguagePushCandidateInput[]
  rejectedReasons: string[]
  rawCardCount: number
}

function parseAndValidateSingleLangPayload(
  parsed: Record<string, unknown>,
  lang: LanguagePushLang,
  logicalDate: string,
  sourceKind: LanguagePushCorpusSourceKind,
  eligible: EligibleEntry[],
  highFreqTerms: CorpusHighFreqTerm[],
  sourceKindById: ReadonlyMap<string, LanguagePushCorpusSourceKind>,
): SingleLangParseSummary {
  const entryDateById = new Map(eligible.map((e) => [e.id, e.date]))
  for (const hf of highFreqTerms) {
    if (hf.sampleEntryId && !entryDateById.has(hf.sampleEntryId)) {
      entryDateById.set(hf.sampleEntryId, hf.sampleDate)
    }
  }
  const fallbackEntry = eligible[0] ?? {
    id: highFreqTerms[0]?.sampleEntryId || '',
    date: highFreqTerms[0]?.sampleDate || logicalDate,
  }
  const sourceKindFor = (entryId: string): LanguagePushCorpusSourceKind =>
    sourceKindById.get(entryId) ?? sourceKind
  const freqByWordKey = new Map(highFreqTerms.map((t) => [t.wordKey, t.totalCount]))

  const corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>> = []
  if (Array.isArray(parsed.corpus)) {
    for (const raw of parsed.corpus) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const entryId = typeof r.entryId === 'string' ? r.entryId.trim() : ''
      const translatedText = typeof r.translatedText === 'string' ? r.translatedText.trim() : ''
      if (!entryId || !entryDateById.has(entryId) || !translatedText) continue
      if (lang === 'ja' && !isCleanJapaneseText(translatedText)) continue
      corpusItems.push({
        entryId,
        sourceDate: entryDateById.get(entryId) || logicalDate,
        sourceKind: sourceKindFor(entryId),
        lang,
        translatedText,
      })
    }
  }

  const validCandidates: LanguagePushCandidateInput[] = []
  const rejectedReasons: string[] = []
  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : []

  for (const raw of rawCards) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const kind: LanguagePushCardKind = r.kind === 'grammar' ? 'grammar' : 'vocab'
    const surface = typeof r.surface === 'string' ? r.surface.trim() : ''
    const meaning = typeof r.meaning === 'string' ? r.meaning.trim() : ''
    const exampleSentence = typeof r.exampleSentence === 'string' ? r.exampleSentence.trim() : ''
    const rawReading = typeof r.reading === 'string' ? r.reading.trim() : ''

    const check = validateLanguageCard({
      lang,
      kind,
      surface,
      reading: rawReading,
      meaning,
      exampleSentence,
    })

    if (!check.ok) {
      rejectedReasons.push(`${surface || '(empty)'} -> ${check.reason}`)
      continue
    }

    const rawEntryId = typeof r.sourceEntryId === 'string' ? r.sourceEntryId.trim() : ''
    const sourceEntryId = entryDateById.has(rawEntryId) ? rawEntryId : fallbackEntry.id
    const sourceDate = entryDateById.get(sourceEntryId) || fallbackEntry.date
    const examplePronunciations =
      lang === 'ja' ? sanitizePronunciationHints(r.exampleReadings ?? r.pronunciations) : undefined
    const normKey = lang === 'en' ? surface.toLowerCase() : surface
    const matchedFreq = freqByWordKey.get(normKey)

    validCandidates.push({
      lang,
      kind,
      surface,
      reading: check.normalizedReading,
      meaning,
      grammarNote: typeof r.grammarNote === 'string' && r.grammarNote.trim() ? r.grammarNote.trim() : null,
      levelTag: typeof r.levelTag === 'string' && r.levelTag.trim() ? r.levelTag.trim() : null,
      exampleSentence,
      exampleTranslation: typeof r.exampleTranslation === 'string' ? r.exampleTranslation.trim() : '',
      examplePronunciations,
      sourceDate,
      sourceEntryId,
      sourceKind: sourceKindFor(sourceEntryId),
      corpusFreq: matchedFreq,
      isExpansion: r.isExpansion === true,
    })
  }

  return {
    corpusItems,
    validCandidates,
    rejectedReasons,
    rawCardCount: rawCards.length,
  }
}

async function runSingleLanguageExtraction(params: {
  lang: LanguagePushLang
  logicalDate: string
  sourceKind: LanguagePushCorpusSourceKind
  eligible: EligibleEntry[]
  highFreqTerms: CorpusHighFreqTerm[]
  sourceKindById: ReadonlyMap<string, LanguagePushCorpusSourceKind>
  familiarity?: LanguagePushFamiliaritySummary
  config: LanguagePushConfig
  resolvedModel: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  callLlm: LanguagePushLlmCaller
}): Promise<
  | {
      ok: true
      corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>>
      candidates: LanguagePushCandidateInput[]
      sentEntryIds: string[]
      inputTokens: number
      outputTokens: number
      modelUsed: string
    }
  | {
      ok: false
      kind: 'needs_config' | 'parse_error' | 'provider_error'
      message: string
    }
> {
  const { lang, logicalDate, sourceKind, eligible, highFreqTerms, sourceKindById, familiarity, config, resolvedModel, callLlm } = params
  const systemPrompt = buildSystemPromptForLang(lang, config)

  // Keep high output budget for reasoning models; MiniMax-M3.1-Flash must use `effort: 'low'`
  // on both EN and JA or its unbounded thinking loop hits the 90s HTTP timeout.
  const isMiniMaxFlash = resolvedModel.model?.trim().toLowerCase() === 'minimax-m3.1-flash'
  const effectiveEligible = isMiniMaxFlash && lang === 'ja' ? eligible.slice(0, 4) : eligible
  const effectiveUserPrompt = buildUserPromptForLang({
    logicalDate,
    lang,
    corpusWindowDays: config.corpusWindowDays,
    entries: effectiveEligible,
    highFreqTerms,
    familiarity,
  })
  const requestOptions = {
    maxTokens: 16_384,
    temperature: 0.1,
    effort: isMiniMaxFlash ? ('low' as const) : undefined,
  }

  const firstRes = await callLlm(resolvedModel, {
    system: systemPrompt,
    messages: [{ role: 'user', content: effectiveUserPrompt }],
    ...requestOptions,
  })

  if (!firstRes.ok) {
    return {
      ok: false,
      kind: firstRes.kind === 'needs_config' ? 'needs_config' : 'provider_error',
      message: firstRes.message,
    }
  }

  let inputTokens = firstRes.usage?.inputTokens ?? 0
  let outputTokens = firstRes.usage?.outputTokens ?? 0
  let modelUsed = firstRes.model || resolvedModel.model || ''

  let parsed = extractJsonObject(firstRes.text)
  let summary = parsed
    ? parseAndValidateSingleLangPayload(parsed, lang, logicalDate, sourceKind, eligible, highFreqTerms, sourceKindById)
    : null

  const needsQualityRepair =
    !parsed ||
    !summary ||
    (summary.rawCardCount > 0 && summary.validCandidates.length === 0) ||
    (lang === 'ja' && summary.rejectedReasons.length > 0 && summary.validCandidates.length < 2)

  if (needsQualityRepair) {
    console.warn(`[LanguagePushAnalyzer:${lang}] pass 1 failed validation or JSON parse`, {
      model: firstRes.model,
      stopReason: firstRes.stopReason,
      textLen: firstRes.text.length,
      rejectedReasons: summary?.rejectedReasons ?? ['invalid_json'],
    })

    const defectSummary =
      summary && summary.rejectedReasons.length > 0
        ? `上次输出有条目未通过文字纯度校验：${summary.rejectedReasons.slice(0, 5).join('; ')}。`
        : '上次输出不是完整合法的 JSON 对象。'

    const langHint =
      lang === 'ja'
        ? '请严格只使用纯正日本常用汉字、ひらがな、カタカナ（严禁中国简体字、阿拉伯语/外语乱码、代码片段），为每条日语卡片提供纯假名 reading（不带斜杠）和覆盖例句所有汉字词的 exampleReadings。'
        : '请只输出纯正英文卡片与标准 IPA 音标。'

    const retryMessages: Array<{ role: 'user' | 'assistant'; content: string }> = firstRes.text.trim()
      ? [
          { role: 'user', content: effectiveUserPrompt },
          { role: 'assistant', content: firstRes.text.slice(0, 3500) },
          {
            role: 'user',
            content: `${defectSummary}${langHint}请直接重新输出一个完整合法的 JSON 对象，不要包含任何解释文字。`,
          },
        ]
      : [
          {
            role: 'user',
            content: `${effectiveUserPrompt}\n\n（注意：请保持思考简洁，直接输出完整合法的 JSON 对象。${langHint}）`,
          },
        ]

    const repairRes = await callLlm(resolvedModel, {
      system: systemPrompt,
      messages: retryMessages,
      ...requestOptions,
    })

    if (repairRes.ok) {
      inputTokens += repairRes.usage?.inputTokens ?? 0
      outputTokens += repairRes.usage?.outputTokens ?? 0
      modelUsed = repairRes.model || modelUsed
      const repairedParsed = extractJsonObject(repairRes.text)
      if (repairedParsed) {
        const repairedSummary = parseAndValidateSingleLangPayload(
          repairedParsed,
          lang,
          logicalDate,
          sourceKind,
          eligible,
          highFreqTerms,
          sourceKindById,
        )
        if (!summary || repairedSummary.validCandidates.length >= summary.validCandidates.length) {
          parsed = repairedParsed
          summary = repairedSummary
        }
      }
    } else if (!parsed) {
      return {
        ok: false,
        kind: repairRes.kind === 'needs_config' ? 'needs_config' : 'provider_error',
        message: repairRes.message,
      }
    }
  }

  if (!parsed || !summary) {
    const detail =
      firstRes.stopReason === 'max_tokens'
        ? '模型思考或输出达到 max_tokens 上限，未产出完整 JSON（可在设置中切换 DeepSeek 模型）。'
        : '输出中未找到合法 JSON 对象。'
    return {
      ok: false,
      kind: 'parse_error',
      message: `${lang.toUpperCase()} 语料解析失败（已重试 1 次）：${detail}`,
    }
  }

  return {
    ok: true,
    corpusItems: summary.corpusItems,
    candidates: summary.validCandidates,
    sentEntryIds: effectiveEligible.map((e) => e.id),
    inputTokens,
    outputTokens,
    modelUsed,
  }
}

export async function analyzeJournalForLanguagePush(
  input: LanguagePushAnalysisInput,
): Promise<LanguagePushAnalysisOutput> {
  const startedAt = Date.now()
  const sourceKind = input.sourceKind ?? LANGUAGE_PUSH_DEFAULT_SOURCE_KIND
  const enabledLangs =
    input.config.enabledLangs.length > 0
      ? input.config.enabledLangs.filter((l): l is LanguagePushLang => LANGUAGE_PUSH_SUPPORTED_LANGS.includes(l))
      : (['en', 'ja'] as LanguagePushLang[])

  let skippedPrivate = 0
  let skippedAlreadyProcessed = 0
  const eligibleByLang = new Map<LanguagePushLang, EligibleEntry[]>()
  const highFreqByLang = new Map<LanguagePushLang, CorpusHighFreqTerm[]>()
  // Provenance of every known entry id: fresh entries win, archived corpus fills fallbacks
  // (e.g. high-frequency terms sampled from earlier morning-brief translations).
  const sourceKindById = new Map<string, LanguagePushCorpusSourceKind>()
  for (const item of input.recentCorpusItems ?? []) {
    if (item.entryId) sourceKindById.set(item.entryId, item.sourceKind ?? LANGUAGE_PUSH_DEFAULT_SOURCE_KIND)
  }
  for (const entry of input.entries) {
    sourceKindById.set(entry.id, entry.sourceKind ?? sourceKind)
  }
  for (const lang of enabledLangs) {
    eligibleByLang.set(lang, [])
    const fam = input.familiarityByLang?.[lang]
    const hf =
      input.recentCorpusItems && input.recentCorpusItems.length > 0
        ? extractCorpusHighFreqTerms(
            input.recentCorpusItems,
            lang,
            input.config,
            fam?.excludedWordKeys ?? new Set<string>(),
          )
        : []
    highFreqByLang.set(lang, hf)
  }

  const publicEntries: EligibleEntry[] = []
  for (const entry of input.entries) {
    if (isPrivateJournalEntry(entry)) {
      skippedPrivate += 1
      continue
    }
    const entrySourceKind = entry.sourceKind ?? sourceKind
    // The human-provenance guard exists for journal entries; curated desk sources
    // (e.g. morning brief items) are not journal provenance and must not be dropped by it.
    if (entrySourceKind === LANGUAGE_PUSH_DEFAULT_SOURCE_KIND && entry.provenance && entry.provenance !== 'human') {
      continue
    }
    const scrubbed = scrubSecrets(entry.body || '')
      .replace(/!\[[^\]]*]\([^)]*\)/g, '')
      .trim()
    if (scrubbed.length < MIN_ENTRY_BODY_CHARS) continue
    publicEntries.push({
      id: entry.id,
      date: entry.date,
      time: entry.time,
      safeBody: scrubbed.slice(0, 420),
      sourceKind: entrySourceKind,
    })
  }

  for (const lang of enabledLangs) {
    const bucket = eligibleByLang.get(lang)!
    let langChars = 0
    const unprocessed: EligibleEntry[] = []
    for (const item of publicEntries) {
      const processedKey = `${item.id}:${lang}`
      if (!input.force && (input.processedEntryIds[processedKey] || input.processedEntryIds[item.id])) {
        skippedAlreadyProcessed += 1
        continue
      }
      unprocessed.push(item)
    }
    // Round-robin across sources (newest-first preserved inside each source) so a long
    // morning brief cannot starve journal entries out of the daily budget, nor vice versa.
    const queuesBySource = new Map<LanguagePushCorpusSourceKind, EligibleEntry[]>()
    for (const item of unprocessed) {
      const queue = queuesBySource.get(item.sourceKind) ?? []
      queue.push(item)
      queuesBySource.set(item.sourceKind, queue)
    }
    const queues = [...queuesBySource.values()]
    let budgetExhausted = false
    while (!budgetExhausted && bucket.length < MAX_ENTRIES_PER_RUN && queues.some((q) => q.length > 0)) {
      for (const queue of queues) {
        if (bucket.length >= MAX_ENTRIES_PER_RUN) break
        const next = queue.shift()
        if (!next) continue
        const remainingBudget = MAX_TOTAL_INPUT_CHARS - langChars
        if (remainingBudget < MIN_ENTRY_BODY_CHARS) {
          budgetExhausted = true
          break
        }
        const clipped = next.safeBody.slice(0, remainingBudget)
        langChars += clipped.length
        bucket.push({ ...next, safeBody: clipped })
      }
    }
  }

  const langsToRun = enabledLangs.filter((lang) => {
    const hasNewEntries = (eligibleByLang.get(lang)?.length ?? 0) > 0
    const canMineCorpus = Boolean(input.allowCorpusOnlyMine) && (highFreqByLang.get(lang)?.length ?? 0) > 0
    return hasNewEntries || canMineCorpus
  })
  const totalUniqueEligible = new Set(langsToRun.flatMap((l) => eligibleByLang.get(l)!.map((e) => e.id))).size

  if (langsToRun.length === 0) {
    return {
      ok: true,
      processedEntryIds: [],
      corpusItems: [],
      candidates: [],
      statsBase: {
        scannedEntries: input.entries.length,
        eligibleEntries: 0,
        skippedPrivate,
        skippedAlreadyProcessed,
        durationMs: Date.now() - startedAt,
      },
      modelUsed: input.resolvedModel.model || '',
    }
  }

  if (!input.resolvedModel.apiKey && !input.resolvedModel.authToken) {
    return {
      ok: false,
      kind: 'needs_config',
      message: '请先在「模型设置」中配置可用的云端模型 API Key。',
    }
  }

  const callLlm = input.llmCaller ?? callAnthropicMessages

  // Run one dedicated extraction per language in parallel so EN and JA never contaminate each other
  const results = await Promise.all(
    langsToRun.map(async (lang) => {
      const langEligible = eligibleByLang.get(lang)!
      const res = await runSingleLanguageExtraction({
        lang,
        logicalDate: input.logicalDate,
        sourceKind,
        eligible: langEligible,
        highFreqTerms: highFreqByLang.get(lang) ?? [],
        sourceKindById,
        familiarity: input.familiarityByLang?.[lang],
        config: input.config,
        resolvedModel: input.resolvedModel,
        callLlm,
      })
      return { lang, langEligible, res }
    }),
  )

  const corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>> = []
  const candidates: LanguagePushCandidateInput[] = []
  const processedKeys: string[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let modelUsed = input.resolvedModel.model || ''
  const errors: Array<{ lang: LanguagePushLang; kind: 'needs_config' | 'parse_error' | 'provider_error'; message: string }> = []

  for (const { lang, res } of results) {
    if (!res.ok) {
      errors.push({ lang, kind: res.kind, message: `${lang.toUpperCase()}: ${res.message}` })
      continue
    }
    corpusItems.push(...res.corpusItems)
    candidates.push(...res.candidates)
    totalInputTokens += res.inputTokens
    totalOutputTokens += res.outputTokens
    if (res.modelUsed) modelUsed = res.modelUsed
    // Only mark entries actually sent to the model as processed for this language
    if (res.candidates.length > 0 || res.corpusItems.length > 0) {
      for (const id of res.sentEntryIds) processedKeys.push(`${id}:${lang}`)
    } else {
      errors.push({
        lang,
        kind: 'parse_error',
        message: `${lang.toUpperCase()}: 未产出通过文字纯度校验的有效卡片（建议在设置中切换 DeepSeek 模型后重试）`,
      })
    }
  }

  if (errors.length === results.length) {
    return {
      ok: false,
      kind: errors[0].kind,
      message: errors.map((e) => e.message).join('；'),
    }
  }

  return {
    ok: true,
    processedEntryIds: processedKeys,
    corpusItems,
    candidates,
    partialWarnings: errors.length > 0 ? errors.map((e) => e.message) : undefined,
    statsBase: {
      scannedEntries: input.entries.length,
      eligibleEntries: totalUniqueEligible,
      skippedPrivate,
      skippedAlreadyProcessed,
      durationMs: Date.now() - startedAt,
      inputTokens: totalInputTokens || undefined,
      outputTokens: totalOutputTokens || undefined,
    },
    modelUsed,
  }
}
