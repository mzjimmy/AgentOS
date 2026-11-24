/**
 * SentinelDesk upstream-surface budget.
 *
 * The fork adds ~31k lines on top of upstream AgentOS. This tool measures how
 * much of the *upstream* tree the fork actually touches, so that surface can
 * only shrink by an explicit, reviewed decision.
 *
 * Definitions
 *   upstream surface   a path that exists at the base commit and differs from
 *                      it. These are the files that can conflict with an
 *                      upstream merge.
 *   addedOutsideDesk   new code files the fork added under src/ or electron/
 *                      outside its own directories. They cannot conflict, but
 *                      they must not grow silently.
 *
 * CLI: node sentinel-desk/scripts/upstream-surface.mjs [--base <ref>] [--write] [--json]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isBasePath, isDeskOwned, isDirectInvocation } from './desk-paths.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(scriptDir, '..', '..')
export const BUDGET_PATH = resolve(REPO_ROOT, 'sentinel-desk', 'upstream-surface.budget.json')

/** Budget categories. */
export const CATEGORIES = ['A', 'C', 'D']

export const CATEGORY_LABELS = {
  A: 'A — desk wiring inside base files (merge conflict risk)',
  C: 'C — generic base behaviour patches (kept as the fork patch list)',
  D: 'D — docs / meta',
}

/**
 * Parse `git diff --numstat` output.
 * @param {string} text
 * @returns {{path:string,added:number,removed:number,binary:boolean,renamed:boolean}[]}
 */
export function parseNumstat(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addedRaw, removedRaw, ...rest] = parts
    const rawPath = rest.join('\t').trim()
    if (!rawPath) continue
    const binary = addedRaw === '-' || removedRaw === '-'
    const added = binary ? 0 : Number.parseInt(addedRaw, 10) || 0
    const removed = binary ? 0 : Number.parseInt(removedRaw, 10) || 0
    const { path, renamed } = parseNumstatPath(rawPath)
    rows.push({ path, added, removed, binary, renamed })
  }
  return rows
}

/** Resolve a numstat path, which may encode a rename. */
export function parseNumstatPath(rawPath) {
  const text = rawPath.trim()
  if (!text.includes('=>')) return { path: text, renamed: false }

  const brace = text.match(/^(.*)\{(.*?)\s*=>\s*(.*?)\}(.*)$/)
  if (brace) {
    const [, prefix, , replacement, suffix] = brace
    return { path: `${prefix}${replacement}${suffix}`, renamed: true }
  }
  const arrow = text.match(/^(.*?)\s*=>\s*(.*)$/)
  if (arrow) return { path: arrow[2].trim(), renamed: true }
  return { path: text, renamed: true }
}

/**
 * Split the diff into upstream surface and ratcheted additions.
 * @param {{numstat?: object[], untracked?: string[], existsAtBase: (path: string) => boolean}} input
 */
export function buildSurface({ numstat = [], untracked = [], existsAtBase }) {
  const files = {}
  const additions = new Set()
  // Fork docs (changes/, skills, ...) can neither conflict nor leak into the base runtime.
  const isRatchetedAddition = (path) => isBasePath(path) && !isDeskOwned(path)

  for (const row of numstat) {
    if (existsAtBase(row.path)) {
      files[row.path] = { added: row.added, removed: row.removed, binary: row.binary }
    } else if (isRatchetedAddition(row.path)) {
      additions.add(row.path)
    }
  }

  for (const path of untracked) {
    if (isRatchetedAddition(path)) additions.add(path)
  }

  return { files, addedOutsideDesk: [...additions].sort() }
}

/**
 * Compare a surface against a budget.
 * @param {{files: object, addedOutsideDesk: string[]}} surface
 * @param {{base?: string, files?: object, addedOutsideDesk?: string[]}} budget
 */
