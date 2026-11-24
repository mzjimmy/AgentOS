/**
 * Privacy-guarded dual-track Outbound analyzer & anti-AI-slop WeChat column drafter
 * for SentinelDesk Outbound Studio (外宣工坊).
 *
 * Security & Editorial invariants:
 * 1. Hard privacy filter (`isPrivateJournalEntry` + `scrubSecrets`) intercepts private
 *    entries and secret tokens BEFORE prompt assembly or disk persistence.
 * 2. Strictly separates Moments/Ship-Log snapshots from single-point WeChat column seeds.
 * 3. Enforces 字节笔记本-inspired narrative structure: single concrete pain point, short
 *    1-2 sentence mobile paragraphs, concrete device/error details, candid self-deprecation,
 *    and deterministic stripping of AI clichés.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ClaudeAgentResolvedConfig } from '../../src/claude-chat-types'
import type { JournalEntry } from '../../src/journal-contract'
import {
  OUTBOUND_COLUMNS,
  OUTBOUND_MOMENT_ANGLES,
  type OutboundArticleDraft,
  type OutboundArticleSeed,
  type OutboundColumn,
  type OutboundConfig,
  type OutboundDayPack,
  type OutboundMomentAngle,
  type OutboundMomentCard,
  type OutboundSourceAnchor,
} from '../../src/outbound-contract'
import {
  callAnthropicMessages,
  type AnthropicCallOptions,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult,
} from '../anthropic-messages-client'
import { isPrivateJournalEntry, scrubSecrets } from './journal-privacy'

export type OutboundLlmCaller = (
  config: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>,
  request: AnthropicMessagesRequest,
  options?: AnthropicCallOptions,
) => Promise<AnthropicMessagesResult>

export type SanitizedJournalSnippet = {
  date: string
  entryId: string
  createdAt: string
  category?: string
  body: string
}

export type SanitizedRepoCommit = {
  repoName: string
  sha: string
  date: string
  subject: string
}

const BANNED_AI_BUZZWORDS: ReadonlyArray<[RegExp, string]> = [
  [/赋能/g, '支持'],
  [/抓手/g, '切入点'],
  [/形成闭环/g, '跑通流程'],
  [/完整闭环/g, '完整流程'],
  [/最后一块拼图/g, '关键一步'],
  [/最后两块拼图/g, '关键两步'],
  [/拒绝信息过载/g, '少看废话'],
  [/总而言之[，,]?/g, ''],
  [/综上所述[，,]?/g, ''],
]

export function sanitizeAiSlopPhrases(text: string): string {
  let out = text
  for (const [pattern, replacement] of BANNED_AI_BUZZWORDS) {
    out = out.replace(pattern, replacement)
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function filterPublicJournalEntries(
  entriesByDate: ReadonlyArray<{ date: string; entries: readonly JournalEntry[] }>,
): { publicEntries: SanitizedJournalSnippet[]; skippedPrivate: number } {
  const publicEntries: SanitizedJournalSnippet[] = []
  let skippedPrivate = 0

  for (const day of entriesByDate) {
    for (const entry of day.entries) {
      if (isPrivateJournalEntry(entry)) {
        skippedPrivate += 1
        continue
      }
      const cleanBody = scrubSecrets((entry.body || '').trim())
      if (cleanBody.length < 6) continue
      publicEntries.push({
        date: day.date,
        entryId: entry.id,
        createdAt: entry.ts || entry.time || day.date,
        category: entry.category,
        body: cleanBody.slice(0, 900),
      })
    }
  }

  return { publicEntries, skippedPrivate }
}

export function collectRecentRepoCommits(
  repoPaths: readonly string[],
  sinceDays: number,
  maxPerRepo = 14,
): SanitizedRepoCommit[] {
  const commits: SanitizedRepoCommit[] = []
  const days = Math.max(1, Math.min(14, sinceDays || 3))

  for (const rawPath of repoPaths) {
    const repoPath = rawPath.trim()
    if (!repoPath || !existsSync(repoPath)) continue
    try {
      const output = execFileSync(
        'git',
        [
          '-C',
          repoPath,
          'log',
          `--since=${days}.days`,
          '--no-merges',
          `--max-count=${maxPerRepo}`,
          '--date=short',
          '--pretty=format:%h|%ad|%s',
        ],
        { encoding: 'utf8', timeout: 4_000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const repoName = path.basename(repoPath)
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const [sha, date, ...rest] = trimmed.split('|')
        const subject = scrubSecrets(rest.join('|').trim())
        if (!sha || !date || !subject) continue
        commits.push({ repoName, sha: sha.trim(), date: date.trim(), subject })
      }
    } catch {
      /* ignore non-git or inaccessible path */
    }
  }

  return commits
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

