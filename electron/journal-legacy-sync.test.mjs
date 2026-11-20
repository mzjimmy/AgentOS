import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const testDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(testDir, '..')

function loadTsModule(modulePath, cache = new Map()) {
  const resolvedPath = resolve(modulePath)
  const cached = cache.get(resolvedPath)
  if (cached) return cached.exports
  const { outputText } = ts.transpileModule(readFileSync(resolvedPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: resolvedPath,
  })
  const module = { exports: {} }
  cache.set(resolvedPath, module)
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const candidateTs = resolve(dirname(resolvedPath), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`)
      if (existsSync(candidateTs)) return loadTsModule(candidateTs, cache)
      const candidate = resolve(dirname(resolvedPath), specifier)
      if (existsSync(candidate)) return loadTsModule(candidate, cache)
    }
    return require(specifier)
  }
  Function('exports', 'module', 'require', outputText)(module.exports, module, localRequire)
  return module.exports
}

function createTempLegacyDb(dbPath) {
  const schemaSql = `
    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('u1');

    CREATE TABLE journal_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      task_candidate TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      visibility TEXT NOT NULL DEFAULT 'private',
      encrypted_text TEXT,
      client_request_id TEXT,
      cloud_opt_out INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO journal_entries (id, user_id, date, timestamp, text, tags)
    VALUES
      ('legacy-1', 'u1', '2026-11-19', '2026-11-19T08:30:00.000Z', '晨读笔记，关于分布式系统', '["学习", "architecture"]'),
      ('legacy-2', 'u1', '2026-11-19', '2026-11-19T17:45:00.000Z', '完成代码审查并同步了主干', '["工作"]'),
      ('legacy-3', 'u1', '2026-11-20', '2026-11-20T09:15:00.000Z', '晨跑 5 公里，心率平稳', '["身体", "运动"]');
  `
  execFileSync('sqlite3', [dbPath, schemaSql])
}

test('legacy-sync: read-only imports entries, idempotent on second run, source DB unmodified', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
  const { syncLegacySentinelLabJournal } = loadTsModule(resolve(rootDir, 'electron/desk/legacy-sync.ts'))

  const tempDir = mkdtempSync(join(tmpdir(), 'sentinel-desk-legacy-test-'))
  const tempDbPath = join(tempDir, 'sentinellab_fixture.db')
  const tempDeskRoot = join(tempDir, 'desk')

  try {
    createTempLegacyDb(tempDbPath)

    // Record source DB mtime and file size to guarantee zero mutation
    const beforeStat = statSync(tempDbPath)

    const store = new JournalStore({ deskRoot: tempDeskRoot, legacyDbPath: tempDbPath })

    // First sync run: should import all 3 rows
    const firstResult = await syncLegacySentinelLabJournal(store, { dbPath: tempDbPath })
    assert.equal(firstResult.ok, true)
    if (!firstResult.ok) return
    assert.equal(firstResult.totalScanned, 3)
    assert.equal(firstResult.imported, 3)
    assert.equal(firstResult.skipped, 0)
    assert.equal(firstResult.latestDate, '2026-11-20')
    assert.equal(firstResult.daysTouched, 2)

    // Verify imported entries on disk
    const day19 = await store.getDay('2026-11-19')
    assert.equal(day19.ok, true)
    if (!day19.ok) return
    assert.equal(day19.entries.length, 2)
    assert.equal(day19.entries[0].source, 'sentinellab-import')
    assert.equal(day19.entries[0].category, '学习')
    assert.equal(day19.entries[0].externalId, 'sl:legacy-1')
    assert.equal(day19.entries[1].category, '工作')
    assert.equal(day19.entries[1].externalId, 'sl:legacy-2')

    const day20 = await store.getDay('2026-11-20')
    assert.equal(day20.ok, true)
    if (!day20.ok) return
    assert.equal(day20.entries.length, 1)
    assert.equal(day20.entries[0].category, '身体')
    assert.equal(day20.entries[0].externalId, 'sl:legacy-3')

    // Second sync run: MUST be 100% idempotent (imported === 0, skipped === totalScanned)
    const secondResult = await syncLegacySentinelLabJournal(store, { dbPath: tempDbPath })
    assert.equal(secondResult.ok, true)
    if (!secondResult.ok) return
    assert.equal(secondResult.totalScanned, 3)
    assert.equal(secondResult.imported, 0)
    assert.equal(secondResult.skipped, 3)
    assert.equal(secondResult.daysTouched, 0)

    // Third check: Verify source DB was never written to
    const afterStat = statSync(tempDbPath)
    assert.equal(afterStat.size, beforeStat.size)
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('legacy-sync: handles empty table gracefully', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
  const { syncLegacySentinelLabJournal } = loadTsModule(resolve(rootDir, 'electron/desk/legacy-sync.ts'))

  const tempDir = mkdtempSync(join(tmpdir(), 'sentinel-desk-legacy-empty-test-'))
  const tempDbPath = join(tempDir, 'empty.db')
  const tempDeskRoot = join(tempDir, 'desk')

  try {
    execFileSync('sqlite3', [
      tempDbPath,
      'CREATE TABLE journal_entries (id TEXT, date TEXT, timestamp TEXT, text TEXT, tags TEXT);',
    ])

    const store = new JournalStore({ deskRoot: tempDeskRoot, legacyDbPath: tempDbPath })
    const result = await syncLegacySentinelLabJournal(store, { dbPath: tempDbPath })

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.totalScanned, 0)
    assert.equal(result.imported, 0)
    assert.equal(result.skipped, 0)
    assert.equal(result.latestDate, null)
    assert.equal(result.daysTouched, 0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})


test('legacy-sync: resolves Asia/Shanghai date-aligned time and avoids ID prefix collisions', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
  const { syncLegacySentinelLabJournal, parseLegacyTimestamp } = loadTsModule(
    resolve(rootDir, 'electron/desk/legacy-sync.ts'),
  )

  // Real sentinellab.db row shape: date is Beijing 2026-11-21 while timestamp is 2026-11-20T23:00:00.000Z (= 07:00 UTC+8)
  const resolved = parseLegacyTimestamp('2026-11-21', '2026-11-20T23:00:00.000Z')
  assert.equal(resolved.time, '07:00')

  const tempDir = mkdtempSync(join(tmpdir(), 'sentinel-desk-legacy-prefix-test-'))
  const tempDbPath = join(tempDir, 'prefix.db')
  const tempDeskRoot = join(tempDir, 'desk')
  try {
    execFileSync('sqlite3', [
      tempDbPath,
      `
      CREATE TABLE journal_entries (id TEXT, date TEXT, timestamp TEXT, text TEXT, tags TEXT);
      INSERT INTO journal_entries VALUES
        ('entry_0001_alpha', '2026-11-21', '2026-11-20T23:00:00.000Z', '第一条同分钟同前缀记录', '["学习"]'),
        ('entry_0002_beta', '2026-11-21', '2026-11-20T23:00:00.000Z', '第二条同分钟同前缀记录', '["学习"]');
      `,
    ])
    const store = new JournalStore({ deskRoot: tempDeskRoot, legacyDbPath: tempDbPath })
    const res = await syncLegacySentinelLabJournal(store, { dbPath: tempDbPath })
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.imported, 2)
    const day = await store.getDay('2026-11-21')
    assert.equal(day.ok, true)
    if (!day.ok) return
    assert.equal(day.entries.length, 2)
    assert.notEqual(day.entries[0].id, day.entries[1].id)
    assert.equal(day.entries[0].time, '07:00')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