export function checkBudget(surface, budget) {
  const violations = []
  const slack = []

  const surfaceFiles = surface?.files ?? {}
  const surfaceAdditions = surface?.addedOutsideDesk ?? []
  const budgetFiles = budget?.files ?? {}
  const budgetAdditions = Array.isArray(budget?.addedOutsideDesk) ? budget.addedOutsideDesk : []

  for (const [path, entry] of Object.entries(surfaceFiles)) {
    const budgetEntry = budgetFiles[path]
    if (!budgetEntry) {
      violations.push({ type: 'missing-entry', path })
      continue
    }

    if (!CATEGORIES.includes(budgetEntry.category)) {
      violations.push({ type: 'unknown-category', path, category: budgetEntry.category ?? null })
    }

    if (entry.added > budgetEntry.added || entry.removed > budgetEntry.removed) {
      violations.push({
        type: 'over-budget',
        path,
        added: entry.added,
        removed: entry.removed,
        budgetAdded: budgetEntry.added,
        budgetRemoved: budgetEntry.removed,
      })
    } else if (entry.added < budgetEntry.added || entry.removed < budgetEntry.removed) {
      slack.push({
        type: 'slack',
        path,
        added: entry.added,
        removed: entry.removed,
        budgetAdded: budgetEntry.added,
        budgetRemoved: budgetEntry.removed,
      })
    }
  }

  for (const [path, entry] of Object.entries(budgetFiles)) {
    if (!surfaceFiles[path]) {
      violations.push({ type: 'stale-entry', path, category: entry.category ?? null })
    }
  }

  const budgetAdditionSet = new Set(budgetAdditions)
  for (const path of surfaceAdditions) {
    if (!budgetAdditionSet.has(path)) violations.push({ type: 'unbudgeted-addition', path })
  }
  const surfaceAdditionSet = new Set(surfaceAdditions)
  for (const path of budgetAdditions) {
    if (!surfaceAdditionSet.has(path)) violations.push({ type: 'stale-addition', path })
  }

  return { violations, slack, ok: violations.length === 0 }
}

/* ------------------------------------------------------------------ *
 * Git plumbing
 * ------------------------------------------------------------------ */

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** Base reference: --base > DESK_UPSTREAM_REF > upstream/main */
export function resolveBaseRef(argv = [], env = process.env) {
  const flagIndex = argv.indexOf('--base')
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1]
  if (env.DESK_UPSTREAM_REF) return env.DESK_UPSTREAM_REF
  return 'upstream/main'
}

/** Merge base of HEAD and the given ref, or null when it cannot be resolved. */
export function resolveMergeBase(ref, cwd = REPO_ROOT) {
  try {
    return git(['merge-base', 'HEAD', ref], cwd).trim() || null
  } catch {
    return null
  }
}

/** Collect the working-tree surface against a base commit. */
export function collectSurface(repoRoot, base) {
  const numstat = parseNumstat(git(['diff', '--numstat', '-M', base], repoRoot))
  const untracked = git(['ls-files', '--others', '--exclude-standard'], repoRoot)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const baseFiles = new Set(
    git(['ls-tree', '-r', '--name-only', base], repoRoot)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const surface = buildSurface({ numstat, untracked, existsAtBase: (path) => baseFiles.has(path) })
  return { surface, numstat, untracked }
}

/* ------------------------------------------------------------------ *
 * Budget file
 * ------------------------------------------------------------------ */

export function readBudget(budgetPath = BUDGET_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(budgetPath, 'utf8'))
    return {
      base: parsed?.base ?? '',
      files: parsed?.files ?? {},
      addedOutsideDesk: Array.isArray(parsed?.addedOutsideDesk) ? parsed.addedOutsideDesk : [],
    }
  } catch {
    return { base: '', files: {}, addedOutsideDesk: [] }
  }
}

/** Rebuild a budget from the current surface, preserving category and note. */
export function buildBudget(surface, existingBudget, base) {
  const files = {}
  for (const [path, entry] of Object.entries(surface.files)) {
    const previous = existingBudget?.files?.[path]
    files[path] = {
      added: entry.added,
      removed: entry.removed,
      category: previous?.category ?? '?',
      note: previous?.note ?? '',
    }
  }
  return {
    base,
    files,
    addedOutsideDesk: [...surface.addedOutsideDesk].sort(),
  }
}

