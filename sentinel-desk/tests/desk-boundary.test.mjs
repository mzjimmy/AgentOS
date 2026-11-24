import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { collectImportEdges, evaluateBoundary } from '../scripts/desk-boundary.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testsDir, '..', '..')
const boundaryScript = resolve(testsDir, '..', 'scripts', 'desk-boundary.mjs')
const deskPathsScript = resolve(testsDir, '..', 'scripts', 'desk-paths.mjs')

/**
 * Hand-built edge fixtures for the rule engine. These deliberately do NOT go
 * through the file scanner: the seam under test is the rule engine, so the
 * fixtures state the edge shape directly.
 */
const LEGACY_TO_BASE = {
  from: 'electron/desk/intent-todo-service.ts',
  to: 'src/claude-chat-types.ts',
  specifier: '../../src/claude-chat-types',
  kind: 'relative',
}

test('evaluateBoundary: a forbidden edge that is not allowlisted is a violation', () => {
  const result = evaluateBoundary([LEGACY_TO_BASE], { entries: [] })

  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0].rule, 'ratchet:desk-legacy->base')
  assert.equal(result.violations[0].from, 'electron/desk/intent-todo-service.ts')
  assert.equal(result.violations[0].to, 'src/claude-chat-types.ts')
  assert.deepEqual(result.stale, [])
})

test('evaluateBoundary: an allowlisted edge is accepted', () => {
  const allowlist = {
    entries: [
      {
        rule: 'ratchet:desk-legacy->base',
        from: 'electron/desk/intent-todo-service.ts',
        to: 'src/claude-chat-types.ts',
        note: 'legacy desk code still reads base chat types',
      },
    ],
  }

  const result = evaluateBoundary([LEGACY_TO_BASE], allowlist)

  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.stale, [])
})

test('evaluateBoundary: an allowlist entry that matches no edge is stale', () => {
  const allowlist = {
    entries: [
      {
        rule: 'ratchet:desk-legacy->base',
        from: 'electron/desk/removed-module.ts',
        to: 'src/gone.ts',
        note: 'the edge was deleted but the allowlist kept it',
      },
    ],
  }

  const result = evaluateBoundary([], allowlist)

  assert.equal(result.ok, false)
  assert.deepEqual(result.violations, [])
  assert.equal(result.stale.length, 1)
  assert.equal(result.stale[0].rule, 'ratchet:desk-legacy->base')
  assert.equal(result.stale[0].from, 'electron/desk/removed-module.ts')
  assert.equal(result.stale[0].to, 'src/gone.ts')
})

/**
 * C2 fixture: a miniature repo that contains every edge shape the rules
 * must judge. Written to a temp dir so the scanner never touches the real
 * tree.
 */
function createFixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'desk-boundary-'))

  const write = (relPath, content) => {
    const abs = join(root, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }

  write(
    'src/desktop-seam.ts',
    'export const DESKTOP_INVOKE_CHANNELS = { getJournalConfig: "desk:getJournalConfig" }\n',
  )
  write('sentinel-desk/main/mount.ts', 'export const mount = () => {}\n')
  write('sentinel-desk/adapters/agentos/main-host.ts', 'export const host = () => {}\n')
  write(
    'sentinel-desk/main/x.ts',
    [
      "import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'",
      'export const x = DESKTOP_INVOKE_CHANNELS',
      '',
    ].join('\n'),
  )
  write(
    'sentinel-desk/core/y.ts',
    [
      "import electron from 'electron'",
      'export async function load() {',
      "  const react = await import('react')",
      '  return { electron, react }',
      '}',
      '',
    ].join('\n'),
  )
  write(
    'src/components/A.tsx',
    [
      "import { mount } from '../../sentinel-desk/main/mount'",
      "import type { host } from '../../sentinel-desk/adapters/agentos/main-host'",
      'export const A = () => { mount(); return host }',
      '',
    ].join('\n'),
  )

  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function findEdge(edges, from, to) {
  return edges.find((edge) => edge.from === from && edge.to === to)
}

test('collectImportEdges: finds static, type-only and dynamic imports', (t) => {
  const root = createFixtureRepo(t)
  const edges = collectImportEdges(root)

  const staticEdge = findEdge(edges, 'sentinel-desk/main/x.ts', 'src/desktop-seam.ts')
  assert.ok(staticEdge, 'static import from sentinel-desk/main/x.ts must be collected')
  assert.equal(staticEdge.specifier, '../../src/desktop-seam')
  assert.equal(staticEdge.kind, 'relative')

  const typeEdge = findEdge(edges, 'src/components/A.tsx', 'sentinel-desk/adapters/agentos/main-host.ts')
  assert.ok(typeEdge, 'type-only import must be collected')

  const dynamicEdge = findEdge(edges, 'sentinel-desk/core/y.ts', 'react')
  assert.ok(dynamicEdge, 'dynamic import() must be collected')
  assert.equal(dynamicEdge.kind, 'package')

  const electronEdge = findEdge(edges, 'sentinel-desk/core/y.ts', 'electron')
  assert.ok(electronEdge, 'bare package specifier must be collected as a package edge')
  assert.equal(electronEdge.kind, 'package')
})

test('evaluateBoundary: strict rules fire on the new sentinel-desk layout', (t) => {
  const root = createFixtureRepo(t)
  const result = evaluateBoundary(collectImportEdges(root), { entries: [] })

  const rulesByEdge = new Map(result.violations.map((v) => [`${v.from} -> ${v.to}`, v.rule]))

  assert.equal(
    rulesByEdge.get('sentinel-desk/main/x.ts -> src/desktop-seam.ts'),
    'strict:desk-core->base',
    'sentinel-desk/** must not import base internals',
  )
  assert.equal(
    rulesByEdge.get('src/components/A.tsx -> sentinel-desk/main/mount.ts'),
    'strict:base->desk-core',
    'the base may only enter sentinel-desk/** through adapters/agentos',
  )
  assert.equal(
    rulesByEdge.get('sentinel-desk/core/y.ts -> electron'),
    'strict:core-no-runtime',
    'sentinel-desk/core/** must not import electron',
  )
  assert.equal(
    rulesByEdge.get('sentinel-desk/core/y.ts -> react'),
    'strict:core-no-runtime',
    'sentinel-desk/core/** must not import react',
  )
  assert.equal(
    rulesByEdge.has('src/components/A.tsx -> sentinel-desk/adapters/agentos/main-host.ts'),
    false,
    'adapters/agentos is the sanctioned door for base -> sentinel-desk',
  )
  assert.equal(result.ok, false)
})

test('evaluateBoundary: desk layers never depend on the host adapter, the adapter may depend on them', () => {
  const edge = (from, to) => ({ from, to, specifier: to, kind: 'relative' })
  const result = evaluateBoundary(
    [
      edge('sentinel-desk/main/mount.ts', 'sentinel-desk/adapters/agentos/main-host.ts'),
      edge('sentinel-desk/adapters/agentos/main-host.ts', 'sentinel-desk/main/mount.ts'),
      edge('sentinel-desk/adapters/agentos/main-host.ts', 'sentinel-desk/host/main-host.ts'),
    ],
    {
      entries: [
        {
          rule: 'strict:desk-core->adapter',
          from: 'sentinel-desk/main/mount.ts',
          to: 'sentinel-desk/adapters/agentos/main-host.ts',
          note: 'trying to waive it',
        },
      ],
    },
  )

  assert.deepEqual(
    result.violations.map((v) => [v.rule, v.from, v.reason]),
    [['strict:desk-core->adapter', 'sentinel-desk/main/mount.ts', 'rule-not-allowlistable']],
  )
})

test('evaluateBoundary: a desk-core->base allowlist entry without a note is rejected', (t) => {
  const root = createFixtureRepo(t)
  const allowlist = {
    entries: [
      {
        rule: 'strict:desk-core->base',
        from: 'sentinel-desk/main/x.ts',
        to: 'src/desktop-seam.ts',
        note: '',
      },
    ],
  }

  const result = evaluateBoundary(collectImportEdges(root), allowlist)

  const entryViolation = result.violations.find(
    (v) => v.from === 'sentinel-desk/main/x.ts' && v.to === 'src/desktop-seam.ts',
  )
  assert.ok(entryViolation, 'the edge must still be reported')
  assert.equal(entryViolation.reason, 'missing-note')
  assert.equal(result.ok, false)
})

test('boundary CLI: the current tree passes the import boundary check', () => {
  const result = spawnSync(process.execPath, [boundaryScript, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(
    result.status,
    0,
    `boundary CLI must exit 0 on the current tree\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )

  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.deepEqual(report.violations, [])
  assert.deepEqual(report.stale, [])
  assert.ok(report.edges > 0, 'the scanner must actually find import edges')
  assert.ok(report.allowlistEntries > 0, 'the ratchet baseline must be loaded')
})

test('boundary CLI: fails when the tree contains a forbidden edge', (t) => {
  // A throwaway repo that reuses the real script, so the CLI is exercised
  // end to end instead of trusting its exit code.
  const root = mkdtempSync(join(tmpdir(), 'desk-boundary-cli-'))
  const scriptsDir = join(root, 'sentinel-desk', 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  copyFileSync(boundaryScript, join(scriptsDir, 'desk-boundary.mjs'))
  copyFileSync(deskPathsScript, join(scriptsDir, 'desk-paths.mjs'))
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir')

  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'desktop-seam.ts'), 'export const seam = 1\n', 'utf8')
  mkdirSync(join(root, 'sentinel-desk', 'main'), { recursive: true })
  writeFileSync(
    join(root, 'sentinel-desk', 'main', 'x.ts'),
    "import { seam } from '../../src/desktop-seam'\nexport const x = seam\n",
    'utf8',
  )

  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = spawnSync(process.execPath, [join(scriptsDir, 'desk-boundary.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(result.status, 1, `boundary CLI must fail on a forbidden edge\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /strict:desk-core->base/)
})
