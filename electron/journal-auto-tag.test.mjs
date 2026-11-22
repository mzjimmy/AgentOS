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

const DATE = '2026-11-22'
const LOCAL_MODEL = 'cloudflare_clef-flash'

function makeEntry(overrides = {}) {
  return {
    id: 'je_1',
    date: DATE,
    time: '08:12',
    ts: '2026-11-22T00:12:00.000Z',
    kind: 'note',
    body: '在 AgentOS 时间日记里修复竖版图片上下裁切问题',
    category: '未归类',
    tags: [],
    projectRefs: [],
    source: 'feishu',
    provenance: 'human',
    images: [],
    ...overrides,
  }
}

/**
 * Fake LAN + optional JEV fetch handler for v2 auto-tagger tests.
 */
function createFakeFetch({
  reachable = true,
  localPrivacy = 'public',
  localStep2 = { category: '工程', projectCode: 'C1', entryKind: 'actionable' },
  jevAnswers = null,
} = {}) {
  const calls = []
  const fetchFn = async (input, init) => {
    const url = String(input)
    const bodyText = String(init?.body ?? '')
    calls.push({ url, method: init?.method ?? 'GET', bodyText })

    if (url.includes('typesafe.ai')) {
      if (!jevAnswers) return new Response(JSON.stringify({ error: 'unexpected cloud call' }), { status: 500 })
      const resolved = typeof jevAnswers === 'function' ? jevAnswers(JSON.parse(bodyText)) : jevAnswers
      return new Response(JSON.stringify({ answers: resolved }), { status: 200 })
    }

    if (!reachable) throw new Error('ECONNREFUSED')
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: LOCAL_MODEL }] }), { status: 200 })
    }

    const body = JSON.parse(bodyText || '{}')
    const schemaName = body?.response_format?.json_schema?.name
    if (schemaName === 'journal_auto_tag_step2') {
      const payload = typeof localStep2 === 'function' ? localStep2(body) : localStep2
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
        status: 200,
      })
    }

    const answer = typeof localPrivacy === 'function' ? localPrivacy(body) : localPrivacy
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer }) } }] }), {
      status: 200,
    })
  }
  return { calls, fetchFn }
}

function createHarness({ entries, reachable = true, localPrivacy, localStep2, jevAnswers, jevApiKey = null, projects } = {}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'auto-tag-v2-ud-'))
  const model = createFakeFetch({ reachable, localPrivacy, localStep2, jevAnswers })
  const store = {
    day: [...(entries ?? [makeEntry()])],
    updates: [],
    async getDay() {
      return { ok: true, entries: this.day.map((e) => ({ ...e })) }
    },
    async updateEntry(date, entryId, patch) {
      this.updates.push({ date, entryId, patch })
      const index = this.day.findIndex((e) => e.id === entryId)
      if (index === -1) return { ok: false, error: 'not found' }
      const updated = { ...this.day[index], ...patch }
      this.day[index] = updated
      return { ok: true, entry: updated }
    },
  }

  const { JournalAutoTagService } = loadTsModule(resolve(rootDir, 'electron/desk/journal-auto-tag-service.ts'))
  const service = new JournalAutoTagService({
    userDataPath,
    journalStore: store,
    getWorkspaceState: () => ({
      projects: projects ?? [{ id: 'p1', name: '【Mitchi Sentinel】AgentOS', path: '/tmp/【Mitchi Sentinel】AgentOS' }],
    }),
    fetchFn: model.fetchFn,
    jevApiKey,
    now: () => new Date('2026-11-22T02:00:00Z'),
  })

  return {
    service,
    store,
    model,
    cleanup: () => rmSync(userDataPath, { recursive: true, force: true }),
  }
}

test('auto-tag v2: default engine is local-only and unreachable local skips silently with zero cloud egress', async () => {
  const h = createHarness({ reachable: false, jevApiKey: 'jev_test_key' })
  try {
    assert.equal(h.service.getStatus().config.engine, 'local')
    const result = await h.service.runAutoTag({ date: DATE })
    assert.equal(result.status, 'local_unreachable')
    assert.equal(result.changed, 0)
    assert.equal(h.store.updates.length, 0)
    for (const call of h.model.calls) {
      assert.doesNotMatch(call.url, /typesafe\.ai/, 'default local mode must never touch cloud')
    }
  } finally {
    h.cleanup()
  }
})

