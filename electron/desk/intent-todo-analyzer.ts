/**
 * Intent Todo Analyzer:
 * - Single-day isolated analysis (`targetDate` or current Shanghai logical day) so historical dates
 *   are never swept or activated in bulk.
 * - Hard privacy filter, provenance separation, secret scrubbing, and token-budget capping.
 * - Parallel `execFile('git', ...)` verification on mentioned workspace projects only
 *   (produces `suggestedDone` hints; never auto-hides user todos).
 * - Tolerant JSON extraction + hand-written schema validation + up to 1 repair retry.
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeAgentResolvedConfig } from '../../src/claude-chat-types'
import type { JournalEntry } from '../../src/journal-contract'
import {
  INTENT_TODO_TITLE_MAX_LEN,
  type IntentTodoActionKind,
  type IntentTodoAnchor,
  type IntentTodoTrack,
  type IntentTodoUrgency,
} from '../../src/intent-todo-contract'
import {
  callAnthropicMessages,
  type AnthropicCallOptions,
  type AnthropicMessagesErrorKind,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResult,
} from '../anthropic-messages-client'
import {
  computeJournalEntryBodyHash,
  computeJournalEntryContentHash,
  detectSuspectedAiPaste,
  isPrivateJournalEntry,
  scrubSecrets,
} from './journal-privacy'
import {
  getShanghaiCutoverIso,
  getShanghaiLogicalDay,
  shiftDateString,
} from './intent-todo-time'
import { extractProjectMatchTokens } from './project-match-tokens'
import type { CandidateIntentTodo, DroppedFingerprint } from './intent-todo-store'

const execFileAsync = promisify(execFile)

const MAX_ENTRY_CHARS = 1500
const MAX_TOTAL_ENTRY_CHARS = 60_000
const MAX_ENTRIES_PER_BATCH = 10
const MAX_BATCH_ENTRY_CHARS = 8_000
const GIT_LOG_TIMEOUT_MS = 2_000
const INTENT_TODO_LLM_TIMEOUT_MS = 180_000
const INTENT_TODO_LLM_IDLE_TIMEOUT_MS = 60_000

export type AnalyzerBatchCommitPayload = {
  batchIndex: number
  totalBatches: number
  logicalDate: string
  ranAt: string
  providerName: string
  modelUsed: string
  processedHashes: string[]
  processedBodyHashes: string[]
  candidates: CandidateIntentTodo[]
  stats: {
    scannedEntries: number
    newHumanEntries: number
    skippedPrivate: number
    suspectedAiPaste: number
    ignoredNoiseCount: number
    durationMs: number
    inputTokens?: number
    outputTokens?: number
  }
}

export type AnalyzerBatchContextUpdate = {
  openItems?: Array<{ id: string; title: string; track: IntentTodoTrack; status: string }>
  closedItems?: Array<{ id: string; title: string; track: IntentTodoTrack; status: string; anchorEntryIds?: string[] }>
}

export type WorkspaceProjectRef = {
  id: string
  name: string
  path: string
}

export type JournalDayReader = {
  getDay(date: string): Promise<{ ok: true; entries: JournalEntry[] } | { ok: false; error: string }>
}

export type AnalyzerInput = {
  journalStore: JournalDayReader
  projects: WorkspaceProjectRef[]
  processedEntryHashes: Record<string, string>
  processedEntryBodies?: Record<string, string>
  openItems: Array<{ id: string; title: string; track: IntentTodoTrack; status: string }>
  closedItems?: Array<{ id: string; title: string; track: IntentTodoTrack; status: string; anchorEntryIds?: string[] }>
  droppedFingerprints: DroppedFingerprint[]
  resolvedConfig: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>
  providerName: string
  targetDate?: string
  cutoverHour?: number
  now?: Date
  callLlm?: (
    config: Pick<ClaudeAgentResolvedConfig, 'apiKey' | 'authToken' | 'baseUrl' | 'model'>,
    request: AnthropicMessagesRequest,
    options?: AnthropicCallOptions,
  ) => Promise<AnthropicMessagesResult>
  gitLogFetcher?: (project: WorkspaceProjectRef, sinceIso: string) => Promise<string[]>
  /** When true, bypasses incremental hash deduplication for this day (e.g. after switching cloud models). */
  forceReanalyze?: boolean
  /** Optional batch sizing overrides (primarily for testing). */
  maxEntriesPerBatch?: number
  maxBatchChars?: number
  /**
   * Optional checkpoint callback invoked immediately after each batch succeeds.
   * Returning refreshed openItems/closedItems feeds the persisted IDs into subsequent batches.
   */
  onBatchComplete?: (
    batch: AnalyzerBatchCommitPayload,
  ) => Promise<AnalyzerBatchContextUpdate | void> | AnalyzerBatchContextUpdate | void
}

