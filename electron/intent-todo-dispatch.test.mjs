import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const RAW_BODY = '不要裁切上下两端，私密内容不能给AI读'

test('dispatch: the prompt carries anchor metadata but never the raw journal text', async () => {
  const serviceMod = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))
  const { buildSafeDispatchPrompt } = serviceMod

  const item = {
    id: 'item_1',
    title: '修复竖版图片裁切',
    reason: '视觉缺陷',
    track: 'engineering',
    actionKind: 'implement',
    urgency: 'high',
    status: 'pending',
    targetSurface: '时间日记页 · 卡片图片 (JournalCard.tsx)',
    doneCriteria: '竖版图片完整显示不裁切上下两端',
    nonGoals: ['不改动意图待办页面'],
    antiPatterns: ['裁切上下'],
    anchors: [
      {
        date: '2026-11-21',
        time: '21:06',
        entryId: 'je_20261121_2106_abc123',
        contentHash: 'h1',
        flags: ['人类手写', '分类:工程', '形态:随想'],
      },
    ],
  }

  const prompt = buildSafeDispatchPrompt(item)

  assert.doesNotMatch(prompt, /<untrusted_journal_quote/, 'raw journal quotes must never be dispatched')
  assert.doesNotMatch(prompt, /不要裁切上下两端/, 'raw journal body must never be dispatched')
  assert.doesNotMatch(prompt, /私密内容不能给AI读/, 'raw journal body must never be dispatched')
  assert.match(prompt, /<ai_triage_suggestion/)
  assert.match(prompt, /2026-11-21/, 'the anchor date must survive')
  assert.match(prompt, /je_20261121_2106_abc123/, 'the anchor id must survive')
  assert.match(prompt, /人类手写/, 'anchor metadata flags must survive')
  assert.match(prompt, /修复竖版图片裁切/, 'the todo title must survive')
  assert.match(prompt, /时间日记页 · 卡片图片/, 'targetSurface must survive')
  assert.match(prompt, /竖版图片完整显示不裁切上下两端/, 'doneCriteria must survive')
  assert.match(prompt, /不改动意图待办页面/, 'nonGoals must survive')
  assert.match(prompt, /Pre-Flight Placement Gate/, 'preflight gate must be enforced')

  const designPrompt = buildSafeDispatchPrompt({
    ...item,
    actionKind: 'design',
    targetSurface: null,
  })
  assert.match(designPrompt, /严禁直接写代码/, 'design actionKind must forbid direct coding')
  assert.match(designPrompt, /归属页面\/交互表面：未定/, 'missing targetSurface must trigger explicit undecided warning')
})

test('dispatch: an item whose anchors still carry legacy quotes does not leak them', async () => {
  const serviceMod = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))
  const { buildSafeDispatchPrompt } = serviceMod

  const prompt = buildSafeDispatchPrompt({
    id: 'item_legacy',
    title: '旧条目',
    reason: '',
    track: 'engineering',
    urgency: 'medium',
    status: 'pending',
    antiPatterns: [],
    anchors: [
      {
        date: '2026-11-20',
        time: '09:00',
        entryId: 'e_legacy',
        contentHash: 'h_legacy',
        quote: RAW_BODY,
      },
    ],
  })

  assert.doesNotMatch(prompt, /不要裁切上下两端/)
  assert.doesNotMatch(prompt, /<untrusted_journal_quote/)
})

test('dispatch: no raw journal text is persisted into items.json', async () => {
  const { IntentTodoService } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))

  const userDataPath = mkdtempSync(join(tmpdir(), 'intent-dispatch-ud-'))
  const deskRoot = mkdtempSync(join(tmpdir(), 'intent-dispatch-desk-'))

  try {
    const dispatchedCalls = []
    let threadSeq = 0
    const fakeBroker = {
      async createThread() {
        threadSeq += 1
        return { ok: true, value: { threadId: `th_${threadSeq}`, workspaceRevision: threadSeq } }
      },
      async submitRun(input, context) {
        dispatchedCalls.push({ input, context })
        return { ok: true, value: { requestId: 'req_1' } }
      },
    }
    const fakeSettings = {
      getSnapshot: () => ({
        settings: {
          activeProviderId: 'minimax',
          providers: [{ id: 'minimax', name: 'MiniMax-CN', model: 'MiniMax-M3.1-Flash' }],
        },
      }),
      resolve: () => ({
        configSource: 'settings',
        apiKey: '',
        authToken: 'test-token',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M3.1-Flash',
      }),
    }

    const service = new IntentTodoService({
      userDataPath,
      journalStore: { getDeskRoot: () => deskRoot, async getDay() { return { ok: true, entries: [] } } },
      settingsStore: fakeSettings,
      getWorkspaceState: () => ({
        projects: [{ id: 'p_agentos', name: 'AgentOS', path: '/tmp/AgentOS' }],
      }),
      getBroker: () => fakeBroker,
      now: () => new Date('2026-11-22T00:10:00Z'),
    })

    const seed = await service.store.mergeAnalysisResult({
      logicalDate: '2026-11-22',
      ranAt: '2026-11-22T00:10:00.000Z',
      providerName: 'MiniMax-CN',
      modelUsed: 'MiniMax-M3.1-Flash',
      processedHashes: [],
      deskRoot,
      stats: {
        scannedEntries: 1,
        newHumanEntries: 1,
        skippedPrivate: 0,
        suspectedAiPaste: 0,
        ignoredNoiseCount: 0,
        durationMs: 5,
      },
      candidates: [
        {
          title: '修复竖版图片裁切',
          reason: '视觉缺陷',
          track: 'engineering',
          urgency: 'high',
          suggestedProjectId: 'p_agentos',
          suggestedProjectName: 'AgentOS',
          projectExplicitlyBound: true,
          antiPatterns: [],
          anchors: [
            {
              date: '2026-11-21',
              time: '21:06',
              entryId: 'je_20261121_2106_abc123',
              contentHash: 'h1',
              flags: ['人类手写'],
            },
          ],
        },
      ],
    })

    const itemsFile = join(userDataPath, 'intent-todo', 'items.json')
    assert.equal(existsSync(itemsFile), true, 'items.json must exist after merge')
    const raw = readFileSync(itemsFile, 'utf8')
    assert.doesNotMatch(raw, /不要裁切上下两端/, 'items.json must not carry journal body text')
    assert.equal(raw.includes('quote'), false, 'items.json must not carry an anchor quote field')

    const itemId = seed.createdIds[0]
    const res = await service.dispatchItem({ itemId, projectId: 'p_agentos' })
    assert.equal(res.ok, true)
    assert.equal(dispatchedCalls.length, 1)

    const text = dispatchedCalls[0].input.text
    assert.doesNotMatch(text, /不要裁切上下两端/)
    assert.doesNotMatch(text, /<untrusted_journal_quote/)
    assert.equal(dispatchedCalls[0].context?.permissionModeOverride, undefined, 'project dispatch inherits the global mode')
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(deskRoot, { recursive: true, force: true })
  }
})
