/**
 * Editorial synthesizer & WeChat Markdown formatter for SentinelDesk Morning Brief.
 *
 * Models the exact narrative rhythm of 字节笔记本《每日AI早报》:
 * - Left-bar 1-sentence lead summary with hard numbers (`leadSummary`)
 * - 3 daily theme keywords (`themes`) + narrative opening (`introParagraph`)
 * - Top N stories (`items`) + 5 backup stories (`backupItems`) for instant 1-click swap
 * - Radio-host spoken script (`spokenText`) per story for MiniMax HD TTS.
 */

import { createHash } from 'node:crypto'
import type { ClaudeAgentResolvedConfig } from '../../src/claude-chat-types'
import {
  MORNING_BRIEF_CATEGORIES,
  type MorningBriefCategory,
  type MorningBriefConfig,
  type MorningBriefIssue,
  type MorningBriefRawCandidate,
  type MorningBriefStoryItem,
} from '../../src/morning-brief-contract'
import {
  callAnthropicMessages,
  type AnthropicCallOptions,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult,
} from '../anthropic-messages-client'

export type MorningBriefLlmCaller = (
  config: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>,
  request: AnthropicMessagesRequest,
  options?: AnthropicCallOptions,
) => Promise<AnthropicMessagesResult>

export type MorningBriefSynthesizeInput = {
  date: string
  candidates: readonly MorningBriefRawCandidate[]
  sourceHitCount: number
  config: MorningBriefConfig
  resolvedModel: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  markdownPath: string
  llmCaller?: MorningBriefLlmCaller
  nowIso?: string
}

export type MorningBriefSynthesizeOutput =
  | {
      ok: true
      issue: MorningBriefIssue
    }
  | {
      ok: false
      kind: 'needs_config' | 'empty_candidates' | 'parse_error' | 'provider_error'
      message: string
    }

export function formatHeadlineDateLabel(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!match) return dateStr
  const month = parseInt(match[2], 10)
  const day = parseInt(match[3], 10)
  return `${month} 月 ${day} 日`
}

function stripThinkingAndFences(raw: string): string {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenceMatch = noThink.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) return fenceMatch[1].trim()
  const firstBrace = noThink.indexOf('{')
  const lastBrace = noThink.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return noThink.slice(firstBrace, lastBrace + 1)
  }
  return noThink
}

function normalizeCategory(raw: unknown): MorningBriefCategory {
  if (typeof raw === 'string' && (MORNING_BRIEF_CATEGORIES as readonly string[]).includes(raw.trim())) {
    return raw.trim() as MorningBriefCategory
  }
  return 'Coding Agent'
}

export function estimateReadingMinutes(items: readonly MorningBriefStoryItem[], intro: string): number {
  const totalChars =
    intro.length + items.reduce((acc, item) => acc + item.title.length + item.body.length, 0)
  return Math.max(3, Math.min(15, Math.round(totalChars / 320)))
}

export function buildLeadSummaryFromItems(items: readonly MorningBriefStoryItem[]): string {
  const top = items.slice(0, 4).map((item) => item.title.replace(/[。！？!?.]+$/, '').trim())
  return top.length > 0 ? `${top.join('，')}。` : ''
}

export function formatMorningBriefMarkdown(issue: MorningBriefIssue): string {
  const lines: string[] = [
    `# 每日AI早报 · ${issue.headlineDateLabel}`,
    '',
    `> ${issue.leadSummary}`,
    '',
    `**${issue.authorName}** · 阅读 ${issue.readingMinutes} 分钟 · ${issue.issueTag}`,
    '',
    '---',
    '',
    issue.introParagraph,
    '',
  ]

  issue.items.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.title}`)
    lines.push('')
    lines.push(item.body)
    lines.push('')
    lines.push(`来源：[${item.sourceName}](${item.sourceUrl})`)
    lines.push('')
  })

  return lines.join('\n').trim() + '\n'
}

function buildEditorialSystemPrompt(targetCount: number, backupCount: number): string {
  return `你是顶级中文科技主编（风格对标公众号《字节笔记本 · 每日AI早报》），专为重度 AI 工程师、Coding Agent 玩家与独立开发者编撰晨间早报。

