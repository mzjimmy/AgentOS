import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildSurface, checkBudget, parseNumstat } from '../scripts/upstream-surface.mjs'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testsDir, '..', '..')
const surfaceScript = resolve(testsDir, '..', 'scripts', 'upstream-surface.mjs')

test('parseNumstat: reads added/removed, marks binaries and resolves renames to the new path', () => {
  const rows = parseNumstat(
    [
      '3\t4\tsrc/a.ts',
      '-\t-\tpublic/logo.png',
      '1\t2\told/name.ts => new/name.ts',
      '7\t0\tsrc/b.ts',
    ].join('\n') + '\n',
  )

  assert.equal(rows.length, 4)
  assert.deepEqual(rows[0], { path: 'src/a.ts', added: 3, removed: 4, binary: false, renamed: false })
  assert.deepEqual(rows[1], { path: 'public/logo.png', added: 0, removed: 0, binary: true, renamed: false })
  assert.deepEqual(rows[2], { path: 'new/name.ts', added: 1, removed: 2, binary: false, renamed: true })
  assert.deepEqual(rows[3], { path: 'src/b.ts', added: 7, removed: 0, binary: false, renamed: false })
})

test('buildSurface: upstream surface only holds files that exist at base, new base files are ratcheted', () => {
  const surface = buildSurface({
    numstat: parseNumstat(
      [
        '10\t2\telectron/main.ts',
        '5\t0\tsrc/components/journal/JournalPage.tsx',
        '3\t0\tsrc/components/pinned-modules.ts',
        '4\t0\tsrc/components/sidebar-extra.ts',
        '9\t0\tchanges/active/chg-x/proposal.md',
      ].join('\n') + '\n',
    ),
    untracked: ['sentinel-desk/core/x.ts', 'electron/anthropic-messages-client.ts', '.agents/skills/x/SKILL.md'],
    existsAtBase: (path) => path === 'electron/main.ts',
  })

  assert.deepEqual(Object.keys(surface.files), ['electron/main.ts'])
  assert.deepEqual(surface.files['electron/main.ts'], { added: 10, removed: 2, binary: false })
  assert.deepEqual(
    surface.addedOutsideDesk,
    ['electron/anthropic-messages-client.ts', 'src/components/sidebar-extra.ts'],
    'only new base-dir code is ratcheted: the desk slot registry and fork docs are not',
  )
})

test('checkBudget: a file that grows past its budget fails', () => {
  const surface = { files: { 'electron/main.ts': { added: 300, removed: 20, binary: false } }, addedOutsideDesk: [] }
  const budget = {
    base: 'abc123',
    files: {
      'electron/main.ts': { added: 283, removed: 8, category: 'A', note: 'desk wiring inside a base file' },
    },
    addedOutsideDesk: [],
  }

  const result = checkBudget(surface, budget)

  assert.equal(result.ok, false)
  const over = result.violations.find((v) => v.type === 'over-budget')
  assert.ok(over, 'expected an over-budget violation')
  assert.equal(over.path, 'electron/main.ts')
  assert.equal(over.added, 300)
  assert.equal(over.budgetAdded, 283)
})

test('checkBudget: an unbudgeted upstream file fails and a vanished budget entry is stale', () => {
  const surface = {
    files: { 'electron/main.ts': { added: 1, removed: 0, binary: false } },
    addedOutsideDesk: ['electron/anthropic-messages-client.ts'],
  }
  const budget = {
    base: 'abc123',
    files: {
      'electron/preload.ts': { added: 225, removed: 0, category: 'A', note: 'desk wiring' },
    },
    addedOutsideDesk: ['scripts/old-tool.mjs'],
  }

  const result = checkBudget(surface, budget)

  assert.equal(result.ok, false)
  const types = result.violations.map((v) => v.type)
  assert.ok(types.includes('missing-entry'), 'electron/main.ts is not budgeted')
  assert.ok(types.includes('stale-entry'), 'electron/preload.ts no longer exists in the surface')
  assert.ok(types.includes('unbudgeted-addition'), 'a new file appeared outside desk')
  assert.ok(types.includes('stale-addition'), 'a budgeted addition no longer exists')
})

test('checkBudget: slack below the budget is reported but does not fail', () => {
  const surface = { files: { 'electron/main.ts': { added: 100, removed: 4, binary: false } }, addedOutsideDesk: [] }
  const budget = {
    base: 'abc123',
    files: {
      'electron/main.ts': { added: 283, removed: 8, category: 'A', note: 'desk wiring inside a base file' },
    },
    addedOutsideDesk: [],
  }

  const result = checkBudget(surface, budget)

  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
  assert.equal(result.slack.length, 1)
  assert.equal(result.slack[0].path, 'electron/main.ts')
  assert.equal(result.slack[0].added, 100)
  assert.equal(result.slack[0].budgetAdded, 283)
})

test('checkBudget: an uncategorised budget entry fails until it is labelled', () => {
  const surface = { files: { 'electron/new-file.ts': { added: 5, removed: 0, binary: false } }, addedOutsideDesk: [] }
  const budget = {
    base: 'abc123',
    files: {
      'electron/new-file.ts': { added: 5, removed: 0, category: '?', note: '' },
    },
    addedOutsideDesk: [],
  }

  const result = checkBudget(surface, budget)

  assert.equal(result.ok, false)
  assert.ok(result.violations.some((v) => v.type === 'unknown-category'))
})

test('surface CLI: the current tree stays inside the upstream-surface budget', (t) => {
  const mergeBase = spawnSync('git', ['merge-base', 'HEAD', 'upstream/main'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    t.skip('git merge-base HEAD upstream/main is unavailable in this checkout')
    return
  }

  const result = spawnSync(process.execPath, [surfaceScript, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(
    result.status,
    0,
    `surface CLI must exit 0 on the current tree\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )

  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.deepEqual(report.violations, [])
  assert.ok(Object.keys(report.files).length > 0, 'the surface must not be empty')
  assert.equal(report.base, mergeBase.stdout.trim())
})

test('surface CLI: fails when the surface no longer matches the budget', (t) => {
  const mergeBase = spawnSync('git', ['merge-base', 'HEAD', 'upstream/main'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    t.skip('git merge-base HEAD upstream/main is unavailable in this checkout')
    return
  }

  // Using HEAD as the base yields an empty diff, so every budget entry is stale.
  const result = spawnSync(process.execPath, [surfaceScript, '--base', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 1, `surface CLI must fail on a stale budget\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /stale-entry/)
})
