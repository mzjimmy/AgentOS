/**
 * Pure Markdown Parser & Serializer for SentinelDesk daily journal entries.
 * Stored at: <deskRoot>/journal/YYYY/MM/YYYY-MM-DD.md
 */

import {
  JOURNAL_CATEGORIES,
  JOURNAL_ENTRY_KINDS,
  type JournalCategory,
  type JournalEntry,
  type JournalEntryKind,
  type JournalImageAttachment,
} from '../../src/journal-contract'

export function serializeDayMarkdown(date: string, entries: JournalEntry[]): string {
  const parts: string[] = [`# ${date}\n`]

  for (const entry of entries) {
    const meta = {
      id: entry.id,
      ts: entry.ts,
      time: entry.time,
      kind: entry.kind,
      category: entry.category,
      tags: entry.tags || [],
      projectRefs: entry.projectRefs || [],
      source: entry.source || 'local',
      provenance: entry.provenance || 'human',
      externalId: entry.externalId ?? null,
      images: entry.images || [],
      relatedNote: entry.relatedNote ?? null,
      momentTitle: entry.momentTitle ?? null,
      momentSubtitle: entry.momentSubtitle ?? null,
    }

    const comment = `<!-- journal:entry ${JSON.stringify(meta)} -->`
    const header = `### ${entry.time} · ${entry.category}`
    const body = (entry.body || '').trim()

    const imageLines = (entry.images || [])
      .map((img) => `![${img.caption || img.fileName}](../../${img.relativePath})`)
      .join('\n')

    let entryBlock = `${comment}\n${header}`
    if (body) {
      entryBlock += `\n${body}`
    }
    if (imageLines) {
      entryBlock += `\n\n${imageLines}`
    }

    parts.push(entryBlock)
  }

  // Join entries with Obsidian-friendly separator
  if (parts.length === 1) {
    return `# ${date}\n`
  }

  return parts[0] + '\n' + parts.slice(1).join('\n\n---\n\n') + '\n\n---\n'
}

