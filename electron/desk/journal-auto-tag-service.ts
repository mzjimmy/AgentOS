/**
 * SentinelDesk Journal Auto-Tagger (v2):
 * Strict two-step pipeline triggered automatically on journal entry creation/update
 * (including Feishu bridge messages) or on demand from the Time Journal page:
 *
 * Step 1 — Privacy FIRST (Deterministic PII/address gate + Model check):
 *   - Runs `<1ms` local deterministic check for personal street addresses, phone numbers,
 *     ID numbers, or credentials. If matched, marks `private: true` immediately with ZERO
 *     external network calls and skips project attribution.
 *   - Otherwise checks private personal life (family, relationships, health/medical,
 *     personal finance/loans, emotional privacy) via the configured engine.
 *   - If private -> marks `private: true` and short-circuits project attribution.
 *
 * Step 2 — Auto Category + Auto Project Attribution + Concise Semantic Tags:
 *   - Only runs for non-private entries (or basic non-engineering category for private).
 *   - Classifies `未归类` -> `工程 / 生活 / 事务 / 学习 / 身体 / 工作`.
 *   - Matches across ALL workspace projects (up to 24, with rich domain hints).
 *   - Adds concise semantic tags (e.g. `开发履历` for AI prompt logs).
 *
 * Engine modes:
 * - `local` (default): LAN/local LM Studio (`cloudflare_clef-flash`) ONLY — zero cloud egress.
 * - `jev`: TypeSafe System One (`jev-1.13.0`, ~500ms parallel multi-question) — explicit opt-in.
 * - `auto`: LAN local first, falls back to TypeSafe JEV when local is unreachable.
 *
 * User intent always wins: manual private/category/project/tag edits are never overwritten,
 * and an AI private mark cleared by the user is never re-applied.
 */

import path from 'node:path'
import {
  JOURNAL_CATEGORIES,
  type JournalCategory,
  type JournalEntry,
  type UpdateJournalEntryInput,
} from '../../src/journal-contract'
import {
  JOURNAL_AUTO_TAG_CONCURRENCY,
  JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL,
  JOURNAL_AUTO_TAG_MAX_BODY_CHARS,
  JOURNAL_AUTO_TAG_MAX_ENTRIES_PER_RUN,
  JOURNAL_AUTO_TAG_PIPELINE_VERSION,
  type JournalAutoTagChangedEvent,
  type JournalAutoTagConfig,
  type JournalAutoTagDecision,
  type JournalAutoTagRunResult,
  type JournalAutoTagRunStatus,
  type JournalAutoTagRunSummary,
  type JournalAutoTagStatus,
} from '../../src/journal-auto-tag-contract'
import {
  computeJournalEntryBodyHash,
  isPrivateJournalEntry,
  scrubSecrets,
} from './journal-privacy'
import { JournalAutoTagStore } from './journal-auto-tag-store'
import { getShanghaiDateString } from './intent-todo-time'
import {
  decideLocalEnum,
  decideLocalJson,
  normalizeBaseUrl,
  probeLocalModelReady,
  type LocalFetchFn,
} from './local-decision-client'
import {
  decideJournalAutoTagWithJev,
  hasJevApiKeyConfigured,
  type JevProjectCandidate,
} from './jev-journal-tagger'
import { extractProjectMatchTokens } from './project-match-tokens'

export type JournalAutoTagWorkspaceProject = {
  id: string
  name: string
  path: string
}

export type JournalAutoTagJournalStore = {
  getDay(date: string): Promise<
    { ok: true; entries: JournalEntry[] } | { ok: false; error: string }
  >
  updateEntry(
    date: string,
    entryId: string,
    patch: UpdateJournalEntryInput,
  ): Promise<{ ok: true; entry: JournalEntry } | { ok: false; error: string }>
}

export type JournalAutoTagServiceOptions = {
  userDataPath: string
  journalStore: JournalAutoTagJournalStore
  getWorkspaceState: () => { projects: JournalAutoTagWorkspaceProject[] }
  fetchFn?: LocalFetchFn
  jevApiKey?: string | null
  now?: () => Date
  onChanged?: (event: JournalAutoTagChangedEvent) => void
}

type ProjectCandidate = JevProjectCandidate & {
  path: string
  aliases: string[]
}

const NO_PROJECT = 'none'
const PROJECT_CANDIDATE_LIMIT = 24

const ASSIGNABLE_CATEGORIES: readonly JournalCategory[] = [
  '工程',
  '生活',
  '事务',
  '学习',
  '身体',
  '工作',
  '未归类',
]

