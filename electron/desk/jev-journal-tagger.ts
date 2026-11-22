/**
 * TypeSafe AI System One (JEV `jev-1.13.0`) Journal Auto-Tagger.
 *
 * Only invoked when the user explicitly opts into `engine: 'jev'` (or `'auto'` fallback
 * when LAN LM Studio is unavailable). Never invoked when `engine: 'local'` (the default).
 *
 * Runs all 4 structured judgments in a single ~500ms parallel System One call:
 * 1. `is_private` (noul) — private personal life (family, health, finance, relationships) or address/contact PII
 * 2. `category` (choice) — 工程 / 生活 / 事务 / 学习 / 身体 / 工作 / 未归类
 * 3. `project` (choice) — matched workspace project (or `none`)
 * 4. `entry_kind` (choice) — actionable / prompt_log / status_note
 *
 * Privacy discipline:
 * - Already-private entries and deterministic PII/address entries are intercepted locally
 *   BEFORE this client is ever called.
 * - Credentials/tokens are scrubbed via `scrubSecrets` prior to egress.
 */

import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  JOURNAL_CATEGORIES,
  type JournalCategory,
} from '../../src/journal-contract'
import {
  JOURNAL_AUTO_TAG_MAX_BODY_CHARS,
  JOURNAL_AUTO_TAG_PIPELINE_VERSION,
  type JournalAutoTagDecision,
} from '../../src/journal-auto-tag-contract'
import { fetchWithTimeout, resolveFetch, type LocalFetchFn } from './local-decision-client'
import { scrubSecrets } from './journal-privacy'

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1'
export const DEFAULT_JEV_MODEL = 'jev-1.13.0'