export function parseDayMarkdown(fileDate: string, content: string): JournalEntry[] {
  if (!content || !content.trim()) {
    return []
  }

  // Extract date from `# YYYY-MM-DD` if present
  const titleMatch = content.match(/^#\s+(\d{4}-\d{2}-\d{2})/)
  const resolvedDate = titleMatch ? titleMatch[1] : fileDate

  // Remove the top-level `# YYYY-MM-DD` title
  let text = content
  if (titleMatch) {
    text = text.replace(/^#\s+\d{4}-\d{2}-\d{2}\s*\r?\n/, '')
  }

  // Prefer splitting by `<!-- journal:entry ... -->` boundaries when present so
  // Markdown horizontal rules (`---`) inside user prose never split an entry.
  // Any trailing hand-written blocks or files without comment markers still split on `---`.
  const hasEntryMarkers = /<!--\s*journal:entry\s+\{/.test(text)
  const rawBlocks: string[] = []
  if (hasEntryMarkers) {
    const markerSplit = text.split(/(?=<!--\s*journal:entry\s+\{)/)
    for (const chunk of markerSplit) {
      const trimmedChunk = chunk.trim()
      if (!trimmedChunk) continue
      if (/^<!--\s*journal:entry\s+\{/.test(trimmedChunk)) {
        // Strip only the trailing separator `---` that terminates this entry block
        rawBlocks.push(trimmedChunk.replace(/(?:\r?\n|^)---\s*$/, '').trim())
      } else {
        for (const loose of trimmedChunk.split(/(?:\r?\n|^)---\s*(?:\r?\n|$)/)) {
          if (loose.trim()) rawBlocks.push(loose.trim())
        }
      }
    }
  } else {
    for (const loose of text.split(/(?:\r?\n|^)---\s*(?:\r?\n|$)/)) {
      if (loose.trim()) rawBlocks.push(loose.trim())
    }
  }
  const entries: JournalEntry[] = []

  for (const block of rawBlocks) {
    const trimmed = block.trim()
    if (!trimmed) continue

    // 1. Check for `<!-- journal:entry {JSON} -->`
    const commentMatch = trimmed.match(/<!--\s*journal:entry\s+({[\s\S]*?})\s*-->/)
    let meta: Record<string, any> | null = null
    if (commentMatch) {
      try {
        meta = JSON.parse(commentMatch[1])
      } catch {
        meta = null
      }
    }

    // Remove the comment from block for body extraction
    let rest = commentMatch ? trimmed.replace(commentMatch[0], '').trim() : trimmed

    // 2. Check for `### HH:mm · <category>`
    const headerMatch = rest.match(/^###\s+(\d{1,2}:\d{2})(?:\s*·\s*([^\r\n]+))?/)
    let headerTime: string | null = null
    let headerCategory: JournalCategory | null = null
    if (headerMatch) {
      headerTime = headerMatch[1].padStart(5, '0')
      const catCandidate = (headerMatch[2] || '').trim()
      if (JOURNAL_CATEGORIES.includes(catCandidate as JournalCategory)) {
        headerCategory = catCandidate as JournalCategory
      }
      rest = rest.replace(headerMatch[0], '').trim()
    }

    // 3. Extract and strip Obsidian-friendly relative image markdown
    // Pattern: ![caption](../../attachments/YYYY/MM/file.ext) or ![caption](attachments/...)
    const extractedImages: JournalImageAttachment[] = []
    const imageRegex = /!\[(.*?)\]\((?:(?:\.\.\/)+)?(attachments\/[^\)]+)\)/g
    let imgMatch: RegExpExecArray | null
    while ((imgMatch = imageRegex.exec(rest)) !== null) {
      const caption = imgMatch[1].trim()
      const relativePath = imgMatch[2].trim()
      const fileName = relativePath.split('/').pop() || 'image.png'
      const ext = fileName.split('.').pop()?.toLowerCase() || 'png'
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
      extractedImages.push({
        relativePath,
        fileName,
        mimeType,
        caption: caption || undefined,
      })
    }

    // Strip image markdown lines from body so it doesn't duplicate into entry.body
    const cleanBody = rest
      .replace(/^\s*!\[.*?\]\((?:(?:\.\.\/)+)?attachments\/[^\)]+\)\s*$/gm, '')
      .replace(/\r?\n{3,}/g, '\n\n')
      .trim()

    // Determine fields
    const id = meta?.id || `je_${resolvedDate.replace(/-/g, '')}_${(headerTime || '00:00').replace(':', '')}_${Math.random().toString(36).slice(2, 6)}`
    const time = headerTime || meta?.time || '00:00'
    const ts = meta?.ts || `${resolvedDate}T${time}:00.000+08:00`
    const kind: JournalEntryKind = meta?.kind && JOURNAL_ENTRY_KINDS.includes(meta.kind) ? meta.kind : 'note'
    const category: JournalCategory = headerCategory || (meta?.category && JOURNAL_CATEGORIES.includes(meta.category) ? meta.category : '未归类')
    const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : []
    const projectRefs: string[] = Array.isArray(meta?.projectRefs) ? meta.projectRefs : []
    const source = meta?.source || 'local'
    const provenance = meta?.provenance || 'human'
    const externalId = meta?.externalId ?? null
    const images: JournalImageAttachment[] = (meta?.images && meta.images.length > 0) ? meta.images : extractedImages
    const relatedNote = meta?.relatedNote ?? null
    const momentTitle = meta?.momentTitle ?? null
    const momentSubtitle = meta?.momentSubtitle ?? null

    entries.push({
      id,
      date: resolvedDate,
      time,
      ts,
      kind,
      body: cleanBody,
      category,
      tags,
      projectRefs,
      source,
      provenance,
      externalId,
      images,
      relatedNote,
      momentTitle,
      momentSubtitle,
    })
  }

  return entries
}
