/**
 * SentinelDesk import boundary ratchet.
 *
 * Goal: keep the fork add-on from leaking further into the upstream AgentOS
 * base. Strict rules cannot be waived; ratchet rules are allowlisted and the
 * allowlist is regenerated only on explicit request (`--write`), so the set of
 * tolerated legacy edges can only shrink by hand.
 *
 * Rules
 *   strict:desk-core->base   sentinel-desk/** must not import base internals.
 *                             Allowlistable, but every entry needs a non-empty
 *                             note (transitional exceptions must be written down).
 *   strict:base->desk-core   the base may only enter sentinel-desk/** through
 *                             sentinel-desk/adapters/agentos/**. Never allowlistable.
 *   strict:core-no-runtime   sentinel-desk/core/** must not import electron,
 *                             react or react-dom. Never allowlistable.
 *   strict:desk-core->adapter  desk layers must not depend on a host adapter
 *                             (only the reverse). Never allowlistable.
 *   ratchet:desk-legacy->base  legacy desk code importing base. Allowlistable.
 *   ratchet:base->desk-legacy  base code importing legacy desk code. Allowlistable.
 *
 * CLI: node sentinel-desk/scripts/desk-boundary.mjs [--write] [--json]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import {
  classifyPath,
  isDeskCorePath,
  isDirectInvocation,
  isTestPath,
  normalizePath,
} from './desk-paths.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(scriptDir, '..', '..')
export const ALLOWLIST_PATH = resolve(REPO_ROOT, 'sentinel-desk', 'boundary-allowlist.json')

const SCAN_ROOTS = ['src', 'electron', 'sentinel-desk']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'coverage', '.git'])

/** Packages that must never appear under sentinel-desk/core/**. */
export const CORE_FORBIDDEN_PACKAGES = ['electron', 'react', 'react-dom']

export const RULES = {
  'strict:desk-core->base': { allowlistable: true, needsNote: true },
  'strict:base->desk-core': { allowlistable: false, needsNote: false },
  'strict:core-no-runtime': { allowlistable: false, needsNote: false },
  'strict:desk-core->adapter': { allowlistable: false, needsNote: false },
  'ratchet:desk-legacy->base': { allowlistable: true, needsNote: false },
  'ratchet:base->desk-legacy': { allowlistable: true, needsNote: false },
}

function matchesPackage(specifier, root) {
  return specifier === root || specifier.startsWith(`${root}/`)
}

/**
 * All rules that apply to one edge.
 * @returns {{rule:string, allowlistable:boolean, needsNote:boolean}[]}
 */
export function rulesForEdge(edge) {
  const from = normalizePath(edge.from)
  const to = normalizePath(edge.to)
  const fromClass = classifyPath(from)
  const toClass = edge.kind === 'package' ? null : classifyPath(to)
  const applied = []

  if (fromClass === 'desk-core' && toClass === 'base') {
    applied.push('strict:desk-core->base')
  }
  if (fromClass === 'base' && toClass === 'desk-core') {
    applied.push('strict:base->desk-core')
  }
  if (fromClass === 'desk-core' && toClass === 'desk-adapter') {
    applied.push('strict:desk-core->adapter')
  }
  if (fromClass === 'desk-core' && isDeskCorePath(from) && edge.kind === 'package') {
    if (CORE_FORBIDDEN_PACKAGES.some((pkg) => matchesPackage(to, pkg))) {
      applied.push('strict:core-no-runtime')
    }
  }
  if (fromClass === 'desk-legacy' && toClass === 'base') {
    applied.push('ratchet:desk-legacy->base')
  }
  if (fromClass === 'base' && toClass === 'desk-legacy') {
    applied.push('ratchet:base->desk-legacy')
  }

  return applied.map((rule) => ({ rule, ...RULES[rule] }))
}

function edgeKey(rule, from, to) {
  return `${rule}\u0000${from}\u0000${to}`
}

/** Extensions tried when a relative specifier has no file extension. */
export const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '.css']
const INDEX_CANDIDATES = ['index.ts', 'index.tsx']

function toPosix(value) {
  return value.split(/[\\/]/).join('/')
}

function walkFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkFiles(abs, out)
    } else if (entry.isFile() && SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(abs)
    }
  }
  return out
}

/** Extract every import specifier (static, type-only, re-export, dynamic). */
export function extractSpecifiers(source) {
  try {
    const info = ts.preProcessFile(source, true, true)
    return info.importedFiles.map((file) => file.fileName).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Resolve a relative specifier to a repo-relative file path.
 * @returns {string|null} null when the target does not exist
 */
export function resolveRelative(repoRoot, fromRelPath, specifier) {
  const baseDir = dirname(join(repoRoot, fromRelPath))
  const target = resolve(baseDir, specifier)
  const candidates = [
    target,
    ...RESOLVE_EXTENSIONS.map((ext) => `${target}${ext}`),
    ...INDEX_CANDIDATES.map((name) => join(target, name)),
  ]
  for (const candidate of candidates) {
    // Never follow a specifier out of the repository root.
    const rel = relative(repoRoot, candidate)
    if (rel.startsWith('..')) continue
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return toPosix(rel)
      }
    } catch {
      // ignore unreadable candidates
    }
  }
  return null
}

/**
 * Collect every import edge under src/, electron/ and sentinel-desk/.
 * Test files are skipped: they are exempt from the boundary rules.
 * @param {string} repoRoot
 * @returns {{from:string,to:string,specifier:string,kind:'relative'|'package'}[]}
 */