export function loadJevApiKey(): string | null {
  for (const name of ['JEV_API_KEY', 'TYPESAFE_API_KEY'] as const) {
    const val = (process.env[name] ?? '').trim()
    if (val) return val
  }
  const envFile = (process.env.JEV_ENV_FILE ?? '').trim() || path.join(os.homedir(), '.jev-router.env')
  if (!existsSync(envFile)) return null
  try {
    const lines = readFileSync(envFile, 'utf8').split(/\r?\n/)
    for (const raw of lines) {
      const line = raw.trim().replace(/^export\s+/, '')
      if (line.startsWith('JEV_API_KEY=')) {
        const val = line.slice('JEV_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
        if (val) return val
      }
      if (line.startsWith('TYPESAFE_API_KEY=')) {
        const val = line.slice('TYPESAFE_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
        if (val) return val
      }
    }
  } catch {
    /* ignore unreadable env file */
  }
  return null
}

export type JevProjectCandidate = {
  code: string
  name: string
  hint: string
}

export type JevAutoTagRuntime = {
  fetchFn?: LocalFetchFn
  jevApiKey?: string | null
  jevBaseUrl?: string
  jevModel?: string
  timeoutMs?: number
  nowIso?: () => string
}

const JEV_AUTO_TAG_TIMEOUT_MS = 10_000
const JEV_PRIVATE_MIN_NOUL = 0.7
const JEV_CATEGORY_MIN_CONFIDENCE = 0.72
const JEV_PROJECT_MIN_CONFIDENCE = 0.75
const JEV_KIND_MIN_CONFIDENCE = 0.8

const CATEGORY_CRITERIA: Record<JournalCategory, string> = {
  '工程': 'Software development, UI/UX bugs, coding prompts, AgentOS/SentinelLab/workspace apps, technical architecture',
  '生活': 'Daily personal life, errands, car maintenance, family, shopping, travel, casual moments',
  '事务': 'Administrative errands, logistics, appointments, scheduling, paperwork',
  '学习': 'Reading, language learning, courses, study notes, skill practice',
  '身体': 'Health, medical checkups, sleep, exercise, physical symptoms, diet',
  '工作': 'Non-coding professional work, meetings, business operations, career',
  '未归类': 'Too vague, empty, or impossible to classify cleanly',
}

export function hasJevApiKeyConfigured(explicitKey?: string | null): boolean {
  const key = explicitKey !== undefined ? explicitKey : loadJevApiKey()
  return Boolean(key && key.trim())
}

export async function decideJournalAutoTagWithJev(
  rawBody: string,
  projectCandidates: readonly JevProjectCandidate[],
  runtime: JevAutoTagRuntime = {},
): Promise<JournalAutoTagDecision | null> {
  const apiKey = runtime.jevApiKey !== undefined ? runtime.jevApiKey : loadJevApiKey()
  if (!apiKey || !apiKey.trim()) return null

  const fetchFn = await resolveFetch(runtime.fetchFn)
  const baseUrl = (runtime.jevBaseUrl || DEFAULT_JEV_BASE_URL).replace(/\/+$/, '')
  const model = (runtime.jevModel || DEFAULT_JEV_MODEL).trim()
  const safeBody = scrubSecrets(rawBody || '').slice(0, JOURNAL_AUTO_TAG_MAX_BODY_CHARS)
  if (!safeBody.trim()) return null

  const projectCriteria: Record<string, string> = {
    none: 'Does not belong to any listed workspace project (general life, personal notes, health, or unrelated tools)',
  }
  for (const candidate of projectCandidates) {
    projectCriteria[candidate.code] = candidate.hint
  }

  const questions: Record<string, unknown> = {
    is_private: {
      type: 'noul',
      instructions:
        'Does this journal entry contain private personal life details (family conflicts, intimate/relationship matters, personal medical/health records, financial/loan stress, emotional vulnerability) OR personally identifiable info (street address, phone number, ID/account/password)? Ordinary software engineering feedback, car maintenance, or general tech ideas are NOT private.',
    },
    category: {
      type: 'choice',
      instructions: 'Pick the single best Chinese category for this journal entry.',
      criteria: CATEGORY_CRITERIA,
    },
    project: {
      type: 'choice',
      instructions: 'Which listed workspace project does this entry clearly belong to, or none?',
      criteria: projectCriteria,
    },
    entry_kind: {
      type: 'choice',
      instructions: 'What functional role does this journal entry play?',
      criteria: {
        actionable: 'An unacted requirement, bug report, product idea, or personal todo',
        prompt_log: 'A direct structured prompt/instruction addressed to an AI coding assistant to execute now',
        status_note: 'Pure status update, mood remark, or casual check-in with no action item',
      },
    },
  }

  try {
    const res = await fetchWithTimeout(
      fetchFn,
      `${baseUrl}/systemone`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          state: safeBody,
          questions,
        }),
      },
      runtime.timeoutMs ?? JEV_AUTO_TAG_TIMEOUT_MS,
    )
    if (!res.ok) return null
    const data = (await res.json()) as {
      answers?: {
        is_private?: { noul?: unknown }
        category?: { choice?: unknown; confidence?: unknown }
        project?: { choice?: unknown; confidence?: unknown }
        entry_kind?: { choice?: unknown; confidence?: unknown }
      }
    }
    const answers = data?.answers
    if (!answers || typeof answers !== 'object') return null

    // Step 1: Privacy first
    const privScore = typeof answers.is_private?.noul === 'number' ? answers.is_private.noul : 0
    const isPrivate = privScore >= JEV_PRIVATE_MIN_NOUL

    // Step 2: Category
    let category: JournalCategory | null = null
    const rawCat = answers.category?.choice
    const catConf = typeof answers.category?.confidence === 'number' ? answers.category.confidence : 0
    if (
      typeof rawCat === 'string' &&
      rawCat !== '未归类' &&
      catConf >= JEV_CATEGORY_MIN_CONFIDENCE &&
      (JOURNAL_CATEGORIES as readonly string[]).includes(rawCat)
    ) {
      category = rawCat as JournalCategory
    }

    // Short-circuit project & engineering tags when Step 1 flagged the entry as private
    if (isPrivate) {
      return {
        private: true,
        category: category === '工程' ? '生活' : category,
        projectName: null,
        tags: [],
        decidedAt: runtime.nowIso?.() ?? new Date().toISOString(),
        pipeline: JOURNAL_AUTO_TAG_PIPELINE_VERSION,
        engine: `jev:${model}`,
      }
    }

    // Step 2: Project attribution
    let projectName: string | null = null
    const rawProj = answers.project?.choice
    const projConf = typeof answers.project?.confidence === 'number' ? answers.project.confidence : 0
    if (typeof rawProj === 'string' && rawProj !== 'none' && projConf >= JEV_PROJECT_MIN_CONFIDENCE) {
      const matched = projectCandidates.find((c) => c.code === rawProj)
      if (matched) projectName = matched.name
    }

    // Step 2: Concise semantic tag
    const tags: string[] = []
    const rawKind = answers.entry_kind?.choice
    const kindConf = typeof answers.entry_kind?.confidence === 'number' ? answers.entry_kind.confidence : 0
    if (rawKind === 'prompt_log' && kindConf >= JEV_KIND_MIN_CONFIDENCE) {
      tags.push('开发履历')
    }

    return {
      private: false,
      category,
      projectName,
      tags,
      decidedAt: runtime.nowIso?.() ?? new Date().toISOString(),
      pipeline: JOURNAL_AUTO_TAG_PIPELINE_VERSION,
      engine: `jev:${model}`,
    }
  } catch {
    return null
  }
}