export type AnalyzerOutput =
  | {
      ok: true
      logicalDate: string
      ranAt: string
      providerName: string
      modelUsed: string
      processedHashes: string[]
      processedBodyHashes: string[]
      candidates: CandidateIntentTodo[]
      stats: {
        scannedEntries: number
        newHumanEntries: number
        skippedPrivate: number
        suspectedAiPaste: number
        ignoredNoiseCount: number
        durationMs: number
        inputTokens?: number
        outputTokens?: number
      }
    }
  | {
      ok: false
      kind: AnthropicMessagesErrorKind | 'parse_error'
      message: string
      completedBatches?: number
      totalBatches?: number
    }

type PreparedEntry = {
  entry: JournalEntry
  contentHash: string
  bodyHash: string
  scrubbedBody: string
  weakEvidence: boolean
  suspectedAiPaste: boolean
}

const ANCHOR_KIND_LABELS: Record<JournalEntry['kind'], string> = {
  note: '方框笔记',
  photo: '照片',
  thought: '随想',
  moment: '瞬间',
  ai: 'AI 记录',
  judgment: '判断',
}

/**
 * Builds metadata-only provenance labels for an anchor. Deliberately carries no
 * journal body text, so dispatched prompts and persisted items stay free of it.
 */
function buildAnchorFlags(item: PreparedEntry): string[] {
  const flags: string[] = [item.entry.provenance === 'human' ? '人类手写' : 'AI 生成']
  if (item.entry.category) flags.push(`分类:${item.entry.category}`)
  flags.push(`形态:${ANCHOR_KIND_LABELS[item.entry.kind] ?? item.entry.kind}`)
  if (item.weakEvidence) flags.push('弱证据')
  if (item.suspectedAiPaste) flags.push('疑似含粘贴AI回复')
  return flags
}

/**
 * Strips `<think>...</think>` blocks and ```json ... ``` fences, then extracts
 * the outermost JSON object `{ ... }`.
 */
export function extractJsonObjectText(raw: string): string | null {
  if (!raw) return null
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}

type RawModelTodo = {
  matchesExistingId?: unknown
  title?: unknown
  reason?: unknown
  track?: unknown
  actionKind?: unknown
  urgency?: unknown
  suggestedProjectName?: unknown
  targetSurface?: unknown
  repoHint?: unknown
  doneCriteria?: unknown
  nonGoals?: unknown
  antiPatterns?: unknown
  anchorEntryIds?: unknown
  alreadyDone?: unknown
  suggestedDoneSha?: unknown
  suggestedDoneMessage?: unknown
}

export type ParsedModelPayload = {
  ignoredNoiseCount: number
  todos: RawModelTodo[]
}