export function collectImportEdges(repoRoot) {
  const root = resolve(repoRoot)
  const files = []
  for (const scanRoot of SCAN_ROOTS) walkFiles(join(root, scanRoot), files)

  const edges = []
  const seen = new Set()

  for (const abs of files) {
    const rel = toPosix(relative(root, abs))
    if (isTestPath(rel)) continue

    let source = ''
    try {
      source = readFileSync(abs, 'utf8')
    } catch {
      continue
    }

    for (const specifier of extractSpecifiers(source)) {
      let edge = null
      if (specifier.startsWith('.')) {
        const to = resolveRelative(root, rel, specifier)
        if (!to) continue
        edge = { from: rel, to, specifier, kind: 'relative' }
      } else {
        edge = { from: rel, to: specifier, specifier, kind: 'package' }
      }
      const key = `${edge.from}\u0000${edge.to}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(edge)
    }
  }

  return edges
}

/**
 * Evaluate collected edges against an allowlist.
 * @param {object[]} edges
 * @param {{entries?: object[]}} allowlist
 */
export function evaluateBoundary(edges, allowlist) {
  const violations = []
  const stale = []
  const seen = new Set()

  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : []
  const allowed = new Map()
  for (const entry of entries) {
    allowed.set(edgeKey(entry.rule, normalizePath(entry.from), normalizePath(entry.to)), entry)
  }

  for (const edge of edges) {
    for (const applied of rulesForEdge(edge)) {
      const key = edgeKey(applied.rule, edge.from, edge.to)
      seen.add(key)

      const entry = allowed.get(key)
      if (!entry) {
        violations.push({
          rule: applied.rule,
          from: edge.from,
          to: edge.to,
          specifier: edge.specifier,
          kind: edge.kind,
          allowlistable: applied.allowlistable,
          reason: 'not-allowlisted',
        })
        continue
      }
      if (!applied.allowlistable) {
        violations.push({
          rule: applied.rule,
          from: edge.from,
          to: edge.to,
          specifier: edge.specifier,
          kind: edge.kind,
          allowlistable: applied.allowlistable,
          reason: 'rule-not-allowlistable',
        })
        continue
      }
      if (applied.needsNote && !String(entry.note ?? '').trim()) {
        violations.push({
          rule: applied.rule,
          from: edge.from,
          to: edge.to,
          specifier: edge.specifier,
          kind: edge.kind,
          allowlistable: applied.allowlistable,
          reason: 'missing-note',
        })
      }
    }
  }

  for (const [key, entry] of allowed) {
    if (!seen.has(key)) {
      stale.push({
        rule: entry.rule,
        from: normalizePath(entry.from),
        to: normalizePath(entry.to),
        note: entry.note ?? '',
      })
    }
  }

  stale.sort((a, b) => a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  return { violations, stale, ok: violations.length === 0 && stale.length === 0 }
}

/**
 * Rebuild the allowlist from the observed allowlistable edges.
 * Existing notes are preserved; new edges get a default note (or an empty
 * note where the rule demands a human written one).
 */
export function buildAllowlistEntries(edges, existingAllowlist) {
  const existing = new Map()
  for (const entry of existingAllowlist?.entries ?? []) {
    existing.set(edgeKey(entry.rule, normalizePath(entry.from), normalizePath(entry.to)), entry)
  }

  const entries = []
  for (const edge of edges) {
    for (const applied of rulesForEdge(edge)) {
      if (!applied.allowlistable) continue
      const key = edgeKey(applied.rule, edge.from, edge.to)
      const previous = existing.get(key)
      entries.push({
        rule: applied.rule,
        from: edge.from,
        to: edge.to,
        note: previous?.note ?? DEFAULT_NOTES[applied.rule] ?? '',
      })
    }
  }

  entries.sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
  return entries
}

export const DEFAULT_NOTES = {
  'ratchet:desk-legacy->base':
    'legacy desk code reaches into the base; migrate to sentinel-desk/core in P2',
  'ratchet:base->desk-legacy':
    'base host slot reaches into legacy desk code; migrate to sentinel-desk/adapters in P2',
}

function readAllowlist() {
  try {
    const raw = readFileSync(ALLOWLIST_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [] }
  } catch {
    return { entries: [] }
  }
}

function writeAllowlist(entries) {
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8')
}

function printHuman(result, edgeCount, allowlistCount, scannedFiles) {
  const lines = []
  lines.push('SentinelDesk import boundary')
  lines.push(`  scanned files : ${scannedFiles}`)
  lines.push(`  import edges  : ${edgeCount}`)
  lines.push(`  allowlist     : ${allowlistCount} entries`)
  lines.push(`  violations    : ${result.violations.length}`)
  lines.push(`  stale entries : ${result.stale.length}`)

  if (result.violations.length) {
    lines.push('')
    lines.push('Violations:')
    for (const violation of result.violations) {
      lines.push(`  [${violation.rule}] ${violation.from} -> ${violation.to}  (${violation.reason})`)
    }
  }

  if (result.stale.length) {
    lines.push('')
    lines.push('Stale allowlist entries (edge no longer exists):')
    for (const entry of result.stale) {
      lines.push(`  [${entry.rule}] ${entry.from} -> ${entry.to}`)
    }
  }

  lines.push('')
  lines.push(result.ok ? 'OK — no new forbidden import edges.' : 'FAIL — boundary ratchet tripped.')
  process.stdout.write(`${lines.join('\n')}\n`)
}

export function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write')
  const asJson = argv.includes('--json')

  const edges = collectImportEdges(REPO_ROOT)
  const allowlist = readAllowlist()
  const result = evaluateBoundary(edges, allowlist)

  if (write) {
    const entries = buildAllowlistEntries(edges, allowlist)
    writeAllowlist(entries)
    const refreshed = evaluateBoundary(edges, { entries })
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: refreshed.ok, edges: edges.length, allowlistEntries: entries.length, violations: refreshed.violations, stale: refreshed.stale }, null, 2)}\n`,
      )
      return refreshed.ok ? 0 : 1
    }
    printHuman(refreshed, edges.length, entries.length, countScannedFiles(REPO_ROOT))
    return refreshed.ok ? 0 : 1
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: result.ok, edges: edges.length, allowlistEntries: allowlist.entries.length, violations: result.violations, stale: result.stale }, null, 2)}\n`,
    )
    return result.ok ? 0 : 1
  }

  printHuman(result, edges.length, allowlist.entries.length, countScannedFiles(REPO_ROOT))
  return result.ok ? 0 : 1
}

function countScannedFiles(repoRoot) {
  const files = []
  for (const scanRoot of SCAN_ROOTS) walkFiles(join(repoRoot, scanRoot), files)
  return files.length
}

if (isDirectInvocation(import.meta.url)) {
  process.exit(main())
}
