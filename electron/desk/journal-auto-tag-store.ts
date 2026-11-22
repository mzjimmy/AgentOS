/**
 * Persistent state for the journal auto-tagger.
 *
 * Lives under `<userData>/journal-auto-tag/state.json` (application state, not user
 * content) and holds the user config plus a decision cache keyed by
 * `<pipelineVersion>:<bodyHash>` so a repeated run costs zero model calls.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  JOURNAL_CATEGORIES,
  type JournalCategory,
} from '../../src/journal-contract'
import {
  JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL,
  JOURNAL_AUTO_TAG_DEFAULT_LOCAL_MODEL,
  JOURNAL_AUTO_TAG_PIPELINE_VERSION,
  type JournalAutoTagConfig,
  type JournalAutoTagDecision,
  type JournalAutoTagEngine,
  type JournalAutoTagRunSummary,
} from '../../src/journal-auto-tag-contract'

const STATE_VERSION = 1
const VALID_ENGINES = new Set<JournalAutoTagEngine>(['local', 'jev', 'auto'])

function normalizeEngine(raw: unknown): JournalAutoTagEngine {
  return typeof raw === 'string' && VALID_ENGINES.has(raw as JournalAutoTagEngine)
    ? (raw as JournalAutoTagEngine)
    : 'local'
}

function normalizeCategory(raw: unknown): JournalCategory | null {
  if (typeof raw !== 'string') return null
  return (JOURNAL_CATEGORIES as readonly string[]).includes(raw) ? (raw as JournalCategory) : null
}

export type JournalAutoTagState = {
  version: number
  config: JournalAutoTagConfig
  /** key = `<pipelineVersion>:<bodyHash>` */
  decisions: Record<string, JournalAutoTagDecision>
  lastRun: JournalAutoTagRunSummary
  lastRunByDate: Record<string, JournalAutoTagRunSummary>
}

export function defaultAutoTagConfig(): JournalAutoTagConfig {
  return {
    enabled: true,
    engine: 'local',
    localBaseUrl: JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL,
    localModel: JOURNAL_AUTO_TAG_DEFAULT_LOCAL_MODEL,
  }
}

export function emptyAutoTagRunSummary(): JournalAutoTagRunSummary {
  return {
    status: 'idle',
    ranAt: null,
    endpoint: null,
    scanned: 0,
    decided: 0,
    changed: 0,
    skipped: 0,
  }
}

function emptyState(): JournalAutoTagState {
  return {
    version: STATE_VERSION,
    config: defaultAutoTagConfig(),
    decisions: {},
    lastRun: emptyAutoTagRunSummary(),
    lastRunByDate: {},
  }
}

function normalizeRunSummary(raw: unknown): JournalAutoTagRunSummary {
  const base = emptyAutoTagRunSummary()
  if (!raw || typeof raw !== 'object') return base
  const obj = raw as Record<string, unknown>
  const status = obj.status
  const validStatuses = ['idle', 'disabled', 'local_unreachable', 'skipped', 'completed', 'failed']
  return {
    status: validStatuses.includes(String(status)) ? (status as JournalAutoTagRunSummary['status']) : 'idle',
    ranAt: typeof obj.ranAt === 'string' ? obj.ranAt : null,
    endpoint: typeof obj.endpoint === 'string' ? obj.endpoint : null,
    scanned: typeof obj.scanned === 'number' ? obj.scanned : 0,
    decided: typeof obj.decided === 'number' ? obj.decided : 0,
    changed: typeof obj.changed === 'number' ? obj.changed : 0,
    skipped: typeof obj.skipped === 'number' ? obj.skipped : 0,
    ...(typeof obj.message === 'string' ? { message: obj.message } : {}),
  }
}