export function validateAndParseModelJson(
  rawText: string,
): { ok: true; payload: ParsedModelPayload } | { ok: false; error: string } {
  const jsonSlice = extractJsonObjectText(rawText)
  if (!jsonSlice) {
    return { ok: false, error: '输出中未找到合法 JSON 对象 `{ ... }`。' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonSlice)
  } catch (error) {
    return {
      ok: false,
      error: `JSON 语法解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '顶层 JSON 必须是对象，包含 `todos` 数组。' }
  }

  const rec = parsed as Record<string, unknown>
  if (!Array.isArray(rec.todos)) {
    return { ok: false, error: '缺少必填字段 `todos`（必须是数组）。' }
  }

  const errors: string[] = []
  for (let i = 0; i < rec.todos.length; i++) {
    const item = rec.todos[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`todos[${i}] 必须是对象`)
      continue
    }
    const row = item as Record<string, unknown>
    if (typeof row.title !== 'string' || !row.title.trim()) {
      errors.push(`todos[${i}].title 必须是非空中文字符串`)
    }
    if (row.track !== 'engineering' && row.track !== 'life') {
      errors.push(`todos[${i}].track 必须是 "engineering" 或 "life"`)
    }
    if (row.urgency !== 'high' && row.urgency !== 'medium' && row.urgency !== 'low') {
      errors.push(`todos[${i}].urgency 必须是 "high" | "medium" | "low"`)
    }
    if (!Array.isArray(row.anchorEntryIds) || row.anchorEntryIds.length === 0) {
      errors.push(`todos[${i}].anchorEntryIds 必须包含至少一个源日记 entryId`)
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.slice(0, 6).join('；') }
  }

  return {
    ok: true,
    payload: {
      ignoredNoiseCount:
        typeof rec.ignoredNoiseCount === 'number' && rec.ignoredNoiseCount >= 0
          ? Math.floor(rec.ignoredNoiseCount)
          : 0,
      todos: rec.todos as RawModelTodo[],
    },
  }
}

export async function defaultFetchGitLog(project: WorkspaceProjectRef, sinceIso: string): Promise<string[]> {
  if (!project.path || !existsSync(path.join(project.path, '.git'))) {
    return []
  }
  const lines: string[] = []
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `--since=${sinceIso}`, '--format=%h %cI %s', '-n', '25'],
      { cwd: project.path, timeout: GIT_LOG_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    )
    lines.push(
      ...stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
  } catch {
    /* ignore git log error */
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--short'],
      { cwd: project.path, timeout: GIT_LOG_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    )
    const dirtyWithMtime: string[] = []
    for (const rawLine of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20)) {
      const fileRel = rawLine.slice(2).trim().replace(/^"|"$/g, '')
      let mtimeTag = ''
      try {
        const abs = path.join(project.path, fileRel)
        if (existsSync(abs)) {
          mtimeTag = ` (mtime:${statSync(abs).mtime.toISOString()})`
        }
      } catch {
        /* ignore stat error */
      }
      dirtyWithMtime.push(`${rawLine}${mtimeTag}`)
    }
    if (dirtyWithMtime.length > 0) {
      lines.push(`[工作区未提交改动及修改时间] ${dirtyWithMtime.join('; ')}`)
    }
  } catch {
    /* ignore git status error */
  }
  return lines
}

function truncateBody(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…[已截断]`
}

function buildSystemPrompt(): string {
  return [
    '你是 AgentOS 的「时间日记意图提取器」（遵循 notion-intent v1.7.0 规则）。',
    '核心铁律：',
    '1. 只有用户自己的表述（human）是意图证据；标注为疑似混入粘贴 AI 回复或弱证据的条目，只取用户的提问、评判与否定约束，AI 的长篇方案只是假设。',
    '2. 纯状态、情绪、打卡、测试消息（如「起床了」「测试一下」「很开心」）不得硬凑成待办，计入 ignoredNoiseCount。',
    '3. AI 派发提示词 / 开发履历（F 类，严禁拆碎！）：若条目带有 `tags:开发履历`，或明显是用户直接发给 AI 助手执行的排查/修复提示词（如带 `@项目名`、编号 1/2/3/4 要求 AI 修改代码）：',
    '   - 严禁把 1 条提示词里的 1/2/3/4/5 拆成多条碎片待办！',
    '   - 先做「时间戳因果校验」：对比该条目时间与仓库提交/工作区文件 mtime。若在该条目时间**之后**相关代码已有对应提交或修改，直接收拢为最多 1 条并设 `alreadyDone: true`（`suggestedDoneSha: "workspace"` 或 commit SHA），归入开发履历/已闭环；若尚无后续改动，也最多聚合为 1 条跟进项。',
    '4. 单目标纯度（严禁跨主题打包）：同一主题在当日的多条演进合并为 1 条并汇总 anchorEntryIds；但**不同主题**或**不同成熟度**（如「隐私问答」「Fork 推送核实」「留作 follow up 的方案探讨」）**绝不可**揉成 1 条笼统大待办。远期探索/空泛愿景（「以后有空想了解…」）不进入当日待办。',
    '5. 动作形态强分流（actionKind，防止把提问/探讨当成施工单）：',
    '   - "implement"：用户痛点、期望行为与归属位置清晰的具体代码改动/修 Bug。',
    '   - "investigate"：用户在提问或要求核实机制（如「会不会上传云端」「会不会推到上游」），仅核实汇报，不擅自改代码。',
    '   - "design"：用户明说「再探讨」「留作 follow up」「先思考一下形态」，需先给方案与选项等确认，不得直接写代码。',
    '   - "life"：现实生活/事务，非代码任务。',
    '6. 落点与触达面强绑定（targetSurface，防止下游 Agent 做到错的地方）：',
    '   - 遵循「用户在哪里产生行为、在哪里看结果，入口与反馈就必须落在哪一页」。工程待办必须写明具体归属页面/交互表面（如「时间日记页 · 顶栏与卡片（JournalPage / JournalCard）」），严禁只写宽泛的 `electron/desk`；若无法确定，必须写 "未定（开工前先确认落点）"。',
    '7. 标题必须统一使用简体中文、动词开头、不超过 24 字；不要脑补或擅自“纠偏”语音转写错字，保持用户本意。',
    '8. 已闭环直接标记完成：若 git commits、工作区近期改动或当日更晚的日记条目已明确完成某事项（如前条「准备去X」→后条「刚做完X」，或提交记录已实现该修复），务必将 alreadyDone 设为 true，并填写简短事实依据 suggestedDoneSha（commit SHA 或 "journal"/"workspace"）与 suggestedDoneMessage（<=20字，不要写客套话）。系统会自动将其归入「已闭环」。',
    '9. 紧迫度严格分层（严禁全部标高）：',
    '   - high：仅限涉及安全/隐私红线、阻塞当天主流程、或用户明确要马上处理/刚报的缺陷（通常不超过 3 条）。',
    '   - medium：明确的下一步功能优化、交互改进或硬件/方案调研。',
    '   - low：低频整理、架构探讨或暂不急迫的改善项。',
    '10. 项目匹配严禁按单词盲猜：suggestedProjectName 只能从「工作台可用项目」中选择与日记语境明确一致的项目；若日记提到的工具/Skill/外置仓库不在列表中，必须填 null，严禁仅因某个词（如 notion）碰巧相似就强行归入不相关项目。',
    '11. 表达极度克制，禁止补充套话，同时补齐派发边界：',
    '   - reason 最多 18 字，只写一句核心痛点或风险依据；标题已足够清晰时直接填 ""。',
    '   - doneCriteria（<=48字）：一句可观察的验收标准（做到什么算对）。',
    '   - nonGoals（最多2条）：明确不要碰哪些无关页面/模块或不要扩大的范围。',
    '   - antiPatterns（最多2条）：只放用户明确说过的否定约束（「不要 X」「不得 Y」「不可完全照抄」），禁止把正向功能要求塞进 antiPatterns。',
    '12. 跨日去重与否决黏性：若命中「当前未闭环待办」设 matchesExistingId；若与「近期已否决事项」同义则跳过。每条必须给出真实 anchorEntryIds。',
    '',
    '请只输出一个严格的 JSON 对象（不要加额外解释文字），Schema 如下：',
    '{',
    '  "ignoredNoiseCount": 0,',
    '  "todos": [',
    '    {',
    '      "matchesExistingId": null,',
    '      "title": "动词开头的简体中文标题（<=24字）",',
    '      "reason": "极简依据（<=18字，可为空串）",',
    '      "track": "engineering" | "life",',
    '      "actionKind": "implement" | "investigate" | "design" | "life",',
    '      "urgency": "high" | "medium" | "low",',
    '      "suggestedProjectName": "明确匹配的工作台项目名或 null",',
    '      "targetSurface": "归属页面/交互表面（如 时间日记页 JournalPage / 卡片，不确定填 未定（开工前先确认落点））或 null",',
    '      "repoHint": "可选模块/文件线索或 null",',
    '      "doneCriteria": "可验证完成标准（<=48字）或 null",',
    '      "nonGoals": ["明确不做/不碰的范围（最多2条）"],',
    '      "antiPatterns": ["用户明确否定的约束（最多2条）"],',
    '      "anchorEntryIds": ["je_xxx"],',
    '      "alreadyDone": false,',
    '      "suggestedDoneSha": null,',
    '      "suggestedDoneMessage": null',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

function matchProjectsMentionedInEntries(
  entries: PreparedEntry[],
  projects: WorkspaceProjectRef[],
): WorkspaceProjectRef[] {
  if (projects.length === 0) return []
  const corpus = entries
    .map((e) => `${e.entry.body} ${(e.entry.projectRefs || []).join(' ')} ${(e.entry.tags || []).join(' ')}`)
    .join('\n')
    .toLowerCase()

  return projects.filter((project) => {
    const tokens = extractProjectMatchTokens(project)
    return tokens.some((token) => corpus.includes(token))
  })
}

export function partitionEntriesIntoBatches<T extends { scrubbedBody: string }>(
  entries: T[],
  maxEntriesPerBatch = MAX_ENTRIES_PER_BATCH,
  maxBatchChars = MAX_BATCH_ENTRY_CHARS,
): T[][] {
  if (entries.length === 0) return []
  const maxCount = Math.max(1, Math.floor(maxEntriesPerBatch))
  const maxChars = Math.max(1, Math.floor(maxBatchChars))
  const batches: T[][] = []
  let current: T[] = []
  let currentChars = 0

  for (const item of entries) {
    const itemLen = item.scrubbedBody.length
    if (
      current.length > 0 &&
      (current.length >= maxCount || currentChars + itemLen > maxChars)
    ) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += itemLen
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

export async function runIntentTodoAnalysis(input: AnalyzerInput): Promise<AnalyzerOutput> {
  const startedAt = Date.now()
  const nowDate = input.now ?? new Date()
  const cutoverHour = input.cutoverHour ?? 4
  const logicalDate =
    input.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)
      ? input.targetDate
      : getShanghaiLogicalDay(nowDate, cutoverHour)

  // Single-day isolated read: only analyze the target date, never sweep historical days in bulk
  const dayRes = await input.journalStore.getDay(logicalDate)
  const allLoadedEntries: JournalEntry[] =
    dayRes.ok && Array.isArray(dayRes.entries) ? dayRes.entries : []

  let scannedEntries = 0
  let skippedPrivate = 0
  let suspectedAiPaste = 0
  const prepared: PreparedEntry[] = []
  const skippedHashes: string[] = []
  const skippedBodyHashes: string[] = []
  const seenHashesInBatch = new Set<string>()

  for (const entry of allLoadedEntries) {
    scannedEntries += 1
    const contentHash = computeJournalEntryContentHash(entry)
    const bodyHash = computeJournalEntryBodyHash(entry)

    // Hard privacy boundary FIRST — always count EVERY private entry on this day even across refreshes
    if (isPrivateJournalEntry(entry)) {
      skippedPrivate += 1
      // Only a user-authored private flag is recorded. An auto-applied private mark must not
      // burn the entry identity, otherwise un-marking it later could never bring it back.
      const userMarkedPrivate = entry.private === true && entry.autoApplied?.private !== true
      if (
        userMarkedPrivate &&
        !input.processedEntryHashes[contentHash] &&
        !seenHashesInBatch.has(contentHash)
      ) {
        seenHashesInBatch.add(contentHash)
        skippedHashes.push(contentHash)
      }
      continue
    }

    const alreadyProcessed =
      !input.forceReanalyze &&
      (Boolean(input.processedEntryHashes[contentHash]) ||
        Boolean(input.processedEntryBodies?.[bodyHash]))
    if (alreadyProcessed || seenHashesInBatch.has(contentHash)) {
      continue
    }
    seenHashesInBatch.add(contentHash)

    // Provenance separation: skip pure AI entries
    if (entry.kind === 'ai' || entry.provenance === 'ai' || entry.provenance === 'ai-verified') {
      skippedHashes.push(contentHash)
      skippedBodyHashes.push(bodyHash)
      continue
    }

    const bodyText = (entry.body || '').trim()
    if (!bodyText) {
      skippedHashes.push(contentHash)
      skippedBodyHashes.push(bodyHash)
      continue
    }

    const weakEvidence = entry.provenance === 'human-approved'
    const aiPaste = detectSuspectedAiPaste(entry.provenance, bodyText)
    if (aiPaste) suspectedAiPaste += 1

    prepared.push({
      entry,
      contentHash,
      bodyHash,
      scrubbedBody: truncateBody(scrubSecrets(bodyText), MAX_ENTRY_CHARS),
      weakEvidence,
      suspectedAiPaste: aiPaste,
    })
  }

  // Short-circuit: no new human entries to analyze (zero LLM tokens spent)
  if (prepared.length === 0) {
    return {
      ok: true,
      logicalDate,
      ranAt: nowDate.toISOString(),
      providerName: input.providerName,
      modelUsed: input.resolvedConfig.model || 'none',
      processedHashes: skippedHashes,
      processedBodyHashes: skippedBodyHashes,
      candidates: [],
      stats: {
        scannedEntries,
        newHumanEntries: 0,
        skippedPrivate,
        suspectedAiPaste: 0,
        ignoredNoiseCount: 0,
        durationMs: Date.now() - startedAt,
      },
    }
  }

  // Enforce daily total character budget (keep newest entries if extremely long)
  const budgetedEntries: PreparedEntry[] = []
  let totalChars = 0
  for (let i = prepared.length - 1; i >= 0; i--) {
    const item = prepared[i]
    if (totalChars + item.scrubbedBody.length > MAX_TOTAL_ENTRY_CHARS && budgetedEntries.length > 0) {
      break
    }
    budgetedEntries.unshift(item)
    totalChars += item.scrubbedBody.length
  }

  // Partition into chronological batches so dense engineering days never blow past
  // single-request token or latency limits, while small days run in a single call.
  const batches = partitionEntriesIntoBatches(
    budgetedEntries,
    input.maxEntriesPerBatch ?? MAX_ENTRIES_PER_BATCH,
    input.maxBatchChars ?? MAX_BATCH_ENTRY_CHARS,
  )

  const systemPrompt = buildSystemPrompt()
  const llmCaller = input.callLlm ?? callAnthropicMessages
  const gitSinceIso = getShanghaiCutoverIso(shiftDateString(logicalDate, -1), cutoverHour)
  const gitFetcher = input.gitLogFetcher ?? defaultFetchGitLog
  const gitCache = new Map<string, string[]>()

  // Reasoning/thinking models (e.g. MiniMax-M3.1-Flash, Claude thinking) count thinking_tokens
  // toward max_tokens; 4096 can be exhausted entirely inside thinking blocks with empty text.
  const requestOptions = {
    maxTokens: 16_384,
    temperature: 0.1,
    // M3.1 Flash defaults to max reasoning effort, which can exhaust the JSON output budget.
    effort: input.resolvedConfig.model?.trim().toLowerCase() === 'minimax-m3.1-flash'
      ? ('low' as const)
      : undefined,
  }
  const callOptions: AnthropicCallOptions = {
    stream: true,
    timeoutMs: INTENT_TODO_LLM_TIMEOUT_MS,
    idleTimeoutMs: INTENT_TODO_LLM_IDLE_TIMEOUT_MS,
  }

  const projectByLowerName = new Map(input.projects.map((p) => [p.name.toLowerCase(), p]))

  let rollingOpenItems = [...input.openItems]
  let rollingClosedItems = [...(input.closedItems ?? [])]

  const allProcessedHashes: string[] = []
  const allProcessedBodyHashes: string[] = []
  const allCandidates: CandidateIntentTodo[] = []
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalIgnoredNoiseCount = 0
  let lastModelUsed = input.resolvedConfig.model || 'none'

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batchStartedAt = Date.now()
    const batchEntries = batches[batchIndex]

    // Parallel git log + workspace mtime check ONLY on workspace projects mentioned in this batch (cached per project)
    const matchedProjects = matchProjectsMentionedInEntries(batchEntries, input.projects)
    const gitResults = await Promise.all(
      matchedProjects.map(async (project) => {
        if (!gitCache.has(project.id)) {
          gitCache.set(project.id, await gitFetcher(project, gitSinceIso))
        }
        return {
          project,
          commits: gitCache.get(project.id) ?? [],
        }
      }),
    )

    // Assemble user message for this batch
    const userSections: string[] = [
      batches.length > 1
        ? `当前分析日期：${logicalDate}（第 ${batchIndex + 1}/${batches.length} 批，按时间顺序）`
        : `当前分析日期：${logicalDate}`,
      '',
      '## 工作台可用项目',
      input.projects.length > 0
        ? input.projects.map((p) => `- ${p.name}`).join('\n')
        : '- （无已挂载项目）',
    ]

    const gitLines = gitResults
      .filter((r) => r.commits.length > 0)
      .map((r) => `### ${r.project.name}\n${r.commits.map((c) => `- ${c}`).join('\n')}`)
    if (gitLines.length > 0) {
      userSections.push(
        '',
        '## 相关仓库近期提交与工作区变更（含时间戳，用于因果核实与已闭环判定：命中请设 alreadyDone=true）',
        ...gitLines,
      )
    }

    if (rollingOpenItems.length > 0) {
      userSections.push(
        '',
        '## 当前未闭环待办（命中请填 matchesExistingId，不要重复新建）',
        ...rollingOpenItems.map((i) => `- id=${i.id} | [${i.track}] ${i.title} (${i.status})`),
      )
    }

    if (rollingClosedItems.length > 0) {
      userSections.push(
        '',
        '## 当日已闭环/已忽略事项（命中请直接跳过，或填 matchesExistingId，绝不可重复新建）',
        ...rollingClosedItems.map(
          (i) =>
            `- id=${i.id} | [${i.track}] ${i.title} (${i.status})${i.anchorEntryIds?.length ? ` | anchors=${i.anchorEntryIds.join(',')}` : ''}`,
        ),
      )
    }

    if (input.droppedFingerprints.length > 0) {
      userSections.push(
        '',
        '## 近期用户已否决事项（同义意图请跳过，不要重复推荐）',
        ...input.droppedFingerprints.slice(-30).map((f) => `- ${f.title}`),
      )
    }

    userSections.push('', '## 新增时间日记条目（已过滤私密并脱敏）')
    for (const item of batchEntries) {
      const flags = [
        item.entry.provenance,
        item.entry.category,
        ...(item.entry.projectRefs.length > 0 ? [`projectRefs:${item.entry.projectRefs.join(',')}`] : []),
        ...(item.entry.tags.length > 0 ? [`tags:${item.entry.tags.join(',')}`] : []),
        ...(item.weakEvidence ? ['弱证据'] : []),
        ...(item.suspectedAiPaste ? ['疑似含粘贴AI回复-仅取用户诉求'] : []),
      ]
      const tsPart = item.entry.ts ? ` | ts=${item.entry.ts}` : ''
      userSections.push(
        `### entryId=${item.entry.id} | ${item.entry.date} ${item.entry.time}${tsPart} | [${flags.join(' | ')}]`,
        item.scrubbedBody,
        '',
      )
    }

    const userMessage = userSections.join('\n')

    const formatBatchFailure = (
      kind: AnthropicMessagesErrorKind | 'parse_error',
      rawMessage: string,
    ): AnalyzerOutput => {
      if (batchIndex > 0) {
        return {
          ok: false,
          kind,
          message: `已完成 ${batchIndex}/${batches.length} 批，剩余批次失败：${rawMessage}（点击重试将从断点继续）`,
          completedBatches: batchIndex,
          totalBatches: batches.length,
        }
      }
      return {
        ok: false,
        kind,
        message: rawMessage,
        completedBatches: 0,
        totalBatches: batches.length,
      }
    }

    const firstRes = await llmCaller(
      input.resolvedConfig,
      {
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        ...requestOptions,
      },
      callOptions,
    )

    if (!firstRes.ok) {
      return formatBatchFailure(firstRes.kind, firstRes.message)
    }

    let parsed = validateAndParseModelJson(firstRes.text)
    let batchInputTokens = firstRes.usage?.inputTokens ?? 0
    let batchOutputTokens = firstRes.usage?.outputTokens ?? 0
    let batchModelUsed = firstRes.model

    // Up to 1 repair retry if schema validation failed
    if (!parsed.ok) {
      console.warn('[IntentTodoAnalyzer] first pass JSON parse failed', {
        batchIndex,
        totalBatches: batches.length,
        model: firstRes.model,
        stopReason: firstRes.stopReason,
        textLen: firstRes.text.length,
        usage: firstRes.usage,
        error: parsed.error,
      })

      const retryMessages: Array<{ role: 'user' | 'assistant'; content: string }> = firstRes.text.trim()
        ? [
            { role: 'user', content: userMessage },
            { role: 'assistant', content: firstRes.text },
            {
              role: 'user',
              content: `你上一次的 JSON 输出校验失败：${parsed.error}\n请简短思考后直接输出一个完整合法的 JSON 对象，不要包含任何解释文字。`,
            },
          ]
        : [
            {
              role: 'user',
              content: `${userMessage}\n\n（注意：请保持内部思考简短，务必直接输出完整合法的 JSON 对象，不要在思考阶段耗尽输出额度。）`,
            },
          ]

      const repairRes = await llmCaller(
        input.resolvedConfig,
        {
          system: systemPrompt,
          messages: retryMessages,
          ...requestOptions,
        },
        callOptions,
      )

      if (!repairRes.ok) {
        return formatBatchFailure(repairRes.kind, repairRes.message)
      }

      batchInputTokens += repairRes.usage?.inputTokens ?? 0
      batchOutputTokens += repairRes.usage?.outputTokens ?? 0
      batchModelUsed = repairRes.model
      parsed = validateAndParseModelJson(repairRes.text)
      if (!parsed.ok) {
        console.warn('[IntentTodoAnalyzer] retry JSON parse failed', {
          batchIndex,
          totalBatches: batches.length,
          model: repairRes.model,
          stopReason: repairRes.stopReason,
          textLen: repairRes.text.length,
          usage: repairRes.usage,
          error: parsed.error,
        })
        const detail =
          repairRes.stopReason === 'max_tokens'
            ? '模型思考或输出达到 max_tokens 上限，未产出完整 JSON。'
            : parsed.error
        return formatBatchFailure('parse_error', `模型返回格式无法解析（已重试 1 次）：${detail}`)
      }
    }

    // Map validated raw todos onto concrete PreparedEntry anchors and workspace projects
    const entryById = new Map(batchEntries.map((item) => [item.entry.id, item]))
    const knownIdSet = new Set([
      ...rollingOpenItems.map((i) => i.id),
      ...rollingClosedItems.map((i) => i.id),
    ])

    const batchCandidates: CandidateIntentTodo[] = []
    for (const row of parsed.payload.todos) {
      const rawIds = Array.isArray(row.anchorEntryIds) ? row.anchorEntryIds : []
      const anchors: IntentTodoAnchor[] = []
      const explicitProjectRefs = new Set<string>()

      for (const rawId of rawIds) {
        const matched = entryById.get(String(rawId))
        if (!matched) continue
        anchors.push({
          date: matched.entry.date,
          time: matched.entry.time,
          entryId: matched.entry.id,
          contentHash: matched.contentHash,
          flags: buildAnchorFlags(matched),
        })
        // Only user-authored refs count as an explicit project binding. A ref the
        // auto-tagger inferred must not be promoted into a hard binding.
        const autoRefs = new Set(
          (matched.entry.autoApplied?.projectRefs || []).map((r) => String(r || '').toLowerCase()),
        )
        for (const ref of matched.entry.projectRefs || []) {
          const key = String(ref || '').toLowerCase()
          if (!key || autoRefs.has(key)) continue
          explicitProjectRefs.add(key)
        }
      }

      // Fallback to first entry in this batch if model invented an unknown id
      if (anchors.length === 0) {
        const fallback = batchEntries[0]
        anchors.push({
          date: fallback.entry.date,
          time: fallback.entry.time,
          entryId: fallback.entry.id,
          contentHash: fallback.contentHash,
          flags: buildAnchorFlags(fallback),
        })
      }

      const track: IntentTodoTrack = row.track === 'engineering' ? 'engineering' : 'life'
      const urgency: IntentTodoUrgency =
        row.urgency === 'high' || row.urgency === 'medium' || row.urgency === 'low'
          ? row.urgency
          : 'medium'

      let suggestedProject: WorkspaceProjectRef | undefined
      let projectExplicitlyBound = false
      if (track === 'engineering') {
        // Prefer explicit @projectRef from the cited journal entries
        for (const ref of explicitProjectRefs) {
          const hit = projectByLowerName.get(ref)
          if (hit) {
            suggestedProject = hit
            projectExplicitlyBound = true
            break
          }
        }
        if (!suggestedProject && typeof row.suggestedProjectName === 'string' && row.suggestedProjectName.trim()) {
          const key = row.suggestedProjectName.trim().toLowerCase()
          suggestedProject =
            projectByLowerName.get(key) ??
            input.projects.find((p) => extractProjectMatchTokens(p).some((tok) => tok === key))
        }
      }

      const matchesExistingId =
        typeof row.matchesExistingId === 'string' && knownIdSet.has(row.matchesExistingId)
          ? row.matchesExistingId
          : null

      const titleRaw = String(row.title || '').replace(/\s+/g, ' ').trim()
      const title =
        titleRaw.length <= INTENT_TODO_TITLE_MAX_LEN
          ? titleRaw
          : `${titleRaw.slice(0, INTENT_TODO_TITLE_MAX_LEN - 1)}…`

      const shaRaw = typeof row.suggestedDoneSha === 'string' && row.suggestedDoneSha.trim()
        ? row.suggestedDoneSha.trim().slice(0, 12)
        : null
      const shaMsg = typeof row.suggestedDoneMessage === 'string' ? row.suggestedDoneMessage.trim().slice(0, 60) : ''
      const isAlreadyDone = row.alreadyDone === true || Boolean(shaRaw)
      const doneSha = shaRaw ?? (isAlreadyDone ? 'verified' : null)

      const reasonRaw = typeof row.reason === 'string' ? row.reason.replace(/\s+/g, ' ').trim() : ''
      const reason = reasonRaw.length <= 36 ? reasonRaw : `${reasonRaw.slice(0, 35)}…`

      const validActionKinds: readonly IntentTodoActionKind[] = ['implement', 'investigate', 'design', 'life']
      const actionKind: IntentTodoActionKind =
        typeof row.actionKind === 'string' && validActionKinds.includes(row.actionKind as IntentTodoActionKind)
          ? (row.actionKind as IntentTodoActionKind)
          : track === 'life'
            ? 'life'
            : 'implement'

      const targetSurface =
        typeof row.targetSurface === 'string' && row.targetSurface.trim()
          ? row.targetSurface.replace(/\s+/g, ' ').trim().slice(0, 64)
          : null
      const doneCriteria =
        typeof row.doneCriteria === 'string' && row.doneCriteria.trim()
          ? row.doneCriteria.replace(/\s+/g, ' ').trim().slice(0, 64)
          : null
      const nonGoals = Array.isArray(row.nonGoals)
        ? row.nonGoals
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 48))
            .slice(0, 2)
        : []

      batchCandidates.push({
        matchesExistingId,
        title,
        reason,
        track,
        actionKind,
        urgency,
        suggestedProjectId: suggestedProject?.id ?? null,
        suggestedProjectName: suggestedProject?.name ?? null,
        projectExplicitlyBound,
        targetSurface,
        repoHint: typeof row.repoHint === 'string' && row.repoHint.trim() ? row.repoHint.trim().slice(0, 80) : null,
        doneCriteria,
        nonGoals,
        antiPatterns: Array.isArray(row.antiPatterns)
          ? row.antiPatterns
              .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
              .map((x) => x.trim().slice(0, 48))
              .slice(0, 2)
          : [],
        anchors,
        suggestedDone: doneSha ? { sha: doneSha, message: shaMsg, projectName: suggestedProject?.name } : null,
      })
    }

    const batchProcessedHashes = [
      ...(batchIndex === 0 ? skippedHashes : []),
      ...batchEntries.map((item) => item.contentHash),
    ]
    const batchProcessedBodyHashes = [
      ...(batchIndex === 0 ? skippedBodyHashes : []),
      ...batchEntries.map((item) => item.bodyHash),
    ]
    const batchSuspectedAiPaste = batchEntries.filter((item) => item.suspectedAiPaste).length

    allProcessedHashes.push(...batchProcessedHashes)
    allProcessedBodyHashes.push(...batchProcessedBodyHashes)
    allCandidates.push(...batchCandidates)
    totalInputTokens += batchInputTokens
    totalOutputTokens += batchOutputTokens
    totalIgnoredNoiseCount += parsed.payload.ignoredNoiseCount
    lastModelUsed = batchModelUsed

    // Per-batch checkpoint commit + rolling context refresh
    if (input.onBatchComplete) {
      const ctxUpdate = await input.onBatchComplete({
        batchIndex,
        totalBatches: batches.length,
        logicalDate,
        ranAt: nowDate.toISOString(),
        providerName: input.providerName,
        modelUsed: batchModelUsed,
        processedHashes: batchProcessedHashes,
        processedBodyHashes: batchProcessedBodyHashes,
        candidates: batchCandidates,
        stats: {
          scannedEntries,
          newHumanEntries: batchEntries.length,
          skippedPrivate,
          suspectedAiPaste: batchSuspectedAiPaste,
          ignoredNoiseCount: parsed.payload.ignoredNoiseCount,
          durationMs: Date.now() - batchStartedAt,
          inputTokens: batchInputTokens || undefined,
          outputTokens: batchOutputTokens || undefined,
        },
      })
      if (ctxUpdate?.openItems) {
        rollingOpenItems = [...ctxUpdate.openItems]
      }
      if (ctxUpdate?.closedItems) {
        rollingClosedItems = [...ctxUpdate.closedItems]
      }
    } else if (batchIndex < batches.length - 1) {
      // In-memory rolling context when called without a store checkpoint callback
      for (const cand of batchCandidates) {
        if (cand.matchesExistingId) continue
        const syntheticId = `batch_${batchIndex}_${rollingOpenItems.length + rollingClosedItems.length}`
        if (cand.suggestedDone) {
          rollingClosedItems.push({
            id: syntheticId,
            title: cand.title,
            track: cand.track,
            status: 'done',
            anchorEntryIds: cand.anchors.map((a) => a.entryId),
          })
        } else {
          rollingOpenItems.push({
            id: syntheticId,
            title: cand.title,
            track: cand.track,
            status: 'pending',
          })
        }
      }
    }
  }

  return {
    ok: true,
    logicalDate,
    ranAt: nowDate.toISOString(),
    providerName: input.providerName,
    modelUsed: lastModelUsed,
    processedHashes: allProcessedHashes,
    processedBodyHashes: allProcessedBodyHashes,
    candidates: allCandidates,
    stats: {
      scannedEntries,
      newHumanEntries: budgetedEntries.length,
      skippedPrivate,
      suspectedAiPaste,
      ignoredNoiseCount: totalIgnoredNoiseCount,
      durationMs: Date.now() - startedAt,
      inputTokens: totalInputTokens || undefined,
      outputTokens: totalOutputTokens || undefined,
    },
  }
}