请从输入的候选资讯池中筛选最具含金量的 ${targetCount} 条正式入选大事 + ${backupCount} 条替补大事（优先聚焦：前沿大模型发布与评测、Coding Agent / CLI / MCP 工具链、重要开源库与论文突破、重磅行业并购/监管动态；剔除软文与低信息量水贴）。

写作铁律（去 AI 味）：
1. 标题干脆直接：点明「主体 + 核心动作 + 关键数字/突破」，28 字以内，严禁震惊体，严禁“重磅赋能、生态闭环”等公文词。
2. 正文高信噪比：每条 130～220 字，用平实犀利的中文讲清楚「发生了什么 → 关键技术指标或商业事实 → 对开发者意味着什么」。
3. 顶部速览与主题定调：
   - \`leadSummary\`：用一句话串起前 3～4 条最重要大事的核心事实（50～85 字，带硬核数字，句号收尾）。
   - \`themes\`：提炼 3 个双字或四字主题词（如 ["智能体", "开源", "算力"]）。
   - \`introParagraph\`：参照句式「X 月 X 日的 AI 圈，主题是 A、B 与 C：[用两三句话把前三条大事串起来]。以下是当天值得知道的 ${targetCount} 条 AI 大事，另有语音版可听。」
4. 口播稿 \`spokenText\`：每条配套 80～130 字电台主播口语稿，自然顺滑，把符号与缩写转为易读中文表达；严禁以“第1条、第一条、第2条、下一条”等编号前缀开头，直接切入新闻事实。
5. 严禁编造 URL：每条必须通过 \`candidateId\` 绑定输入列表中的真实候选条目。

只输出合法 JSON 对象，不要任何解释文字或代码块标记，结构如下：
{
  "leadSummary": "一句话速览导读",
  "themes": ["主题1", "主题2", "主题3"],
  "introParagraph": "开篇主题综述段",
  "selected": [
    {
      "candidateId": "输入中的 id",
      "title": "中文事实标题",
      "body": "130-220字高密度正文",
      "spokenText": "80-130字自然口播稿",
      "category": "模型与研究 | Coding Agent | 开源与工具 | 产业与监管"
    }
  ],
  "backups": [
    {
      "candidateId": "输入中的 id",
      "title": "中文事实标题",
      "body": "130-220字高密度正文",
      "spokenText": "80-130字自然口播稿",
      "category": "模型与研究 | Coding Agent | 开源与工具 | 产业与监管"
    }
  ]
}`
}