// Fast, zero-egress deterministic detector for explicit personal addresses, mobile numbers, IDs
const CN_MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const CN_ADDRESS_RE =
  /(?:北京|上海|广州|深圳|杭州|南京|成都|武汉|重庆|西安|苏州|天津|[\u4e00-\u9fa5]{1,4}(?:省|市|区|县))[\u4e00-\u9fa5]{1,10}(?:路|街|巷|道|大道|弄|村|小区|花园|公馆|大厦)\s*\d+号?/
const CN_ID_CARD_RE = /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/

export function detectDeterministicPrivateInfo(body: string): { isPrivate: boolean; categoryHint: JournalCategory | null } {
  const text = String(body || '')
  if (!text.trim()) return { isPrivate: false, categoryHint: null }
  if (CN_MOBILE_RE.test(text) || CN_ADDRESS_RE.test(text) || CN_ID_CARD_RE.test(text)) {
    const isMedical = /体检|医院|复查|就诊|挂号|门诊|病历|化验|医生/.test(text)
    return { isPrivate: true, categoryHint: isMedical ? '身体' : '生活' }
  }
  return { isPrivate: false, categoryHint: null }
}

const LOCAL_PRIVACY_QUESTION = [
  '第一步：请判断这条时间日记是否包含隐私或私人生活内容：',
  '- private：包含私人家庭/感情/人际冲突、个人健康就医、财务贷款压力、情绪脆弱隐私，或个人住址/手机号/证件/账号密码等敏感信息；',
  '- public：普通软件工程反馈、工具使用想法、公开文章收集、或常规事务（如修车/打气/买日用品）。',
  '只输出 private 或 public。',
].join('\n')

function buildProjectHint(project: JournalAutoTagWorkspaceProject, aliases: string[]): string {
  // Match ONLY against the project's own name & folder basename, never parent directories like /Users/.../AgentOS/...
  const ownName = `${project.name} ${path.basename(project.path || '')}`.toLowerCase()
  const extraHints: string[] = []
  if (ownName.includes('sentinellab')) {
    extraHints.push('旧版 SentinelLab 软件、历史日记同步')
  } else if (ownName.includes('wechat-article-spider')) {
    extraHints.push('微信公众号文章爬虫、抓取公众号正文')
  } else if (ownName.includes('wechat-channels-video') || ownName.includes('video')) {
    extraHints.push('视频号、短视频剪辑处理')
  } else if (ownName.includes('newsagent')) {
    extraHints.push('新闻聚合、Notion飞书资讯')
  } else if (ownName.includes('jevquant') || ownName.includes('quant')) {
    extraHints.push('量化交易策略与回测')
  } else if (ownName.includes('agentos')) {
    extraHints.push('AgentOS桌面端、时间日记、意图待办、派发对话、工作台、侧边栏、权限弹窗、对话框滚动')
  }
  const aliasText = aliases.length > 0 ? `别名：${aliases.join('、')}` : ''
  const extraText = extraHints.length > 0 ? `特征：${extraHints.join('；')}` : ''
  const detail = [aliasText, extraText].filter(Boolean).join('；')
  return detail ? `${project.name}（${detail}）` : project.name
}

function buildLocalStep2Question(candidates: readonly ProjectCandidate[]): string {
  const projLines = candidates.map((c) => `- ${c.code}: ${c.hint}`)
  return [
    '第二步：请为这条非私密时间日记完成三项分类，严格按 JSON Schema 返回：',
    '1. category（从以下选最匹配的一项）：',
    '   - 工程：软件开发、UI/交互缺陷、AI提示词、项目需求、技术方案',
    '   - 生活：日常个人生活、出行、修车打气、购物、随感',
    '   - 事务：日程安排、杂务办理、沟通协调',
    '   - 学习：读书、学外语、课程、技能练习',
    '   - 身体：运动、睡眠、饮食、健康与身体状态',
    '   - 工作：非编程类办公、会议、业务协作',
    '   - 未归类：实在无法归类时选此项',
    '2. projectCode（若明确属于以下某个工作台项目则选对应编号，否则选 none）：',
    ...(projLines.length > 0 ? projLines : ['- none: 无工作台项目']),
    '3. entryKind：',
    '   - actionable：普通未执行的想法、痛点、需求或待办',
    '   - prompt_log：直接写给 AI 助手执行的排查/修复提示词（常见特征：编号1/2/3/4要求AI改代码或带@项目）',
    '   - status_note：纯状态/打卡/随感',
  ].join('\n')
}

function isAutoTagCandidate(entry: JournalEntry): boolean {
  if (!entry || !String(entry.body || '').trim()) return false
  if (entry.kind === 'ai') return false
  if (entry.provenance === 'ai' || entry.provenance === 'ai-verified') return false
  // Never send an entry already marked private to any model.
  if (isPrivateJournalEntry(entry)) return false
  return true
}