test('auto-tag v2: local-decision-client stays strictly cloud-free', () => {
  for (const file of ['electron/desk/local-decision-client.ts', 'electron/desk/journal-auto-tag-store.ts', 'electron/desk/project-match-tokens.ts']) {
    const source = readFileSync(resolve(rootDir, file), 'utf8')
    assert.doesNotMatch(source, /typesafe\.ai/i, `${file} must not reference cloud host`)
    assert.doesNotMatch(source, /JEV_API_KEY|TYPESAFE_API_KEY/, `${file} must not read cloud keys`)
  }
})

test('auto-tag v2: Step 1 deterministic address/phone gate marks private locally with ZERO network calls', async () => {
  const h = createHarness({
    entries: [
      makeEntry({
        id: 'je_addr',
        body: '明天去上海市徐汇区漕溪北路88号复查体检，手机号13812345678',
      }),
    ],
    jevApiKey: 'jev_test_key',
  })
  try {
    h.service.saveConfig({ engine: 'jev' })
    const result = await h.service.runAutoTag({ date: DATE })
    assert.equal(result.status, 'completed')
    assert.equal(result.changed, 1)
    assert.equal(h.model.calls.length, 0, 'explicit address/phone must be caught locally before any network call')
    const patch = h.store.updates[0].patch
    assert.equal(patch.private, true)
    assert.equal(patch.category, '身体')
    assert.equal(patch.projectRefs, undefined, 'private entry must not bind workspace projects')
  } finally {
    h.cleanup()
  }
})

test('auto-tag v2: Step 1 privacy runs FIRST and short-circuits Step 2 project matching when private', async () => {
  const h = createHarness({
    entries: [makeEntry({ id: 'je_priv', body: '晚上和家人因为买房贷款吵架失眠了' })],
    localPrivacy: 'private',
    localStep2: { category: '工程', projectCode: 'C1', entryKind: 'actionable' },
  })
  try {
    const result = await h.service.runAutoTag({ date: DATE })
    assert.equal(result.status, 'completed')
    assert.equal(result.changed, 1)
    const postCalls = h.model.calls.filter((c) => c.method === 'POST')
    assert.equal(postCalls.length, 1, 'must short-circuit after Step 1 privacy without calling Step 2')
    const patch = h.store.updates[0].patch
    assert.equal(patch.private, true)
    assert.equal(patch.projectRefs, undefined)
    assert.equal(patch.autoApplied.private, true)
  } finally {
    h.cleanup()
  }
})

