#!/usr/bin/env node
/**
 * Standalone Zero-Build Bridge Append Script for SentinelDesk Timeline Journal.
 * Invoked by external Feishu bridge or webhook hooks (`sentinellab-bridge.sh`).
 * Uses ONLY Node.js built-ins. Idempotent and fails safely.
 */

import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const DEFAULT_SENTINEL_DESK_ROOT = '/Users/sentinellab/VibeCoding/SentinelDesk'

const JOURNAL_TIMEZONE = 'Asia/Shanghai'

function formatShanghaiParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JOURNAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00'
  const hourRaw = get('hour')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hourRaw === '24' ? '00' : hourRaw,
    minute: get('minute'),
  }
}

function formatLocalDate(d) {
  const { year, month, day } = formatShanghaiParts(d)
  return `${year}-${month}-${day}`
}

function formatLocalTime(d) {
  const { hour, minute } = formatShanghaiParts(d)
  return `${hour}:${minute}`
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseArgs(argv) {
  const args = {
    source: 'feishu',
    text: '',
    externalId: null,
    category: '未归类',
    deskRoot: process.env.SENTINEL_DESK_ROOT || DEFAULT_SENTINEL_DESK_ROOT,
    date: null,
    time: null,
    tags: [],
    useStdin: false,
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--stdin') {
      args.useStdin = true
    } else if (arg === '--source' && i + 1 < argv.length) {
      args.source = argv[++i]
    } else if (arg === '--text' && i + 1 < argv.length) {
      args.text = argv[++i]
    } else if (arg === '--external-id' && i + 1 < argv.length) {
      args.externalId = argv[++i]
    } else if (arg === '--category' && i + 1 < argv.length) {
      args.category = argv[++i]
    } else if (arg === '--desk-root' && i + 1 < argv.length) {
      args.deskRoot = argv[++i]
    } else if (arg === '--date' && i + 1 < argv.length) {
      args.date = argv[++i]
    } else if (arg === '--time' && i + 1 < argv.length) {
      args.time = argv[++i]
    } else if (arg === '--tags' && i + 1 < argv.length) {
      const rawTags = argv[++i]
      try {
        args.tags = JSON.parse(rawTags)
      } catch {
        args.tags = rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      }
    }
  }

  return args
}

async function main() {
  const args = parseArgs(process.argv)

  if (args.useStdin || (!args.text && !process.stdin.isTTY)) {
    const rawStdin = await readStdin()
    const trimmed = rawStdin.trim()
    if (trimmed) {
      try {
        const payload = JSON.parse(trimmed)
        if (payload.text) args.text = payload.text
        if (payload.source) args.source = payload.source
        if (payload.externalId) args.externalId = payload.externalId
        if (payload.category) args.category = payload.category
        if (payload.deskRoot) args.deskRoot = payload.deskRoot
        if (payload.date) args.date = payload.date
        if (payload.time) args.time = payload.time
        if (Array.isArray(payload.tags)) args.tags = payload.tags
      } catch {
        if (!args.text) args.text = trimmed
      }
    }
  }

  if (!args.text || !args.text.trim()) {
    process.stderr.write('Error: missing required argument --text or stdin payload\n')
    process.exit(1)
  }

  const now = new Date()
  const targetDate = args.date || formatLocalDate(now)
  const targetTime = args.time || formatLocalTime(now)
  const targetTs = now.toISOString()

  const [year, month] = targetDate.split('-')
  const journalDir = path.join(args.deskRoot, 'journal', year, month)
  const targetFile = path.join(journalDir, `${targetDate}.md`)

  await fs.mkdir(journalDir, { recursive: true })

  // Dedup check: check if externalId is already in the file
  if (args.externalId && existsSync(targetFile)) {
    const existingContent = await fs.readFile(targetFile, 'utf8')
    const externalIdPattern = new RegExp(`"externalId"\\s*:\\s*"${args.externalId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
    if (externalIdPattern.test(existingContent)) {
      process.stdout.write(JSON.stringify({ ok: true, deduplicated: true, filePath: targetFile }) + '\n')
      process.exit(0)
    }
  }

  // Create entry
  const entryId = `je_${targetDate.replace(/-/g, '')}_${targetTime.replace(':', '')}_${randomBytes(3).toString('hex')}`
  const meta = {
    id: entryId,
    ts: targetTs,
    time: targetTime,
    kind: 'note',
    category: args.category || '未归类',
    tags: Array.isArray(args.tags) ? args.tags : [],
    projectRefs: [],
    source: args.source || 'feishu',
    provenance: 'human',
    externalId: args.externalId ?? null,
    images: [],
    relatedNote: null,
    momentTitle: null,
    momentSubtitle: null,
  }

  const comment = `<!-- journal:entry ${JSON.stringify(meta)} -->`
  const header = `### ${targetTime} · ${meta.category}`
  const body = args.text.trim()
  const entryBlock = `${comment}\n${header}\n${body}\n\n---\n`

  let finalContent = ''
  if (existsSync(targetFile)) {
    let existing = await fs.readFile(targetFile, 'utf8')
    if (!existing.endsWith('\n')) existing += '\n'
    if (!existing.endsWith('\n\n')) existing += '\n'
    finalContent = existing + entryBlock
  } else {
    finalContent = `# ${targetDate}\n\n${entryBlock}`
  }

  // Atomic write
  const tmpName = `.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`
  const tmpPath = path.join(journalDir, tmpName)
  await fs.writeFile(tmpPath, finalContent, 'utf8')
  await fs.rename(tmpPath, targetFile)

  process.stdout.write(
    JSON.stringify({
      ok: true,
      deduplicated: false,
      filePath: targetFile,
      id: entryId,
    }) + '\n'
  )
  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.message || String(err)}\n`)
  process.exit(1)
})
