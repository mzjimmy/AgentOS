/**
 * Shared path classifier for SentinelDesk guardrails.
 *
 * Both `desk-boundary.mjs` (import boundary) and `upstream-surface.mjs`
 * (upstream surface budget) need the same answer to one question:
 * "does this repo-relative path belong to SentinelDesk (the fork add-on)
 *  or to the upstream AgentOS base?".
 *
 * Classification buckets:
 *   desk-core    sentinel-desk/** runtime code (core/host/main/renderer),
 *                excluding adapters/agentos/**, tests/** and scripts/**
 *   desk-adapter sentinel-desk/adapters/agentos/** — the ONLY sanctioned
 *                door through which the base may reach into sentinel-desk/**
 *   desk-test    desk-owned non-runtime files: sentinel-desk/tests/**,
 *                sentinel-desk/scripts/** (guardrail tooling) and legacy desk
 *                test files. Exempt from import-boundary rules.
 *   desk-legacy  the legacy desk layout that still lives inside base dirs
 *                (electron/desk/**, src/components/<desk-module>/**, ...)
 *   base         upstream-owned files under src/ or electron/
 *   other        everything else (docs, changes/, skills/, scripts/, ...)
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const DESK_ROOT = 'sentinel-desk'
export const ADAPTER_ROOT = 'sentinel-desk/adapters/agentos'
export const CORE_ROOT = 'sentinel-desk/core'

/** Legacy desk directories (still inside base dirs, not yet moved). */
export const DESK_LEGACY_DIRS = [
  'electron/desk',
  'src/components/desk',
  'src/components/intent-todo',
  'src/components/journal',
  'src/components/language-push',
  'src/components/morning-brief',
  'src/components/outbound',
  'src/components/quick-commands',
]

/** Legacy desk contract modules (renderer/main seam contracts) and the fork-added desk slot registry. */
export const DESK_LEGACY_CONTRACTS = [
  'src/components/pinned-modules.ts',
  'src/intent-todo-contract.ts',
  'src/journal-auto-tag-contract.ts',
  'src/journal-contract.ts',
  'src/language-push-contract.ts',
  'src/morning-brief-contract.ts',
  'src/outbound-contract.ts',
  'src/quick-commands-contract.ts',
]

/** Legacy desk stylesheets. */
export const DESK_LEGACY_STYLES = [
  'src/styles/desk-audio-bar.css',
  'src/styles/desk-date-shell.css',
  'src/styles/desk-date-topbar.css',
  'src/styles/desk-tokens.css',
  'src/styles/intent-todo-page.css',
  'src/styles/journal-page.css',
  'src/styles/language-push-page.css',
  'src/styles/morning-brief-page.css',
  'src/styles/outbound-page.css',
  'src/styles/quick-commands-page.css',
]

/**
 * Keywords that identify a legacy test file as belonging to a desk module.
 * Kept next to the legacy path tables so both stay in sync.
 */
export const DESK_MODULE_KEYWORDS = [
  'desk',
  'feishu-journal',
  'intent-todo',
  'journal',
  'language-push',
  'main-window-bounds',
  'morning-brief',
  'outbound',
  'quick-commands',
]

const TEST_FILE_RE = /(^|\.)(test|spec)\.(mjs|cjs|js|ts|tsx|mts|cts)$/

/** Normalise a repo-relative path: forward slashes, no leading "./". */
export function normalizePath(repoRelPath) {
  if (typeof repoRelPath !== 'string') return ''
  return repoRelPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * True when the current module is the process entry point.
 *
 * Comparing `process.argv[1]` with `import.meta.url` is not enough: macOS
 * resolves /tmp and /var to /private/tmp and /private/var, so a script
 * started through a symlinked path would look like it was *not* run directly
 * and would exit 0 without doing anything. Both sides are therefore compared
 * through realpath.
 */
export function isDirectInvocation(moduleUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

/** True when the path is a test file or lives under a test directory. */
export function isTestPath(repoRelPath) {
  const rel = normalizePath(repoRelPath)
  if (!rel) return false
  if (rel.startsWith('sentinel-desk/tests/')) return true
  return TEST_FILE_RE.test(rel)
}

function matchesDir(rel, dir) {
  return rel === dir || rel.startsWith(`${dir}/`)
}

function matchesAnyDir(rel, dirs) {
  return dirs.some((dir) => matchesDir(rel, dir))
}

/** True when the path is inside the upstream code surface (src/ or electron/). */
export function isBasePath(repoRelPath) {
  const rel = normalizePath(repoRelPath)
  return matchesAnyDir(rel, ['src', 'electron'])
}

/**
 * True when the path is desk-owned (any desk-* bucket).
 * Used by the upstream-surface budget to separate "fork added a desk file"
 * from "fork added a file into the base tree".
 */
export function isDeskOwned(repoRelPath) {
  return classifyPath(repoRelPath).startsWith('desk-')
}

/**
 * Classify a repo-relative path.
 * @param {string} repoRelPath
 * @returns {'desk-core'|'desk-adapter'|'desk-test'|'desk-legacy'|'base'|'other'}
 */
export function classifyPath(repoRelPath) {
  const rel = normalizePath(repoRelPath)
  if (!rel) return 'other'

  if (rel === DESK_ROOT || rel.startsWith(`${DESK_ROOT}/`)) {
    if (matchesDir(rel, ADAPTER_ROOT)) return 'desk-adapter'
    if (matchesDir(rel, 'sentinel-desk/tests')) return 'desk-test'
    if (matchesDir(rel, 'sentinel-desk/scripts')) return 'desk-test'
    return 'desk-core'
  }

  if (isTestPath(rel)) {
    return isLegacyDeskTest(rel) ? 'desk-test' : 'base'
  }

  if (matchesAnyDir(rel, DESK_LEGACY_DIRS)) return 'desk-legacy'
  if (DESK_LEGACY_CONTRACTS.includes(rel)) return 'desk-legacy'
  if (DESK_LEGACY_STYLES.includes(rel)) return 'desk-legacy'

  if (isBasePath(rel)) return 'base'
  return 'other'
}

/**
 * A legacy test file belongs to desk when it lives under a desk-owned dir
 * or when its filename carries a desk module keyword.
 */
export function isLegacyDeskTest(rel) {
  const normalized = normalizePath(rel)
  if (matchesAnyDir(normalized, DESK_LEGACY_DIRS)) return true
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  return DESK_MODULE_KEYWORDS.some((keyword) => fileName.includes(keyword))
}

/** True when the path lives under sentinel-desk/core/**. */
export function isDeskCorePath(repoRelPath) {
  return matchesDir(normalizePath(repoRelPath), CORE_ROOT)
}