test('auto-tag v2: Step 2 upgrades 未归类 category, binds canonical project (including project #9+), and tags prompt_log', async () => {
  const nineProjects = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Project-${i + 1}`,
    path: `/tmp/Project-${i + 1}`,
  }))
  nineProjects.push({
    id: 'p9',
    name: '【202611-1】wechat-article-spider',
    path: '/tmp/【202611-1】wechat-article-spider',
  })

  const h = createHarness({
    projects: nineProjects,
    entries: [makeEntry({ id: 'je_p9', body: '1. 请帮我修复公众号爬虫抓正文超时问题 2. 加单测' })],
    localPrivacy: 'public',
    localStep2: { category: '工程', projectCode: 'C9', entryKind: 'prompt_log' },
  })
  try {
    const result = await h.service.runAutoTag({ date: DATE })
    assert.equal(result.status, 'completed')
    assert.equal(result.changed, 1)
    const patch = h.store.updates[0].patch
    assert.equal(patch.private, undefined)
    assert.equal(patch.category, '工程')
    assert.deepEqual(patch.projectRefs, ['【202611-1】wechat-article-spider'])
    assert.deepEqual(patch.tags, ['开发履历'])
    assert.equal(patch.autoApplied.category, true)
    assert.deepEqual(patch.autoApplied.projectRefs, ['【202611-1】wechat-article-spider'])
    assert.deepEqual(patch.autoApplied.tags, ['开发履历'])
    assert.equal(patch.autoApplied.pipeline, 'v2')
  } finally {
    h.cleanup()
  }
})

test('auto-tag v2: explicit JEV engine classifies privacy, category, project & tags in one scrubbed call', async () => {
  let sentBody = ''
  const h = createHarness({
    jevApiKey: 'jev_test_key',
    entries: [
      makeEntry({
        id: 'je_jev_1',
        body: '用 sk-ant-api03-abcdefghijklmnopqrstuvwx 测试时间日记未来日期隐藏同步按钮',
      }),
    ],
    jevAnswers: (req) => {
      sentBody = req.state
      return {
        is_private: { type: 'noul', noul: 0.04 },
        category: { type: 'choice', choice: '工程', confidence: 0.99 },
        project: { type: 'choice', choice: 'C1', confidence: 0.97 },
        entry_kind: { type: 'choice', choice: 'actionable', confidence: 0.95 },
      }
    },
  })
  try {
    h.service.saveConfig({ engine: 'jev' })
    const result = await h.service.runAutoTag({ date: DATE })
    assert.equal(result.status, 'completed')
    assert.equal(result.changed, 1)
    assert.doesNotMatch(sentBody, /sk-ant-api03/, 'credentials must be scrubbed before sending to JEV')
    const patch = h.store.updates[0].patch
    assert.equal(patch.category, '工程')
    assert.deepEqual(patch.projectRefs, ['【Mitchi Sentinel】AgentOS'])
    assert.equal(patch.private, undefined)
  } finally {
    h.cleanup()
  }
})

test('auto-tag v2: a repeated run costs zero model calls and zero writes', async () => {
  const h = createHarness({
    localPrivacy: 'public',
    localStep2: { category: '工程', projectCode: 'C1', entryKind: 'actionable' },
  })
  try {
    const first = await h.service.runAutoTag({ date: DATE })
    assert.equal(first.changed, 1)
    const callsAfterFirst = h.model.calls.length

    const second = await h.service.runAutoTag({ date: DATE })
    assert.equal(second.changed, 0)
    assert.equal(h.store.updates.length, 1)
    assert.equal(h.model.calls.length, callsAfterFirst)
  } finally {
    h.cleanup()
  }
})

test('auto-tag v2: user intent always wins for category, projectRefs, private, and cleared AI private mark', async () => {
  // 1. User manually set category and projectRefs -> must not be overridden
  const withUserManual = createHarness({
    entries: [makeEntry({ category: '学习', projectRefs: ['SentinelDesk'] })],
    localPrivacy: 'public',
    localStep2: { category: '工程', projectCode: 'C1', entryKind: 'actionable' },
  })
  try {
    await withUserManual.service.runAutoTag({ date: DATE })
    assert.equal(withUserManual.store.updates.length, 0, 'manual category and projectRef must never be overridden')
  } finally {
    withUserManual.cleanup()
  }

  // 2. User already marked private -> never sent to any model
  const userPrivate = createHarness({
    entries: [
      makeEntry({ private: true }),
      makeEntry({ id: 'je_2', tags: ['私密'] }),
      makeEntry({ id: 'je_3', body: '#private 这段日记只在本机保留' }),
    ],
    localPrivacy: 'private',
  })
  try {
    await userPrivate.service.runAutoTag({ date: DATE })
    assert.equal(userPrivate.store.updates.length, 0)
    assert.equal(userPrivate.model.calls.filter((c) => c.method === 'POST').length, 0)
  } finally {
    userPrivate.cleanup()
  }

  // 3. User cleared an AI private mark -> must never come back
  const clearedAiMark = createHarness({
    entries: [
      makeEntry({
        category: '生活',
        private: false,
        autoApplied: { private: true, decidedAt: '2026-11-22T01:00:00.000Z', pipeline: 'v2' },
      }),
    ],
    localPrivacy: 'private',
  })
  try {
    await clearedAiMark.service.runAutoTag({ date: DATE })
    assert.equal(clearedAiMark.store.updates.length, 0)
  } finally {
    clearedAiMark.cleanup()
  }
})

test('auto-tag v2: autoApplied metadata (private, category, projectRefs, tags) survives markdown round-trip', async () => {
  const md = loadTsModule(resolve(rootDir, 'electron/desk/journal-markdown.ts'))
  const entry = makeEntry({
    private: false,
    category: '工程',
    projectRefs: ['【Mitchi Sentinel】AgentOS'],
    tags: ['开发履历'],
    autoApplied: {
      category: true,
      projectRefs: ['【Mitchi Sentinel】AgentOS'],
      tags: ['开发履历'],
      decidedAt: '2026-11-22T02:00:00.000Z',
      pipeline: 'v2',
    },
  })

  const serialized = md.serializeDayMarkdown(DATE, [entry])
  const parsed = md.parseDayMarkdown(DATE, serialized)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].category, '工程')
  assert.deepEqual(parsed[0].projectRefs, ['【Mitchi Sentinel】AgentOS'])
  assert.deepEqual(parsed[0].tags, ['开发履历'])
  assert.equal(parsed[0].autoApplied?.category, true)
  assert.deepEqual(parsed[0].autoApplied?.tags, ['开发履历'])
  assert.equal(parsed[0].autoApplied?.pipeline, 'v2')
})
