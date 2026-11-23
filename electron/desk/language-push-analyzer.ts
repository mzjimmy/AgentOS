/**
 * Privacy-guarded cloud translator & threshold-aware vocab/grammar extractor
 * for SentinelDesk Language Push.
 *
 * Precision architecture inspired by SentinelLab `reading-assist-v28-script-aligned-vocab`:
 * 1. Hard privacy filter (`isPrivateJournalEntry` + `scrubSecrets`) BEFORE prompt assembly.
 * 2. One focused, dedicated LLM call PER target language (never mixing EN & JA in one stream,
 *    preventing cross-language token drift and Simplified Chinese leakage into Japanese).
 * 3. Deterministic script & quality validator (`validateLanguageCard`) rejecting foreign scripts,
 *    PRC-Simplified-only Hanzi in Japanese, stray code/Latin artifacts, and invalid readings.
 * 4. Automatic 1-pass repair retry when JSON parsing fails or cards fail script validation.
 * 5. Mandatory `exampleReadings` kanji→kana annotations for Japanese so MiniMax TTS never
 *    mispronounces Japanese kanji compounds with Chinese pronunciation.
 */

import type { ClaudeAgentResolvedConfig } from '../../src/claude-chat-types'
import type { JournalEntry } from '../../src/journal-contract'
import {
  LANGUAGE_PUSH_SUPPORTED_LANGS,
  type LanguagePushCardKind,
  type LanguagePushConfig,
  type LanguagePushCorpusItem,
  type LanguagePushLang,
} from '../../src/language-push-contract'
import {
  callAnthropicMessages,
  type AnthropicCallOptions,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult,
} from '../anthropic-messages-client'
import { isPrivateJournalEntry, scrubSecrets } from './journal-privacy'
import type { LanguagePushCandidateInput } from './language-push-store'
import {
  isCleanJapaneseText,
  sanitizePronunciationHints,
  validateLanguageCard,
} from './language-push-validator'

const MAX_ENTRIES_PER_RUN = 6
const MAX_TOTAL_INPUT_CHARS = 2_400
const MIN_ENTRY_BODY_CHARS = 10

export type LanguagePushLlmCaller = (
  config: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>,
  request: AnthropicMessagesRequest,
  options?: AnthropicCallOptions,
) => Promise<AnthropicMessagesResult>

export type LanguagePushAnalysisInput = {
  logicalDate: string
  entries: JournalEntry[]
  processedEntryIds: Record<string, string>
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
      'あなたは熟練した日本語教師・翻訳家です。中国語話者の日記から、高品質な日本語学習カードを作成してください。',
      '以下の厳格なルールを必ず守ってください：',
      `1. 対象レベル：JLPT ${config.jaLevel} 以上。初級の基礎語（これ・する・良い・今日など）は絶対に選ばないでください。`,
      '2. 【文字の純度（最優先・違反厳禁）】',
      '   - すべての日本語テキスト（corpus と exampleSentence）は、100%自然な現代日本語（日本の常用漢字・新字体、ひらがな、カタカナ）のみで書くこと。',
      '   - 中国語の簡体字や中国語表現の直コピーを厳禁する（例：×「人机互动」「环境」「开发流程」「页面」「时间日记」 → ○「人とAIの協働」「環境」「開発フロー」「画面」「タイムライン日記」）。',
      '   - アラビア文字、キリル文字、ハングル、スペイン語、文字化け、意味不明な英字断片（例：_Manager.vue, @unlink, kis, deき 等）を絶対に含めないこと。',
      '3. 【読み仮名（reading）と発音注記（exampleReadings）の厳格ルール】',
      '   - すべてのカードの `reading` は必ず正確なひらがな・カタカナのみで書くこと。スラッシュ（/…/）や漢字やローマ字を絶対に入れないこと（例：○「てをのばす」「いとぶんせき」「ほしゅうんよう」、×「/ても/」「てをなばす」）。',
      '   - すべてのカードに `exampleReadings` 配列を必須で含め、`exampleSentence` 内に登場する**すべての漢字語・熟語**の正確なひらがな読みを列挙すること（例：[{"surface":"生成","reading":"せいせい"},{"surface":"有用","reading":"ゆうよう"},{"surface":"環境","reading":"かんきょう"}]）。これは音声合成（TTS）で中国語発音になるのを防ぐため極めて重要である。',
      '4. 抽出目安：高品質な語彙（kind: "vocab"）3〜4件 ＋ 実用的な文法表現（kind: "grammar"）1〜2件。例文は日記の文脈に忠実で自然な1文にすること。',
      '5. JSONオブジェクト1つのみを出力すること（前後に説明文を書かないこと）：',
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
    'You are an expert English language coach building a high-precision study deck from a Chinese speaker\'s personal journal.',
    'Follow these strict rules:',
    `1. Target difficulty: above top-${config.enLevel} frequency words (CEFR B2+ / idiomatic engineering & life expressions) and crisp grammar/collocation patterns.`,
    '2. NEVER output trivial basic words ("good", "time", "make", "work", etc.) and NEVER include Chinese characters, pinyin, or non-Latin garbled tokens in English text.',
    '3. `reading` MUST be accurate IPA wrapped in slashes (e.g. "/rɪˈzɪliəns/"), NEVER Chinese pinyin.',
    '4. Target output: 3-4 strong vocabulary cards (`kind: "vocab"`) + 1-2 practical grammar patterns (`kind: "grammar"`). Every example sentence must be natural, idiomatic English grounded directly in the user\'s journal entry.',
    '5. Output ONLY a single valid JSON object (no prose outside JSON):',
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
    '      "exampleSentence": "Natural idiomatic English sentence grounded in the user\'s journal",',
    '      "exampleTranslation": "对应中文译文",',
    '      "sourceEntryId": "je_..."',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

function buildUserPromptForLang(
  logicalDate: string,
  lang: LanguagePushLang,
  entries: Array<{ id: string; date: string; time: string; safeBody: string }>,
): string {
  const lines = [
    `Logical date: ${logicalDate}`,
    `Target language: ${lang === 'ja' ? 'Japanese (ja)' : 'English (en)'}`,
    '',
    'Journal entries (non-private, scrubbed):',
  ]
  for (const item of entries) {
    lines.push(`--- [${item.id}] (${item.date} ${item.time}) ---`)
    lines.push(item.safeBody)
  }
  return lines.join('\n')
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
  eligible: Array<{ id: string; date: string; time: string; safeBody: string }>,
): SingleLangParseSummary {
  const entryDateById = new Map(eligible.map((e) => [e.id, e.date]))
  const fallbackEntry = eligible[0]

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
  eligible: Array<{ id: string; date: string; time: string; safeBody: string }>
  config: LanguagePushConfig
  resolvedModel: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  callLlm: LanguagePushLlmCaller
}): Promise<
  | {
      ok: true
      corpusItems: Array<Omit<LanguagePushCorpusItem, 'createdAt'>>
      candidates: LanguagePushCandidateInput[]
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
  const { lang, logicalDate, eligible, config, resolvedModel, callLlm } = params
  const systemPrompt = buildSystemPromptForLang(lang, config)

  // Keep high output budget for reasoning models; MiniMax-M3.1-Flash must use `effort: 'low'`
  // on both EN and JA or its unbounded thinking loop hits the 90s HTTP timeout.
  const isMiniMaxFlash = resolvedModel.model?.trim().toLowerCase() === 'minimax-m3.1-flash'
  const effectiveEligible = isMiniMaxFlash && lang === 'ja' ? eligible.slice(0, 4) : eligible
  const effectiveUserPrompt = buildUserPromptForLang(logicalDate, lang, effectiveEligible)
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
  let summary = parsed ? parseAndValidateSingleLangPayload(parsed, lang, logicalDate, eligible) : null

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
        const repairedSummary = parseAndValidateSingleLangPayload(repairedParsed, lang, logicalDate, eligible)
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
    inputTokens,
    outputTokens,
    modelUsed,
  }
}

