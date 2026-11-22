/**
 * Project name matching helpers shared by the intent analyzer and the journal
 * auto-tagger. Kept dependency-free so both callers agree on what counts as
 * "this entry mentions that project".
 */

import path from 'node:path'

export type ProjectMatchRef = {
  name: string
  path: string
}

/**
 * Strips a decorative prefix such as `【Mitchi Sentinel】AgentOS` -> `agentos`.
 */
export function stripDecorativePrefix(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^[\s【\[（(][^】\]）)]+[】\]）)]\s*/, '')
    .trim()
}

/**
 * All lowercase tokens that identify a project: its display name, its directory
 * basename, and the decorative-prefix-stripped variant of each.
 */
export function extractProjectMatchTokens(project: ProjectMatchRef): string[] {
  const rawNames = [project.name, path.basename(project.path)]
  const tokens = new Set<string>()
  for (const raw of rawNames) {
    const lower = String(raw || '').trim().toLowerCase()
    if (lower.length >= 2) tokens.add(lower)
    const stripped = stripDecorativePrefix(lower)
    if (stripped.length >= 2) tokens.add(stripped)
  }
  return Array.from(tokens)
}