function writeBudget(budget, budgetPath = BUDGET_PATH) {
  writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Human report
 * ------------------------------------------------------------------ */

export function summarizeByCategory(surface, budget) {
  const summary = new Map()
  for (const category of CATEGORIES) {
    summary.set(category, { files: 0, added: 0, removed: 0, paths: [] })
  }
  for (const [path, entry] of Object.entries(surface.files)) {
    const category = budget?.files?.[path]?.category ?? '?'
    const bucket = summary.get(category) ?? { files: 0, added: 0, removed: 0, paths: [] }
    bucket.files += 1
    bucket.added += entry.added
    bucket.removed += entry.removed
    bucket.paths.push(path)
    if (!summary.has(category)) summary.set(category, bucket)
  }
  return summary
}

function printHuman(surface, budget, result, base) {
  const lines = []
  const totalFiles = Object.keys(surface.files).length
  const totalAdded = Object.values(surface.files).reduce((sum, e) => sum + e.added, 0)
  const totalRemoved = Object.values(surface.files).reduce((sum, e) => sum + e.removed, 0)

  lines.push(`Upstream surface vs ${base.slice(0, 12)}`)
  lines.push(`  ${totalFiles} base files changed · +${totalAdded} / −${totalRemoved}`)
  lines.push('')

  const summary = summarizeByCategory(surface, budget)
  for (const category of [...CATEGORIES, '?']) {
    const bucket = summary.get(category)
    if (!bucket || bucket.files === 0) continue
    lines.push(CATEGORY_LABELS[category] ?? `${category} — uncategorised`)
    for (const path of [...bucket.paths].sort()) {
      const entry = surface.files[path]
      lines.push(`  ${path.padEnd(52)} ${`+${entry.added}`.padStart(6)} ${`−${entry.removed}`.padStart(6)}`)
    }
    lines.push(`  ${'subtotal'.padEnd(52)} ${`+${bucket.added}`.padStart(6)} ${`−${bucket.removed}`.padStart(6)}  (${bucket.files} files)`)
    lines.push('')
  }

  lines.push(`Added outside desk: ${surface.addedOutsideDesk.length} files (ratcheted, no merge conflict)`)
  for (const path of surface.addedOutsideDesk) lines.push(`  ${path}`)
  lines.push('')

  if (result.slack.length) {
    lines.push(`Slack (below budget, ${result.slack.length} files):`)
    for (const item of result.slack) {
      lines.push(`  ${item.path.padEnd(52)} +${item.added}/${item.budgetAdded}  −${item.removed}/${item.budgetRemoved}`)
    }
    lines.push('')
  }

  if (result.violations.length) {
    lines.push(`Budget violations (${result.violations.length}):`)
    for (const violation of result.violations) {
      lines.push(`  [${violation.type}] ${violation.path}`)
    }
    lines.push('')
  }

  lines.push(result.ok ? 'OK — upstream surface is inside the budget.' : 'FAIL — upstream surface budget tripped.')
  process.stdout.write(`${lines.join('\n')}\n`)
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function main(argv = process.argv.slice(2), env = process.env) {
  const write = argv.includes('--write')
  const asJson = argv.includes('--json')

  const ref = resolveBaseRef(argv, env)
  const base = resolveMergeBase(ref)
  if (!base) {
    process.stderr.write(`upstream-surface: cannot resolve merge base for ref "${ref}"\n`)
    return 2
  }

  const { surface } = collectSurface(REPO_ROOT, base)
  const budget = readBudget()
  const result = checkBudget(surface, budget)

  if (write) {
    const nextBudget = buildBudget(surface, budget, base)
    writeBudget(nextBudget)
    const refreshed = checkBudget(surface, nextBudget)
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: refreshed.ok, base, files: nextBudget.files, addedOutsideDesk: nextBudget.addedOutsideDesk, violations: refreshed.violations, slack: refreshed.slack }, null, 2)}\n`,
      )
      return refreshed.ok ? 0 : 1
    }
    printHuman(surface, nextBudget, refreshed, base)
    return refreshed.ok ? 0 : 1
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: result.ok, base, files: surface.files, addedOutsideDesk: surface.addedOutsideDesk, violations: result.violations, slack: result.slack }, null, 2)}\n`,
    )
    return result.ok ? 0 : 1
  }

  printHuman(surface, budget, result, base)
  return result.ok ? 0 : 1
}

if (isDirectInvocation(import.meta.url)) {
  process.exit(main())
}
