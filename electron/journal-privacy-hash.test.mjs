import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
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
  const source = readFileSync(resolvedPath, 'utf8').replace(/\bimport\.meta\.env\b/g, '({})')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: resolvedPath,
  })
  const module = { exports: {} }
  cache.set(resolvedPath, module)
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const candidateTs = resolve(
        dirname(resolvedPath),
        specifier.endsWith('.ts') ? specifier : `${specifier}.ts`,
      )
      if (existsSync(candidateTs)) return loadTsModule(candidateTs, cache)
      const candidate = resolve(dirname(resolvedPath), specifier)
      if (existsSync(candidate)) return loadTsModule(candidate, cache)
    }
    return require(specifier)
  }
  Function('exports', 'module', 'require', outputText)(module.exports, module, localRequire)
  return module.exports
}

const BASE_ENTRY = {
  id: 'je_1',
  date: '2026-11-21',
  time: '21:06',
  ts: '2026-11-21T13:06:00.000Z',
  kind: 'note',
  body: '修复时间日记竖版图片上下裁切问题',
  category: '工程',
  tags: [],
  projectRefs: [],
  source: 'local',
  provenance: 'human',
  images: [],
}

function okJsonPayload() {
  return JSON.stringify({
    ignoredNoiseCount: 0,
    todos: [
      {
        matchesExistingId: null,
        title: '修复竖版图片裁切',
        reason: '视觉缺陷',
        track: 'engineering',
        urgency: 'medium',
        suggestedProjectName: null,
        antiPatterns: [],
        anchorEntryIds: ['je_1'],
        suggestedDoneSha: null,
        suggestedDoneMessage: null,
      },
    ],
  })
}

async function runAnalyzer(entries, processed) {
  const analyzer = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-analyzer.ts'))
  let llmCalls = 0
  const res = await analyzer.runIntentTodoAnalysis({
    journalStore: {
      async getDay() {
        return { ok: true, entries }
      },
    },
    projects: [],
    processedEntryHashes: processed?.hashes ?? {},
    processedEntryBodies: processed?.bodies ?? {},
    openItems: [],
    droppedFingerprints: [],
    resolvedConfig: {
      authToken: 'tok',
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      model: 'MiniMax-M3.1-Flash',
    },
    providerName: 'MiniMax-CN',
    targetDate: '2026-11-21',
    now: new Date('2026-11-21T13:10:00Z'),
    callLlm: async () => {
      llmCalls += 1
      return { ok: true, text: okJsonPayload(), model: 'MiniMax-M3.1-Flash', durationMs: 5 }
    },
  })
  return { res, llmCalls }
}

test('hash: an auto-applied private mark does not change the entry content hash', () => {
  const privacy = loadTsModule(resolve(rootDir, 'electron/desk/journal-privacy.ts'))

  const plain = privacy.computeJournalEntryContentHash(BASE_ENTRY)
  const aiPrivate = privacy.computeJournalEntryContentHash({
    ...BASE_ENTRY,
    private: true,
    autoApplied: { private: true, pipeline: 'p1' },
  })
  assert.equal(aiPrivate, plain, 'an AI-applied private mark must not change the entry identity')

  const userPrivate = privacy.computeJournalEntryContentHash({
    ...BASE_ENTRY,
    private: true,
  })
  assert.notEqual(userPrivate, plain, 'a user-authored private flag still changes the identity')

  const aiPrivateWithoutFlag = privacy.computeJournalEntryContentHash({
    ...BASE_ENTRY,
    autoApplied: { projectRefs: ['AgentOS'] },
  })
  assert.equal(aiPrivateWithoutFlag, plain, 'an AI project ref must not change the entry identity')
})

test('hash: the body hash is immune to category, tags, project refs and the private flag', () => {
  const privacy = loadTsModule(resolve(rootDir, 'electron/desk/journal-privacy.ts'))

  const base = privacy.computeJournalEntryBodyHash(BASE_ENTRY)
  const reclassified = privacy.computeJournalEntryBodyHash({
    ...BASE_ENTRY,
    category: '学习',
    tags: ['x'],
    projectRefs: ['AgentOS'],
    private: true,
  })
  assert.equal(reclassified, base, 'metadata-only edits must not change the body hash')

  const edited = privacy.computeJournalEntryBodyHash({ ...BASE_ENTRY, body: '换了一个说法' })
  assert.notEqual(edited, base, 'a real body edit must change the body hash')

  const otherDay = privacy.computeJournalEntryBodyHash({ ...BASE_ENTRY, date: '2026-11-22' })
  assert.notEqual(otherDay, base, 'the body hash must be scoped to the calendar day')
})