/**
 * Computes the minimal patch to write back for one decision, strictly honoring user edits:
 * - User-authored private marks are never cleared; AI private marks cleared by user never return.
 * - User-authored categories (non-未归类 without autoApplied.category) are never overwritten.
 * - User-authored projectRefs are never overwritten, and private entries never get projectRefs.
 * - User-authored tags are preserved; concise AI tags are merged without duplicates.
 */
export function planAutoTagUpdate(
  entry: JournalEntry,
  decision: JournalAutoTagDecision,
): UpdateJournalEntryInput | null {
  const patch: UpdateJournalEntryInput = {}
  const currentAuto = entry.autoApplied ?? {}
  const nextAuto: NonNullable<JournalEntry['autoApplied']> = { ...currentAuto }

  // 1. Privacy mark (one-way; user clearing an AI private mark is sticky)
  const userMarkedPrivate = entry.private === true && currentAuto.private !== true
  const userClearedAiMark = currentAuto.private === true && entry.private !== true
  const effectivePrivate =
    entry.private === true || (decision.private && !userClearedAiMark)

  if (decision.private && !userMarkedPrivate && !userClearedAiMark && entry.private !== true) {
    patch.private = true
    nextAuto.private = true
  }

  // 2. Category (only upgrade 未归类 or previously AI-applied category)
  const canUpdateCategory = entry.category === '未归类' || currentAuto.category === true
  if (
    decision.category &&
    decision.category !== '未归类' &&
    canUpdateCategory &&
    entry.category !== decision.category
  ) {
    patch.category = decision.category
    nextAuto.category = true
  }

  // 3. Project refs (skip entirely when entry is private; never override user refs)
  const autoRefs = currentAuto.projectRefs ?? []
  const userRefs = (entry.projectRefs ?? []).filter((ref) => !autoRefs.includes(ref))
  if (!effectivePrivate && decision.projectName && userRefs.length === 0) {
    const currentRefs = entry.projectRefs ?? []
    if (!currentRefs.includes(decision.projectName)) {
      patch.projectRefs = [...currentRefs, decision.projectName]
      nextAuto.projectRefs = Array.from(new Set([...autoRefs, decision.projectName]))
    }
  }

  // 4. Concise semantic tags (skip for private entries; merge without clobbering user tags)
  if (!effectivePrivate && Array.isArray(decision.tags) && decision.tags.length > 0) {
    const currentTags = entry.tags ?? []
    const added = decision.tags.filter((tag) => tag && !currentTags.includes(tag))
    if (added.length > 0) {
      patch.tags = [...currentTags, ...added]
      nextAuto.tags = Array.from(new Set([...(currentAuto.tags ?? []), ...added]))
    }
  }

  const hasChange =
    patch.private !== undefined ||
    patch.category !== undefined ||
    patch.projectRefs !== undefined ||
    patch.tags !== undefined
  if (!hasChange) return null

  nextAuto.decidedAt = decision.decidedAt
  nextAuto.pipeline = decision.pipeline
  patch.autoApplied = nextAuto
  return patch
}

export class JournalAutoTagService {
  private readonly store: JournalAutoTagStore
  private readonly options: JournalAutoTagServiceOptions

  constructor(options: JournalAutoTagServiceOptions) {
    this.options = options
    this.store = new JournalAutoTagStore({ userDataPath: options.userDataPath })
  }

  getStatus(): JournalAutoTagStatus {
    const state = this.store.readState()
    return {
      config: state.config,
      lastRun: state.lastRun,
      lastRunByDate: state.lastRunByDate,
    }
  }

  saveConfig(patch: Partial<JournalAutoTagConfig>): JournalAutoTagConfig {
    const config = this.store.saveConfig(patch)
    this.emitChanged({ reason: 'config-changed', dates: [], timestamp: Date.now() })
    return config
  }

  private emitChanged(event: JournalAutoTagChangedEvent): void {
    try {
      this.options.onChanged?.(event)
    } catch (err) {
      console.error('[JournalAutoTagService] onChanged error:', err)
    }
  }

  private today(): string {
    return getShanghaiDateString(this.options.now?.() ?? new Date())
  }

  private buildCandidates(): ProjectCandidate[] {
    const projects = this.options.getWorkspaceState()?.projects ?? []
    return projects.slice(0, PROJECT_CANDIDATE_LIMIT).map((project, index) => {
      const aliases = extractProjectMatchTokens(project)
      return {
        code: `C${index + 1}`,
        name: project.name,
        path: project.path,
        aliases,
        hint: buildProjectHint(project, aliases),
      }
    })
  }