export async function analyzeJournalForLanguagePush(
  input: LanguagePushAnalysisInput,
): Promise<LanguagePushAnalysisOutput> {
  const startedAt = Date.now()
  const enabledLangs =
    input.config.enabledLangs.length > 0
      ? input.config.enabledLangs.filter((l): l is LanguagePushLang => LANGUAGE_PUSH_SUPPORTED_LANGS.includes(l))
      : (['en', 'ja'] as LanguagePushLang[])

  let skippedPrivate = 0
  let skippedAlreadyProcessed = 0
  const eligibleByLang = new Map<LanguagePushLang, Array<{ id: string; date: string; time: string; safeBody: string }>>()
  for (const lang of enabledLangs) eligibleByLang.set(lang, [])

  const publicEntries: Array<{ id: string; date: string; time: string; safeBody: string }> = []
  for (const entry of input.entries) {
    if (isPrivateJournalEntry(entry)) {
      skippedPrivate += 1
      continue
    }
    if (entry.provenance && entry.provenance !== 'human') {
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
    })
  }

  for (const lang of enabledLangs) {
    const bucket = eligibleByLang.get(lang)!
    let langChars = 0
    for (const item of publicEntries) {
      const processedKey = `${item.id}:${lang}`
      if (!input.force && (input.processedEntryIds[processedKey] || input.processedEntryIds[item.id])) {
        skippedAlreadyProcessed += 1
        continue
      }
      if (bucket.length >= MAX_ENTRIES_PER_RUN) break
      const remainingBudget = MAX_TOTAL_INPUT_CHARS - langChars
      if (remainingBudget < MIN_ENTRY_BODY_CHARS) break
      const clipped = item.safeBody.slice(0, remainingBudget)
      langChars += clipped.length
      bucket.push({ ...item, safeBody: clipped })
    }
  }

  const langsToRun = enabledLangs.filter((lang) => (eligibleByLang.get(lang)?.length ?? 0) > 0)
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
        eligible: langEligible,
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

  for (const { lang, langEligible, res } of results) {
    if (!res.ok) {
      errors.push({ lang, kind: res.kind, message: `${lang.toUpperCase()}: ${res.message}` })
      continue
    }
    corpusItems.push(...res.corpusItems)
    candidates.push(...res.candidates)
    totalInputTokens += res.inputTokens
    totalOutputTokens += res.outputTokens
    if (res.modelUsed) modelUsed = res.modelUsed
    // Only mark entries processed for this specific language when it actually succeeded with valid cards
    if (res.candidates.length > 0 || res.corpusItems.length > 0) {
      for (const e of langEligible) processedKeys.push(`${e.id}:${lang}`)
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