test('analyzer: re-classifying a processed entry does not re-analyze it', async () => {
  const first = await runAnalyzer([{ ...BASE_ENTRY }])
  assert.equal(first.llmCalls, 1)
  assert.equal(first.res.ok, true)

  const processed = {
    hashes: Object.fromEntries(first.res.processedHashes.map((h) => [h, '2026-11-21T13:10:00.000Z'])),
    bodies: Object.fromEntries(first.res.processedBodyHashes.map((h) => [h, '2026-11-21T13:10:00.000Z'])),
  }
  assert.equal(processed.bodies[Object.keys(processed.bodies)[0]], '2026-11-21T13:10:00.000Z')

  const second = await runAnalyzer([{ ...BASE_ENTRY, category: '学习', tags: ['复盘'] }], processed)
  assert.equal(second.llmCalls, 0, 'a metadata-only edit must not spend another LLM call')
  assert.equal(second.res.stats.newHumanEntries, 0)
})

test('analyzer: auto-tagging an entry private does not re-analyze it', async () => {
  const first = await runAnalyzer([{ ...BASE_ENTRY }])
  assert.equal(first.llmCalls, 1)

  const processed = {
    hashes: Object.fromEntries(first.res.processedHashes.map((h) => [h, '2026-11-21T13:10:00.000Z'])),
    bodies: Object.fromEntries(first.res.processedBodyHashes.map((h) => [h, '2026-11-21T13:10:00.000Z'])),
  }

  const second = await runAnalyzer(
    [{ ...BASE_ENTRY, private: true, autoApplied: { private: true, pipeline: 'p1' } }],
    processed,
  )
  assert.equal(second.llmCalls, 0, 'the auto-tagger must not trigger a duplicate analysis')
  assert.equal(second.res.stats.skippedPrivate, 1)
})

test('analyzer: a user-marked private entry stays out, and un-marking it brings it back', async () => {
  const first = await runAnalyzer([{ ...BASE_ENTRY, private: true }])
  assert.equal(first.llmCalls, 0, 'a private entry must never reach the LLM')
  assert.equal(first.res.stats.skippedPrivate, 1)

  const processed = {
    hashes: Object.fromEntries(first.res.processedHashes.map((h) => [h, '2026-11-21T13:10:00.000Z'])),
    bodies: Object.fromEntries(first.res.processedBodyHashes.map((h) => [h, '2026-11-21T13:10:00.000Z'])),
  }
  assert.deepEqual(processed.bodies, {}, 'a private entry must not burn its body hash')

  const second = await runAnalyzer([{ ...BASE_ENTRY, private: false }], processed)
  assert.equal(second.llmCalls, 1, 'un-marking private must let the entry be analyzed')
})

test('store: processedEntryBodies survives a state round-trip', async () => {
  const { IntentTodoStore } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-store.ts'))
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const userDataPath = mkdtempSync(join(tmpdir(), 'intent-bodies-ud-'))
  try {
    const store = new IntentTodoStore({ userDataPath })
    await store.mergeAnalysisResult({
      logicalDate: '2026-11-21',
      ranAt: '2026-11-21T13:10:00.000Z',
      providerName: 'MiniMax-CN',
      modelUsed: 'MiniMax-M3.1-Flash',
      processedHashes: ['h1'],
      processedBodyHashes: ['b1'],
      candidates: [],
      stats: {
        scannedEntries: 1,
        newHumanEntries: 1,
        skippedPrivate: 0,
        suspectedAiPaste: 0,
        ignoredNoiseCount: 0,
        durationMs: 5,
      },
    })

    assert.equal(store.getProcessedEntryBodies()['b1'], '2026-11-21T13:10:00.000Z')
    assert.equal(store.getProcessedEntryHashes()['h1'], '2026-11-21T13:10:00.000Z')

    const reloaded = new IntentTodoStore({ userDataPath })
    assert.equal(reloaded.getProcessedEntryBodies()['b1'], '2026-11-21T13:10:00.000Z')
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