export async function synthesizeMorningBriefIssue(
  input: MorningBriefSynthesizeInput,
): Promise<MorningBriefSynthesizeOutput> {
  const { resolvedModel, candidates, config } = input
  if (!resolvedModel.apiKey?.trim() && !resolvedModel.authToken?.trim()) {
    return {
      ok: false,
      kind: 'needs_config',
      message: '尚未配置可用的云端模型凭据，请先在模型设置中完成配置。',
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      kind: 'empty_candidates',
      message: '未抓取到可用资讯候选，请检查网络连接或齿轮设置中的信源开关。',
    }
  }

  const targetCount = Math.max(5, Math.min(12, config.itemCount || 10))
  const backupCount = Math.min(6, Math.max(0, candidates.length - targetCount))
  const candidateMap = new Map<string, MorningBriefRawCandidate>()
  for (const c of candidates) {
    candidateMap.set(c.id, c)
  }

  const compactCandidates = candidates.map((c) => ({
    id: c.id,
    source: c.sourceName,
    title: c.title,
    summary: c.summary,
    publishedAt: c.publishedAt,
  }))

  const dateLabel = formatHeadlineDateLabel(input.date)
  const caller = input.llmCaller ?? callAnthropicMessages
  const isMiniMax =
    /minimax/i.test(resolvedModel.model || '') || /minimaxi?\./i.test(resolvedModel.baseUrl || '')

  let rawResult: AnthropicMessagesResult
  try {
    rawResult = await caller(
      resolvedModel,
      {
        system: buildEditorialSystemPrompt(targetCount, backupCount),
        maxTokens: 16_384,
        temperature: 0.3,
        effort: isMiniMax ? 'low' : undefined,
        messages: [
          {
            role: 'user',
            content: `早报日期：${input.date}（刊头显示：${dateLabel}）\n候选资讯池（共 ${compactCandidates.length} 条）：\n${JSON.stringify(compactCandidates, null, 2)}`,
          },
        ],
      },
      { timeoutMs: 120_000 },
    )
  } catch (error) {
    return {
      ok: false,
      kind: 'provider_error',
      message: error instanceof Error ? error.message : '云端模型请求异常',
    }
  }

  if (!rawResult.ok) {
    return {
      ok: false,
      kind: 'provider_error',
      message: rawResult.message || '云端模型生成早报失败',
    }
  }

  let parsed: {
    leadSummary?: unknown
    themes?: unknown
    introParagraph?: unknown
    selected?: unknown
    backups?: unknown
  }
  try {
    parsed = JSON.parse(stripThinkingAndFences(rawResult.text))
  } catch {
    return {
      ok: false,
      kind: 'parse_error',
      message: '模型返回的早报结构无法解析，请重试。',
    }
  }

  const usedCandidateIds = new Set<string>()
  const mapStoryList = (rawList: unknown): MorningBriefStoryItem[] => {
    if (!Array.isArray(rawList)) return []
    const out: MorningBriefStoryItem[] = []
    for (const raw of rawList) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const cid = typeof row.candidateId === 'string' ? row.candidateId.trim() : ''
      const matched = candidateMap.get(cid)
      if (!matched || usedCandidateIds.has(matched.id)) continue
      const title = typeof row.title === 'string' ? row.title.trim() : ''
      const body = typeof row.body === 'string' ? row.body.trim() : ''
      if (!title || !body) continue
      usedCandidateIds.add(matched.id)
      const spokenText =
        typeof row.spokenText === 'string' && row.spokenText.trim()
          ? row.spokenText.trim()
          : `${title}。${body}`
      const storyId = `mbs_${createHash('sha1').update(`${input.date}|${matched.id}`).digest('hex').slice(0, 10)}`
      out.push({
        id: storyId,
        title,
        body,
        spokenText,
        sourceName: matched.sourceName,
        sourceUrl: matched.url,
        category: normalizeCategory(row.category),
        publishedAt: matched.publishedAt,
      })
    }
    return out
  }

  const items = mapStoryList(parsed.selected).slice(0, targetCount)
  const backupItems = mapStoryList(parsed.backups)

  if (items.length === 0) {
    return {
      ok: false,
      kind: 'parse_error',
      message: '未能从候选池匹配到有效早报条目，请重试。',
    }
  }

  const themes = Array.isArray(parsed.themes)
    ? parsed.themes
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, 3)
    : ['智能体', '开源', '工具链']

  const leadSummary =
    typeof parsed.leadSummary === 'string' && parsed.leadSummary.trim()
      ? parsed.leadSummary.trim()
      : buildLeadSummaryFromItems(items)

  const introParagraph =
    typeof parsed.introParagraph === 'string' && parsed.introParagraph.trim()
      ? parsed.introParagraph.trim()
      : `${dateLabel}的 AI 圈，主题是${themes.join('、')}。以下是当天值得知道的 ${items.length} 条 AI 大事，另有语音版可听。`

  const nowIso = input.nowIso ?? new Date().toISOString()
  const issue: MorningBriefIssue = {
    date: input.date,
    headlineDateLabel: dateLabel,
    authorName: config.authorName.trim() || 'SentinelDesk',
    issueTag: config.issueTag.trim() || '#每日AI早报',
    readingMinutes: estimateReadingMinutes(items, introParagraph),
    leadSummary,
    themes,
    introParagraph,
    items,
    backupItems,
    candidateCount: candidates.length,
    sourceHitCount: input.sourceHitCount,
    markdownPath: input.markdownPath,
    stitchedAudioPath: null,
    modelUsed: rawResult.model || resolvedModel.model || '',
    generatedAt: nowIso,
    updatedAt: nowIso,
  }

  return { ok: true, issue }
}
