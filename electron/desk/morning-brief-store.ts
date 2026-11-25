/**
 * Local file-backed store for SentinelDesk Morning Brief (`<deskRoot>/briefings/`).
 *
 * Persists:
 * - `config.json`: MorningBriefConfig
 * - `issues/YYYY-MM-DD.json`: structured MorningBriefIssue + backup pool
 * - `issues/YYYY-MM-DD.md`: WeChat-ready Markdown export
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  MORNING_BRIEF_DEFAULT_CONFIG,
  MORNING_BRIEF_DEFAULT_SOURCES,
  type MorningBriefCalendarDay,
  type MorningBriefConfig,
  type MorningBriefIssue,
  type MorningBriefSourceConfig,
} from '../../src/morning-brief-contract'
import {
  buildLeadSummaryFromItems,
  estimateReadingMinutes,
  formatMorningBriefMarkdown,
} from './morning-brief-analyzer'

export type MorningBriefStoreOptions = {
  getDeskRoot: () => string
  now?: () => Date
}

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/

function writeJsonAtomic(filePath: string, payload: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, filePath)
}

function writeTextAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, filePath)
}

function sanitizeSources(raw: unknown): MorningBriefSourceConfig[] {
  if (!Array.isArray(raw)) {
    return MORNING_BRIEF_DEFAULT_SOURCES.map((s) => ({ ...s }))
  }
  const byId = new Map<string, MorningBriefSourceConfig>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Partial<MorningBriefSourceConfig>
    const id = typeof rec.id === 'string' ? rec.id.trim() : ''
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const url = typeof rec.url === 'string' ? rec.url.trim() : ''
    if (!id || !name || !/^https?:\/\//i.test(url)) continue
    const kind =
      rec.kind === 'hackernews' || rec.kind === 'huggingface_papers' ? rec.kind : 'rss'
    byId.set(id, {
      id,
      name,
      kind,
      url,
      enabled: rec.enabled !== false,
      builtin: Boolean(rec.builtin),
    })
  }
  if (byId.size === 0) {
    return MORNING_BRIEF_DEFAULT_SOURCES.map((s) => ({ ...s }))
  }
  // Ensure any new built-in source is merged without losing user's toggle states
  for (const builtin of MORNING_BRIEF_DEFAULT_SOURCES) {
    if (!byId.has(builtin.id)) {
      byId.set(builtin.id, { ...builtin })
    }
  }
  return [...byId.values()]
}

export class MorningBriefStore {
  private readonly now: () => Date

  constructor(private readonly options: MorningBriefStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  get baseDir(): string {
    return path.join(this.options.getDeskRoot(), 'briefings')
  }

  get issuesDir(): string {
    return path.join(this.baseDir, 'issues')
  }

  get ttsCacheDir(): string {
    return path.join(this.baseDir, 'tts-cache')
  }

  get configPath(): string {
    return path.join(this.baseDir, 'config.json')
  }

  issueJsonPath(date: string): string {
    return path.join(this.issuesDir, `${date}.json`)
  }

  issueMarkdownPath(date: string): string {
    return path.join(this.issuesDir, `${date}.md`)
  }

  issueAudioPath(date: string): string {
    return path.join(this.issuesDir, `briefing-${date}.mp3`)
  }

  getConfig(): MorningBriefConfig {
    if (!existsSync(this.configPath)) {
      return {
        ...MORNING_BRIEF_DEFAULT_CONFIG,
        sources: MORNING_BRIEF_DEFAULT_SOURCES.map((s) => ({ ...s })),
      }
    }
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<MorningBriefConfig>
      return {
        authorName:
          typeof raw.authorName === 'string' && raw.authorName.trim()
            ? raw.authorName.trim().slice(0, 32)
            : MORNING_BRIEF_DEFAULT_CONFIG.authorName,
        issueTag:
          typeof raw.issueTag === 'string' && raw.issueTag.trim()
            ? raw.issueTag.trim().slice(0, 24)
            : MORNING_BRIEF_DEFAULT_CONFIG.issueTag,
        itemCount:
          typeof raw.itemCount === 'number' && Number.isFinite(raw.itemCount)
            ? Math.max(5, Math.min(12, Math.round(raw.itemCount)))
            : MORNING_BRIEF_DEFAULT_CONFIG.itemCount,
        scheduleHour:
          typeof raw.scheduleHour === 'number' && Number.isFinite(raw.scheduleHour)
            ? Math.max(4, Math.min(23, Math.round(raw.scheduleHour)))
            : MORNING_BRIEF_DEFAULT_CONFIG.scheduleHour,
        scheduleMinute:
          typeof raw.scheduleMinute === 'number' && Number.isFinite(raw.scheduleMinute)
            ? Math.max(0, Math.min(59, Math.round(raw.scheduleMinute)))
            : typeof raw.scheduleHour === 'number'
              ? 0
              : MORNING_BRIEF_DEFAULT_CONFIG.scheduleMinute,
        autoRunEnabled:
          typeof raw.autoRunEnabled === 'boolean'
            ? raw.autoRunEnabled
            : MORNING_BRIEF_DEFAULT_CONFIG.autoRunEnabled,
        speechRate:
          typeof raw.speechRate === 'number' && Number.isFinite(raw.speechRate)
            ? Math.max(0.7, Math.min(1.4, Number(raw.speechRate.toFixed(2))))
            : MORNING_BRIEF_DEFAULT_CONFIG.speechRate,
        ttsVoiceZh:
          typeof raw.ttsVoiceZh === 'string' && raw.ttsVoiceZh.trim()
            ? raw.ttsVoiceZh.trim()
            : MORNING_BRIEF_DEFAULT_CONFIG.ttsVoiceZh,
        ttsModel:
          typeof raw.ttsModel === 'string' && raw.ttsModel.trim()
            ? raw.ttsModel.trim()
            : MORNING_BRIEF_DEFAULT_CONFIG.ttsModel,
        sources: sanitizeSources(raw.sources),
        modelPick: raw.modelPick ?? null,
      }
    } catch {
      return {
        ...MORNING_BRIEF_DEFAULT_CONFIG,
        sources: MORNING_BRIEF_DEFAULT_SOURCES.map((s) => ({ ...s })),
      }
    }
  }

  saveConfig(patch: Partial<MorningBriefConfig>): MorningBriefConfig {
    const prev = this.getConfig()
    const merged: MorningBriefConfig = {
      ...prev,
      ...patch,
      authorName:
        typeof patch.authorName === 'string'
          ? patch.authorName.trim().slice(0, 32) || MORNING_BRIEF_DEFAULT_CONFIG.authorName
          : prev.authorName,
      issueTag:
        typeof patch.issueTag === 'string'
          ? patch.issueTag.trim().slice(0, 24) || MORNING_BRIEF_DEFAULT_CONFIG.issueTag
          : prev.issueTag,
      itemCount:
        typeof patch.itemCount === 'number' && Number.isFinite(patch.itemCount)
          ? Math.max(5, Math.min(12, Math.round(patch.itemCount)))
          : prev.itemCount,
      scheduleHour:
        typeof patch.scheduleHour === 'number' && Number.isFinite(patch.scheduleHour)
          ? Math.max(4, Math.min(23, Math.round(patch.scheduleHour)))
          : prev.scheduleHour,
      scheduleMinute:
        typeof patch.scheduleMinute === 'number' && Number.isFinite(patch.scheduleMinute)
          ? Math.max(0, Math.min(59, Math.round(patch.scheduleMinute)))
          : prev.scheduleMinute,
      speechRate:
        typeof patch.speechRate === 'number' && Number.isFinite(patch.speechRate)
          ? Math.max(0.7, Math.min(1.4, Number(patch.speechRate.toFixed(2))))
          : prev.speechRate,
      sources: patch.sources !== undefined ? sanitizeSources(patch.sources) : prev.sources,
    }
    writeJsonAtomic(this.configPath, merged)
    return merged
  }

  getIssue(date: string): MorningBriefIssue | null {
    const jsonPath = this.issueJsonPath(date)
    if (!existsSync(jsonPath)) return null
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as MorningBriefIssue
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null
      const audioPath = this.issueAudioPath(date)
      return {
        ...parsed,
        markdownPath: this.issueMarkdownPath(date),
        stitchedAudioPath: existsSync(audioPath) ? audioPath : parsed.stitchedAudioPath ?? null,
      }
    } catch {
      return null
    }
  }

  saveIssue(issue: MorningBriefIssue): MorningBriefIssue {
    const mdPath = this.issueMarkdownPath(issue.date)
    const normalized: MorningBriefIssue = {
      ...issue,
      markdownPath: mdPath,
    }
    writeJsonAtomic(this.issueJsonPath(issue.date), normalized)
    writeTextAtomic(mdPath, formatMorningBriefMarkdown(normalized))
    return normalized
  }

  swapStoryItem(date: string, itemId: string): { ok: true; issue: MorningBriefIssue } | { ok: false; error: string } {
    const existing = this.getIssue(date)
    if (!existing) {
      return { ok: false, error: '当前日期尚未生成早报。' }
    }
    if (!existing.backupItems || existing.backupItems.length === 0) {
      return { ok: false, error: '当前早报暂无更多替补条目。' }
    }
    const targetIdx = existing.items.findIndex((item) => item.id === itemId)
    if (targetIdx < 0) {
      return { ok: false, error: '未找到要替换的条目。' }
    }

    const [replacement, ...restBackups] = existing.backupItems
    const removed = existing.items[targetIdx]
    const nextItems = [...existing.items]
    nextItems[targetIdx] = replacement
    const nextBackups = [...restBackups, removed]

    const nextLeadSummary =
      targetIdx < 4 ? buildLeadSummaryFromItems(nextItems) : existing.leadSummary

    const updated: MorningBriefIssue = {
      ...existing,
      items: nextItems,
      backupItems: nextBackups,
      leadSummary: nextLeadSummary,
      readingMinutes: estimateReadingMinutes(nextItems, existing.introParagraph),
      stitchedAudioPath: null,
      updatedAt: this.now().toISOString(),
    }

    return { ok: true, issue: this.saveIssue(updated) }
  }

  listCalendarDays(): MorningBriefCalendarDay[] {
    if (!existsSync(this.issuesDir)) return []
    try {
      const files = readdirSync(this.issuesDir)
      const days: MorningBriefCalendarDay[] = []
      for (const file of files) {
        const match = DATE_FILE_RE.exec(file)
        if (!match) continue
        const date = match[1]
        const issue = this.getIssue(date)
        if (!issue) continue
        days.push({
          date,
          itemCount: issue.items.length,
          hasAudio: Boolean(issue.stitchedAudioPath && existsSync(issue.stitchedAudioPath)),
        })
      }
      return days.sort((a, b) => b.date.localeCompare(a.date))
    } catch {
      return []
    }
  }
}
