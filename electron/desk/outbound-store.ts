/**
 * Local file-backed store for SentinelDesk Outbound Studio (`<deskRoot>/outbound/`).
 *
 * Persists:
 * - `config.json`: OutboundConfig
 * - `packs/YYYY-MM-DD.json`: daily extracted Moments + WeChat Column Seeds
 * - `articles/index.json` + `articles/<date>-<id>.md`: full anti-AI-slop WeChat drafts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  OUTBOUND_DEFAULT_ANTI_AI_REDLINES,
  OUTBOUND_DEFAULT_CONFIG,
  type OutboundArticleDraft,
  type OutboundCalendarDay,
  type OutboundConfig,
  type OutboundDayPack,
} from '../../src/outbound-contract'
import { scrubSecrets } from './journal-privacy'

export type OutboundStoreOptions = {
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

function formatDraftDiskMarkdown(draft: OutboundArticleDraft): string {
  const header = [
    '---',
    `date: ${draft.date}`,
    `column: ${draft.column}`,
    `seedId: ${draft.seedId}`,
    'privacyChecked: true',
    '---',
    '',
  ].join('\n')
  const altBlock =
    draft.altTitles.length > 0
      ? `<!-- 备选标题：${draft.altTitles.join(' / ')} -->\n\n`
      : ''
  return `${header}${altBlock}${scrubSecrets(draft.markdown).trim()}\n`
}

export class OutboundStore {
  private readonly now: () => Date

  constructor(private readonly options: OutboundStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  get baseDir(): string {
    return path.join(this.options.getDeskRoot(), 'outbound')
  }

  get packsDir(): string {
    return path.join(this.baseDir, 'packs')
  }

  get articlesDir(): string {
    return path.join(this.baseDir, 'articles')
  }

  get configPath(): string {
    return path.join(this.baseDir, 'config.json')
  }

  get draftsIndexPath(): string {
    return path.join(this.articlesDir, 'index.json')
  }

  packPath(date: string): string {
    return path.join(this.packsDir, `${date}.json`)
  }

  draftMarkdownPath(date: string, draftId: string): string {
    return path.join(this.articlesDir, `${date}-${draftId}.md`)
  }

  getConfig(): OutboundConfig {
    if (!existsSync(this.configPath)) {
      return { ...OUTBOUND_DEFAULT_CONFIG, repoPaths: [] }
    }
    try {
      const raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<OutboundConfig>
      return {
        companyName:
          typeof raw.companyName === 'string' && raw.companyName.trim()
            ? raw.companyName.trim().slice(0, 40)
            : OUTBOUND_DEFAULT_CONFIG.companyName,
        authorPersona:
          typeof raw.authorPersona === 'string' && raw.authorPersona.trim()
            ? raw.authorPersona.trim().slice(0, 80)
            : OUTBOUND_DEFAULT_CONFIG.authorPersona,
        journalWindowDays:
          typeof raw.journalWindowDays === 'number' && Number.isFinite(raw.journalWindowDays)
            ? Math.max(1, Math.min(14, Math.round(raw.journalWindowDays)))
            : OUTBOUND_DEFAULT_CONFIG.journalWindowDays,
        commitWindowDays:
          typeof raw.commitWindowDays === 'number' && Number.isFinite(raw.commitWindowDays)
            ? Math.max(1, Math.min(14, Math.round(raw.commitWindowDays)))
            : OUTBOUND_DEFAULT_CONFIG.commitWindowDays,
        repoPaths: Array.isArray(raw.repoPaths)
          ? raw.repoPaths
              .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
              .map((p) => p.trim())
              .slice(0, 8)
          : [],
        antiAiRedlines:
          typeof raw.antiAiRedlines === 'string' && raw.antiAiRedlines.trim()
            ? raw.antiAiRedlines.trim().slice(0, 500)
            : OUTBOUND_DEFAULT_ANTI_AI_REDLINES,
        modelPick: raw.modelPick ?? null,
      }
    } catch {
      return { ...OUTBOUND_DEFAULT_CONFIG, repoPaths: [] }
    }
  }

  saveConfig(patch: Partial<OutboundConfig>): OutboundConfig {
    const prev = this.getConfig()
    const merged: OutboundConfig = {
      ...prev,
      ...patch,
      companyName:
        typeof patch.companyName === 'string'
          ? patch.companyName.trim().slice(0, 40) || OUTBOUND_DEFAULT_CONFIG.companyName
          : prev.companyName,
      authorPersona:
        typeof patch.authorPersona === 'string'
          ? patch.authorPersona.trim().slice(0, 80) || OUTBOUND_DEFAULT_CONFIG.authorPersona
          : prev.authorPersona,
      journalWindowDays:
        typeof patch.journalWindowDays === 'number' && Number.isFinite(patch.journalWindowDays)
          ? Math.max(1, Math.min(14, Math.round(patch.journalWindowDays)))
          : prev.journalWindowDays,
      commitWindowDays:
        typeof patch.commitWindowDays === 'number' && Number.isFinite(patch.commitWindowDays)
          ? Math.max(1, Math.min(14, Math.round(patch.commitWindowDays)))
          : prev.commitWindowDays,
      repoPaths: Array.isArray(patch.repoPaths)
        ? patch.repoPaths
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => p.trim())
            .slice(0, 8)
        : prev.repoPaths,
      antiAiRedlines:
        typeof patch.antiAiRedlines === 'string'
          ? patch.antiAiRedlines.trim().slice(0, 500) || OUTBOUND_DEFAULT_ANTI_AI_REDLINES
          : prev.antiAiRedlines,
    }
    writeJsonAtomic(this.configPath, merged)
    return merged
  }

  getDayPack(date: string): OutboundDayPack | null {
    const filePath = this.packPath(date)
    if (!existsSync(filePath)) return null
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as OutboundDayPack
      if (!parsed || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  saveDayPack(pack: OutboundDayPack): OutboundDayPack {
    writeJsonAtomic(this.packPath(pack.date), pack)
    return pack
  }

  listDrafts(date?: string): OutboundArticleDraft[] {
    if (!existsSync(this.draftsIndexPath)) return []
    try {
      const raw = JSON.parse(readFileSync(this.draftsIndexPath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      const drafts = raw.filter(
        (d): d is OutboundArticleDraft => Boolean(d && typeof d === 'object' && typeof (d as OutboundArticleDraft).id === 'string'),
      )
      const filtered = date ? drafts.filter((d) => d.date === date) : drafts
      return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch {
      return []
    }
  }

  upsertDraft(draft: OutboundArticleDraft): OutboundArticleDraft {
    const all = this.listDrafts()
    const mdPath = this.draftMarkdownPath(draft.date, draft.id)
    const normalized: OutboundArticleDraft = {
      ...draft,
      markdown: scrubSecrets(draft.markdown),
      markdownPath: mdPath,
    }
    const idx = all.findIndex((item) => item.id === normalized.id)
    if (idx >= 0) {
      all[idx] = normalized
    } else {
      all.unshift(normalized)
    }
    writeJsonAtomic(this.draftsIndexPath, all)
    writeTextAtomic(mdPath, formatDraftDiskMarkdown(normalized))

    const pack = this.getDayPack(normalized.date)
    if (pack) {
      const nextSeeds = pack.seeds.map((s) =>
        s.id === normalized.seedId ? { ...s, draftId: normalized.id } : s,
      )
      this.saveDayPack({ ...pack, seeds: nextSeeds })
    }

    return normalized
  }

  updateExistingDraft(params: {
    draftId: string
    title?: string
    markdown: string
  }): OutboundArticleDraft | null {
    const all = this.listDrafts()
    const existing = all.find((d) => d.id === params.draftId)
    if (!existing) return null
    const updated: OutboundArticleDraft = {
      ...existing,
      title: params.title?.trim() || existing.title,
      markdown: scrubSecrets(params.markdown),
      updatedAt: this.now().toISOString(),
    }
    return this.upsertDraft(updated)
  }

  listCalendarDays(): OutboundCalendarDay[] {
    if (!existsSync(this.packsDir)) return []
    try {
      const allDrafts = this.listDrafts()
      const draftCountByDate = new Map<string, number>()
      for (const d of allDrafts) {
        draftCountByDate.set(d.date, (draftCountByDate.get(d.date) ?? 0) + 1)
      }
      const days: OutboundCalendarDay[] = []
      for (const file of readdirSync(this.packsDir)) {
        const match = DATE_FILE_RE.exec(file)
        if (!match) continue
        const date = match[1]
        const pack = this.getDayPack(date)
        if (!pack) continue
        days.push({
          date,
          momentCount: pack.moments.length,
          seedCount: pack.seeds.length,
          draftCount: draftCountByDate.get(date) ?? 0,
        })
      }
      return days.sort((a, b) => b.date.localeCompare(a.date))
    } catch {
      return []
    }
  }
}