function normalizeColumn(raw: unknown): OutboundColumn {
  if (typeof raw === 'string' && (OUTBOUND_COLUMNS as readonly string[]).includes(raw.trim())) {
    return raw.trim() as OutboundColumn
  }
  return '折腾实录'
}

function normalizeMomentAngle(raw: unknown): OutboundMomentAngle {
  if (typeof raw === 'string' && (OUTBOUND_MOMENT_ANGLES as readonly string[]).includes(raw.trim())) {
    return raw.trim() as OutboundMomentAngle
  }
  return '上线一瞥'
}

export async function extractOutboundDayPack(params: {
  date: string
  publicEntries: readonly SanitizedJournalSnippet[]
  skippedPrivateEntries: number
  commits: readonly SanitizedRepoCommit[]
  config: OutboundConfig
  resolvedModel: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  llmCaller?: OutboundLlmCaller
  nowIso?: string
}): Promise<
  | { ok: true; dayPack: OutboundDayPack }
  | { ok: false; kind: 'needs_config' | 'empty_input' | 'parse_error' | 'provider_error'; message: string }
> {
  const { resolvedModel, publicEntries, commits, config } = params
  if (!resolvedModel.apiKey?.trim() && !resolvedModel.authToken?.trim()) {
    return {
      ok: false,
      kind: 'needs_config',
      message: '尚未配置云端模型凭据，请先在模型设置中配置。',
    }
  }

  if (publicEntries.length === 0 && commits.length === 0) {
    return {
      ok: false,
      kind: 'empty_input',
      message: '近期暂无可用的非私密时间日记或代码提交。',
    }
  }

  const validAnchorMap = new Map<string, OutboundSourceAnchor>()
  for (const e of publicEntries) {
    validAnchorMap.set(e.entryId, {
      kind: 'journal',
      date: e.date,
      refId: e.entryId,
      label: `${e.date} · ${e.entryId.slice(-6)}`,
    })
  }
  for (const c of commits) {
    validAnchorMap.set(c.sha, {
      kind: 'commit',
      date: c.date,
      refId: c.sha,
      label: `${c.repoName}@${c.sha}`,
    })
  }

  const systemPrompt = `你是「${config.companyName}」这家 AI 原生一人公司的驻场科技记者与主笔（作者人设：${config.authorPersona}）。
你的任务是从近期的「非私密时间日记」与「真实代码提交」中，分别提炼两条**完全独立、绝不混同**的内容输出：

轨道一：朋友圈 / 即刻日常切片（moments，2～3 条）
- 定位：这家一人公司的茶水间幕后花絮、上线一瞥（Ship Log）或真实踩坑吐槽。
- 铁律：严禁写成 1️⃣ 2️⃣ 3️⃣ 4️⃣ 的官方版本更新公告！每条只抓 **1 个具体瞬间**，2～4 行自然口语大白话（80～150 字），有活人感、有细节或冷幽默，附一句配图建议 \`mediaHint\`。

轨道二：公众号深度专栏单点选题种子（seeds，2～3 个）
- 定位：对标《字节笔记本》的高共鸣实战专栏，归入 4 大固定栏目之一：「折腾实录 | 工作台拆解 | 深读祛魅 | 单品发布」。
- 铁律：**一篇只讲透一个具体痛点或反常识切口**，绝不做“今天我做了四个功能”的工作周报全景盘点！每个种子给出抓人但不标题党的单点标题、一句话核心悬念 \`hook\`、以及 3 步线性递进故事线 \`storyArc\`。

写作红线：${config.antiAiRedlines}
严禁捏造事实；每条必须通过 \`anchorIds\` 引用输入中真实的 \`entryId\` 或 \`sha\`。

只输出合法 JSON 对象，格式如下：
{
  "moments": [
    {
      "angle": "上线一瞥 | 幕后吐槽 | 思考切片",
      "body": "2-4行大白话文案（不含编号列表）",
      "mediaHint": "一句极简配图建议",
      "anchorIds": ["entryId或sha"]
    }
  ],
  "seeds": [
    {
      "column": "折腾实录 | 工作台拆解 | 深读祛魅 | 单品发布",
      "title": "单点切口公众号标题",
      "hook": "一句话读者共鸣痛点或反差",
      "storyArc": ["第1幕：真实痛点场景", "第2幕：试错与折腾细节", "第3幕：解决方案或反转"],
      "anchorIds": ["entryId或sha"]
    }
  ]
}`

  const userPayload = {
    targetDate: params.date,
    publicJournalEntries: publicEntries.slice(0, 28),
    recentGitCommits: commits.slice(0, 20),
  }

  const caller = params.llmCaller ?? callAnthropicMessages
  const isMiniMax =
    /minimax/i.test(resolvedModel.model || '') || /minimaxi?\./i.test(resolvedModel.baseUrl || '')
  let res: AnthropicMessagesResult
  try {
    res = await caller(
      resolvedModel,
      {
        system: systemPrompt,
        maxTokens: 16_384,
        temperature: 0.4,
        effort: isMiniMax ? 'low' : undefined,
        messages: [{ role: 'user', content: JSON.stringify(userPayload, null, 2) }],
      },
      { timeoutMs: 120_000 },
    )
  } catch (error) {
    return {
      ok: false,
      kind: 'provider_error',
      message: error instanceof Error ? error.message : '云端模型调用失败',
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: 'provider_error',
      message: res.message || '选题提炼失败',
    }
  }

  let parsed: { moments?: unknown; seeds?: unknown }
  try {
    parsed = JSON.parse(stripThinkingAndFences(res.text))
  } catch {
    return {
      ok: false,
      kind: 'parse_error',
      message: '模型返回的选题 JSON 无法解析，请重试。',
    }
  }

  const mapAnchors = (rawIds: unknown): OutboundSourceAnchor[] => {
    if (!Array.isArray(rawIds)) return []
    const out: OutboundSourceAnchor[] = []
    const seen = new Set<string>()
    for (const id of rawIds) {
      const key = typeof id === 'string' ? id.trim() : ''
      if (!key || seen.has(key)) continue
      const anchor = validAnchorMap.get(key)
      if (anchor) {
        seen.add(key)
        out.push(anchor)
      }
    }
    return out
  }

  const moments: OutboundMomentCard[] = []
  if (Array.isArray(parsed.moments)) {
    for (const raw of parsed.moments.slice(0, 4)) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const body = typeof row.body === 'string' ? sanitizeAiSlopPhrases(scrubSecrets(row.body)) : ''
      if (!body) continue
      const id = `om_${createHash('sha1').update(`${params.date}|${body}`).digest('hex').slice(0, 10)}`
      moments.push({
        id,
        angle: normalizeMomentAngle(row.angle),
        body,
        mediaHint: typeof row.mediaHint === 'string' ? row.mediaHint.trim() : undefined,
        anchors: mapAnchors(row.anchorIds),
        copiedAt: null,
      })
    }
  }

  const seeds: OutboundArticleSeed[] = []
  if (Array.isArray(parsed.seeds)) {
    for (const raw of parsed.seeds.slice(0, 4)) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const title = typeof row.title === 'string' ? sanitizeAiSlopPhrases(scrubSecrets(row.title)) : ''
      const hook = typeof row.hook === 'string' ? sanitizeAiSlopPhrases(scrubSecrets(row.hook)) : ''
      if (!title || !hook) continue
      const storyArc = Array.isArray(row.storyArc)
        ? row.storyArc
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => sanitizeAiSlopPhrases(scrubSecrets(s.trim())))
            .slice(0, 4)
        : []
      const id = `os_${createHash('sha1').update(`${params.date}|${title}`).digest('hex').slice(0, 10)}`
      seeds.push({
        id,
        column: normalizeColumn(row.column),
        title,
        hook,
        storyArc,
        anchors: mapAnchors(row.anchorIds),
        draftId: null,
      })
    }
  }

  if (moments.length === 0 && seeds.length === 0) {
    return {
      ok: false,
      kind: 'parse_error',
      message: '未提炼出有效日常切片或选题种子，请重试。',
    }
  }

  const nowIso = params.nowIso ?? new Date().toISOString()
  return {
    ok: true,
    dayPack: {
      date: params.date,
      moments,
      seeds,
      scannedJournalEntries: publicEntries.length,
      skippedPrivateEntries: params.skippedPrivateEntries,
      scannedCommits: commits.length,
      modelUsed: res.model || resolvedModel.model || '',
      generatedAt: nowIso,
    },
  }
}