  /**
   * Runs one auto-tagging pass over a calendar day.
   * Never throws: unreachable local model skips silently when engine is `local`.
   */
  async runAutoTag(options: { date?: string; force?: boolean } = {}): Promise<JournalAutoTagRunResult> {
    const date = options.date || this.today()
    const config = this.store.getConfig()

    if (!config.enabled) {
      const summary = this.finish(date, {
        status: 'disabled',
        ranAt: this.nowIso(),
        endpoint: null,
        scanned: 0,
        decided: 0,
        changed: 0,
        skipped: 0,
        message: 'auto-tagging is disabled',
      })
      return this.toResult(date, summary)
    }

    const baseUrl = normalizeBaseUrl(config.localBaseUrl, JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL)
    const model = config.localModel
    const runtime = { fetchFn: this.options.fetchFn }

    const dayRes = await this.options.journalStore.getDay(date)
    if (!dayRes.ok) {
      const summary = this.finish(date, {
        status: 'failed',
        ranAt: this.nowIso(),
        endpoint: baseUrl,
        scanned: 0,
        decided: 0,
        changed: 0,
        skipped: 0,
        message: dayRes.error,
      })
      return this.toResult(date, summary)
    }

    const allEntries = dayRes.entries ?? []
    const candidates = allEntries.filter(isAutoTagCandidate)
    const batch = candidates.slice(0, JOURNAL_AUTO_TAG_MAX_ENTRIES_PER_RUN)
    const skipped = allEntries.length - batch.length
    const projectCandidates = this.buildCandidates()

    const needsModel = options.force
      ? batch.length > 0
      : batch.some((entry) => {
          if (this.store.getDecision(computeJournalEntryBodyHash(entry))) return false
          return !detectDeterministicPrivateInfo(entry.body || '').isPrivate
        })

    // Resolve active backend according to explicit engine setting
    let activeEngine: 'local' | 'jev' = config.engine === 'jev' ? 'jev' : 'local'
    let endpointLabel = activeEngine === 'jev' ? 'https://api.typesafe.ai/v1/systemone' : baseUrl

    if (needsModel) {
      if (config.engine === 'local' || config.engine === 'auto') {
        const localReady = await probeLocalModelReady(baseUrl, model, runtime)
        if (localReady) {
          activeEngine = 'local'
          endpointLabel = baseUrl
        } else if (config.engine === 'auto' && hasJevApiKeyConfigured(this.options.jevApiKey)) {
          activeEngine = 'jev'
          endpointLabel = 'https://api.typesafe.ai/v1/systemone'
        } else {
          const summary = this.finish(date, {
            status: 'local_unreachable',
            ranAt: this.nowIso(),
            endpoint: baseUrl,
            scanned: 0,
            decided: 0,
            changed: 0,
            skipped: 0,
            message: 'local model unreachable — skipped, never fell back to the cloud',
          })
          return this.toResult(date, summary)
        }
      } else if (config.engine === 'jev') {
        if (!hasJevApiKeyConfigured(this.options.jevApiKey)) {
          const summary = this.finish(date, {
            status: 'failed',
            ranAt: this.nowIso(),
            endpoint: endpointLabel,
            scanned: 0,
            decided: 0,
            changed: 0,
            skipped: 0,
            message: '未检测到 JEV_API_KEY（请检查环境变量或 ~/.jev-router.env）',
          })
          return this.toResult(date, summary)
        }
      }
    }

    let decided = 0
    let changed = 0

    await this.mapConcurrent(batch, JOURNAL_AUTO_TAG_CONCURRENCY, async (entry) => {
      const bodyHash = computeJournalEntryBodyHash(entry)
      const cached = options.force ? null : this.store.getDecision(bodyHash)
      const decision =
        cached ??
        (await this.decideEntry(entry, projectCandidates, activeEngine, baseUrl, model, runtime))

      if (!decision) return
      decided += 1
      if (!cached) this.store.putDecision(bodyHash, decision)

      const patch = planAutoTagUpdate(entry, decision)
      if (!patch) return

      const res = await this.options.journalStore.updateEntry(date, entry.id, patch)
      if (res.ok) changed += 1
    })

    const summary = this.finish(date, {
      status: 'completed',
      ranAt: this.nowIso(),
      endpoint: endpointLabel,
      scanned: batch.length,
      decided,
      changed,
      skipped,
    })
    this.emitChanged({ reason: 'ran', dates: [date], timestamp: Date.now() })
    return this.toResult(date, summary)
  }