function normalizeState(raw: unknown): JournalAutoTagState {
  if (!raw || typeof raw !== 'object') return emptyState()
  const obj = raw as Record<string, unknown>
  const state = emptyState()

  const cfgRaw = (obj.config && typeof obj.config === 'object' ? obj.config : {}) as Record<string, unknown>
  state.config = {
    enabled: cfgRaw.enabled !== false,
    engine: normalizeEngine(cfgRaw.engine),
    localBaseUrl:
      typeof cfgRaw.localBaseUrl === 'string' && cfgRaw.localBaseUrl.trim()
        ? cfgRaw.localBaseUrl.trim()
        : JOURNAL_AUTO_TAG_DEFAULT_LOCAL_BASE_URL,
    localModel:
      typeof cfgRaw.localModel === 'string' && cfgRaw.localModel.trim()
        ? cfgRaw.localModel.trim()
        : JOURNAL_AUTO_TAG_DEFAULT_LOCAL_MODEL,
  }

  if (obj.decisions && typeof obj.decisions === 'object' && !Array.isArray(obj.decisions)) {
    for (const [key, value] of Object.entries(obj.decisions as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const decision = value as Record<string, unknown>
      state.decisions[key] = {
        private: decision.private === true,
        category: normalizeCategory(decision.category),
        projectName:
          typeof decision.projectName === 'string' && decision.projectName.trim()
            ? decision.projectName.trim()
            : null,
        tags: Array.isArray(decision.tags)
          ? decision.tags.map((t) => String(t || '').trim()).filter(Boolean)
          : [],
        decidedAt: typeof decision.decidedAt === 'string' ? decision.decidedAt : '',
        pipeline: typeof decision.pipeline === 'string' ? decision.pipeline : JOURNAL_AUTO_TAG_PIPELINE_VERSION,
        ...(typeof decision.engine === 'string' ? { engine: decision.engine } : {}),
      }
    }
  }

  state.lastRun = normalizeRunSummary(obj.lastRun)
  if (obj.lastRunByDate && typeof obj.lastRunByDate === 'object' && !Array.isArray(obj.lastRunByDate)) {
    for (const [date, summary] of Object.entries(obj.lastRunByDate as Record<string, unknown>)) {
      state.lastRunByDate[date] = normalizeRunSummary(summary)
    }
  }

  return state
}

export class JournalAutoTagStore {
  private readonly statePath: string

  constructor(options: { userDataPath: string }) {
    this.statePath = path.join(options.userDataPath, 'journal-auto-tag', 'state.json')
  }

  getStatePath(): string {
    return this.statePath
  }

  readState(): JournalAutoTagState {
    if (!existsSync(this.statePath)) return emptyState()
    try {
      const raw = readFileSync(this.statePath, 'utf8')
      return normalizeState(JSON.parse(raw))
    } catch {
      return emptyState()
    }
  }

  private writeState(state: JournalAutoTagState): void {
    const dir = path.dirname(this.statePath)
    mkdirSync(dir, { recursive: true })
    const tmpPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmpPath, this.statePath)
  }

  getConfig(): JournalAutoTagConfig {
    return this.readState().config
  }

  saveConfig(patch: Partial<JournalAutoTagConfig>): JournalAutoTagConfig {
    const state = this.readState()
    state.config = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : state.config.enabled,
      engine: patch.engine !== undefined ? normalizeEngine(patch.engine) : state.config.engine,
      localBaseUrl:
        typeof patch.localBaseUrl === 'string' && patch.localBaseUrl.trim()
          ? patch.localBaseUrl.trim()
          : state.config.localBaseUrl,
      localModel:
        typeof patch.localModel === 'string' && patch.localModel.trim()
          ? patch.localModel.trim()
          : state.config.localModel,
    }
    this.writeState(state)
    return state.config
  }

  getDecision(bodyHash: string): JournalAutoTagDecision | null {
    const key = `${JOURNAL_AUTO_TAG_PIPELINE_VERSION}:${bodyHash}`
    return this.readState().decisions[key] ?? null
  }

  putDecision(bodyHash: string, decision: JournalAutoTagDecision): void {
    const state = this.readState()
    const key = `${JOURNAL_AUTO_TAG_PIPELINE_VERSION}:${bodyHash}`
    state.decisions[key] = decision
    this.writeState(state)
  }

  recordRun(date: string, summary: JournalAutoTagRunSummary): void {
    const state = this.readState()
    state.lastRun = summary
    state.lastRunByDate[date] = summary
    this.writeState(state)
  }
}