export async function draftOutboundWeChatArticle(params: {
  date: string
  seed: OutboundArticleSeed
  publicEntries: readonly SanitizedJournalSnippet[]
  commits: readonly SanitizedRepoCommit[]
  config: OutboundConfig
  customAngle?: string
  markdownPath: string
  resolvedModel: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  llmCaller?: OutboundLlmCaller
  nowIso?: string
}): Promise<
  | { ok: true; draft: OutboundArticleDraft }
  | { ok: false; kind: 'needs_config' | 'parse_error' | 'provider_error'; message: string }
> {
  const { resolvedModel, seed, config } = params
  if (!resolvedModel.apiKey?.trim() && !resolvedModel.authToken?.trim()) {
    return {
      ok: false,
      kind: 'needs_config',
      message: '尚未配置云端模型凭据。',
    }
  }

  const systemPrompt = `你是一位极具活人感的技术号主（文风深度对标微信公众号《字节笔记本》），正在为「${config.companyName}」（人设：${config.authorPersona}）撰写一篇公众号原创文章。

请严格遵守以下「去 AI 味」公众号写作铁律：
1. 单线故事到底：全文只围绕当前选定的这 **1 个核心痛点/折腾切口** 展开，按线性叙事层层推进（起因烦人痛点 → 试错踩坑/具体方案 → 意外发现或实测结论），严禁写成“一、二、三、四”全景周报或 PPT 项目符号说明书！
2. 手机竖屏短句节奏：**几乎每段只有 1～2 句话**，段间空行，让手机读者大拇指下滑毫不费力；二级小标题用大白话故事节点（如“第一个坑：……”、“让 Gemini 给 Codex 打下手”），不用公文式小标题。
3. 保真物理颗粒度：充分利用素材中的具体设备型号、报错卡点、真实交互细节（例如等红灯发语音、某型号手机权限门槛、半夜切换模型捉虫等），不要把鲜活细节洗成空洞的架构术语。
4. 真性情与自嘲：允许承认自己嫌麻烦、走过弯路或适度自嘲，不要端着架子自我吹嘘“完美闭环”。结尾只留 **1 句具体好答的互动提问**。
5. 硬性禁用词：${config.antiAiRedlines}
6. 严禁虚构素材中不存在的账号数量或收益金额；素材未提及的细节保持诚实留白。

只输出合法 JSON 对象：
{
  "title": "主推标题（自然抓人、反常识或具体痛点）",
  "altTitles": ["备选标题1", "备选标题2"],
  "bodyMarkdown": "不含一级大标题的正文 Markdown（含 ## 故事小节、短段落与结尾互动提问）"
}`

  const caller = params.llmCaller ?? callAnthropicMessages
  const isMiniMax =
    /minimax/i.test(resolvedModel.model || '') || /minimaxi?\./i.test(resolvedModel.baseUrl || '')
  let res: AnthropicMessagesResult
  try {
    res = await caller(
      resolvedModel,
      {
        system: systemPrompt,
        maxTokens: 16_384,
        temperature: 0.45,
        effort: isMiniMax ? 'low' : undefined,
        messages: [
          {
            role: 'user',
            content: JSON.stringify(
              {
                seed,
                customAngle: params.customAngle?.trim() || undefined,
                supportingPublicJournalEntries: params.publicEntries.slice(0, 24),
                supportingGitCommits: params.commits.slice(0, 16),
              },
              null,
              2,
            ),
          },
        ],
      },
      { timeoutMs: 120_000 },
    )
  } catch (error) {
    return {
      ok: false,
      kind: 'provider_error',
      message: error instanceof Error ? error.message : '成稿请求失败',
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: 'provider_error',
      message: res.message || '公众号初稿生成失败',
    }
  }

  let parsed: { title?: unknown; altTitles?: unknown; bodyMarkdown?: unknown }
  try {
    parsed = JSON.parse(stripThinkingAndFences(res.text))
  } catch {
    return {
      ok: false,
      kind: 'parse_error',
      message: '模型返回的文章 JSON 无法解析，请重试。',
    }
  }

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? sanitizeAiSlopPhrases(scrubSecrets(parsed.title.trim()))
      : seed.title
  const bodyMarkdown =
    typeof parsed.bodyMarkdown === 'string' && parsed.bodyMarkdown.trim()
      ? sanitizeAiSlopPhrases(scrubSecrets(parsed.bodyMarkdown.trim()))
      : ''

  if (!bodyMarkdown) {
    return {
      ok: false,
      kind: 'parse_error',
      message: '生成的文章正文为空，请重试。',
    }
  }

  const altTitles = Array.isArray(parsed.altTitles)
    ? parsed.altTitles
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => sanitizeAiSlopPhrases(scrubSecrets(t.trim())))
        .slice(0, 3)
    : []

  const nowIso = params.nowIso ?? new Date().toISOString()
  const draftId = `oad_${createHash('sha1').update(`${params.date}|${seed.id}`).digest('hex').slice(0, 10)}`
  const fullMarkdown = `# ${title}\n\n${bodyMarkdown}\n`

  return {
    ok: true,
    draft: {
      id: draftId,
      seedId: seed.id,
      date: params.date,
      column: seed.column,
      title,
      altTitles,
      markdown: fullMarkdown,
      markdownPath: params.markdownPath,
      modelUsed: res.model || resolvedModel.model || '',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  }
}