  /**
   * Privacy-FIRST two-step decision for one entry.
   */
  private async decideEntry(
    entry: JournalEntry,
    projectCandidates: ProjectCandidate[],
    activeEngine: 'local' | 'jev',
    baseUrl: string,
    model: string,
    runtime: { fetchFn?: LocalFetchFn },
  ): Promise<JournalAutoTagDecision | null> {
    const rawBody = entry.body || ''

    // Step 1a: Instant zero-egress deterministic check for explicit addresses / mobile phones / IDs
    const detPriv = detectDeterministicPrivateInfo(rawBody)
    if (detPriv.isPrivate) {
      return {
        private: true,
        category: detPriv.categoryHint,
        projectName: null,
        tags: [],
        decidedAt: this.nowIso(),
        pipeline: JOURNAL_AUTO_TAG_PIPELINE_VERSION,
        engine: 'local:deterministic',
      }
    }

    // Engine = TypeSafe JEV (explicit user opt-in: ~500ms single parallel System One call)
    if (activeEngine === 'jev') {
      return decideJournalAutoTagWithJev(rawBody, projectCandidates, {
        fetchFn: runtime.fetchFn,
        jevApiKey: this.options.jevApiKey,
        nowIso: () => this.nowIso(),
      })
    }

    // Engine = Local LAN LM Studio (Step 1 privacy -> Step 2 single JSON call for category + project + kind)
    const body = scrubSecrets(rawBody).slice(0, JOURNAL_AUTO_TAG_MAX_BODY_CHARS)
    const stateText = `时间日记正文：\n${body}`

    const privacyPick = await decideLocalEnum(
      baseUrl,
      model,
      stateText,
      LOCAL_PRIVACY_QUESTION,
      ['private', 'public'] as const,
      runtime,
    )
    if (privacyPick === null) return null

    if (privacyPick === 'private') {
      const isMedical = /体检|医院|复查|就诊|生病|失眠|痛|药/.test(rawBody)
      return {
        private: true,
        category: isMedical ? '身体' : '生活',
        projectName: null,
        tags: [],
        decidedAt: this.nowIso(),
        pipeline: JOURNAL_AUTO_TAG_PIPELINE_VERSION,
        engine: `local:${model}`,
      }
    }

    const projectCodes = [...projectCandidates.map((c) => c.code), NO_PROJECT]
    const step2Schema = {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'projectCode', 'entryKind'],
      properties: {
        category: { type: 'string', enum: [...ASSIGNABLE_CATEGORIES] },
        projectCode: { type: 'string', enum: projectCodes },
        entryKind: { type: 'string', enum: ['actionable', 'prompt_log', 'status_note'] },
      },
    }

    const step2 = await decideLocalJson<{
      category?: unknown
      projectCode?: unknown
      entryKind?: unknown
    }>(
      baseUrl,
      model,
      stateText,
      buildLocalStep2Question(projectCandidates),
      'journal_auto_tag_step2',
      step2Schema,
      runtime,
    )
    if (!step2) return null

    const rawCategory = typeof step2.category === 'string' ? step2.category : '未归类'
    const category: JournalCategory | null =
      rawCategory !== '未归类' && (JOURNAL_CATEGORIES as readonly string[]).includes(rawCategory)
        ? (rawCategory as JournalCategory)
        : null

    let projectName: string | null = null
    if (typeof step2.projectCode === 'string' && step2.projectCode !== NO_PROJECT) {
      const matched = projectCandidates.find((c) => c.code === step2.projectCode)
      if (matched) projectName = matched.name
    }

    const tags: string[] = step2.entryKind === 'prompt_log' ? ['开发履历'] : []

    return {
      private: false,
      category,
      projectName,
      tags,
      decidedAt: this.nowIso(),
      pipeline: JOURNAL_AUTO_TAG_PIPELINE_VERSION,
      engine: `local:${model}`,
    }
  }

  private async mapConcurrent<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++
        await worker(items[idx])
      }
    })
    await Promise.all(runners)
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private finish(date: string, summary: JournalAutoTagRunSummary): JournalAutoTagRunSummary {
    this.store.recordRun(date, summary)
    return summary
  }

  private toResult(date: string, summary: JournalAutoTagRunSummary): JournalAutoTagRunResult {
    const status: JournalAutoTagRunStatus = summary.status
    return {
      ok: status === 'completed' || status === 'disabled' || status === 'local_unreachable',
      status,
      date,
      endpoint: summary.endpoint,
      scanned: summary.scanned,
      decided: summary.decided,
      changed: summary.changed,
      skipped: summary.skipped,
      ...(summary.message ? { message: summary.message } : {}),
    }
  }
}
