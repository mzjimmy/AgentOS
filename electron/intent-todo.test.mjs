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

test('intent-todo-time: Asia/Shanghai 04:00 cutover and ISO+08:00 work identically under PST/DST and Shanghai TZ', () => {
  const timeMod = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-time.ts'))
  const originalTz = process.env.TZ

  const samples = [
    // 2026-11-22 01:30 +08:00 (still before 04:00 cutover -> logical day 2026-11-21)
    { iso: '2026-11-21T17:30:00Z', expectedDate: '2026-11-22', expectedLogical: '2026-11-21', passedCutover: false },
    // 2026-11-22 04:00 +08:00 (at cutover -> logical day 2026-11-22)
    { iso: '2026-11-21T20:00:00Z', expectedDate: '2026-11-22', expectedLogical: '2026-11-22', passedCutover: true },
    // US DST fallback day: 2026-11-01 08:30 UTC -> 2026-11-01 16:30 +08:00
    { iso: '2026-11-01T08:30:00Z', expectedDate: '2026-11-01', expectedLogical: '2026-11-01', passedCutover: true },
  ]

  try {
    for (const tz of ['America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = tz
      for (const sample of samples) {
        const dt = new Date(sample.iso)
        assert.equal(timeMod.getShanghaiDateString(dt), sample.expectedDate, `tz=${tz} date`)
        assert.equal(timeMod.getShanghaiLogicalDay(dt, 4), sample.expectedLogical, `tz=${tz} logical`)
        assert.equal(timeMod.hasPassedShanghaiCutover(dt, 4), sample.passedCutover, `tz=${tz} cutover`)
      }
      assert.equal(timeMod.getShanghaiCutoverIso('2026-11-21', 4), '2026-11-21T04:00:00+08:00')
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  }
})

test('journal-privacy & Phase 0 private persistence: golden set, lossless markdown round-trip, deterministic meta-less IDs, secret scrub', async () => {
  const privacy = loadTsModule(resolve(rootDir, 'electron/desk/journal-privacy.ts'))
  const md = loadTsModule(resolve(rootDir, 'electron/desk/journal-markdown.ts'))
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))

  // Golden privacy cases (specifically catching CJK boundary cases `#私密今天…` and `今天 #私密`)
  const shouldBePrivate = [
    { body: '#私密今天去医院复查', tags: [], category: '生活' },
    { body: '今天 #私密 记一件私事', tags: [], category: '生活' },
    { body: '＃私密 全角井号', tags: [], category: '未归类' },
    { body: '普通正文 [private] 末尾标注', tags: [], category: '未归类' },
    { body: '普通正文', tags: ['#私密'], category: '生活' },
    { body: '普通正文', tags: ['Secret'], category: '生活' },
    { body: '普通正文', tags: [], category: '生活', private: true },
  ]
  for (const item of shouldBePrivate) {
    assert.equal(privacy.isPrivateJournalEntry(item), true, `expected private: ${JSON.stringify(item)}`)
  }
  assert.equal(
    privacy.isPrivateJournalEntry({ body: '今天修一下时间日记的竖版图片裁切', tags: ['工程'], category: '工程' }),
    false,
  )

  // Secret scrubbing
  const dirty = 'Use sk-ant-api03-abcdef1234567890XYZ and ghp_1234567890abcdefghij123456 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
  const scrubbed = privacy.scrubSecrets(dirty)
  assert.doesNotMatch(scrubbed, /sk-ant-api03/)
  assert.doesNotMatch(scrubbed, /ghp_1234567890/)
  assert.doesNotMatch(scrubbed, /eyJhbGci/)
  assert.match(scrubbed, /\[REDACTED_API_KEY\]/)
  assert.match(scrubbed, /\[REDACTED_GH_TOKEN\]/)
  assert.match(scrubbed, /Bearer \[REDACTED_TOKEN\]/)

  // Lossless private persistence through JournalStore + updateEntry
  const deskRoot = mkdtempSync(join(tmpdir(), 'sentinel-priv-test-'))
  try {
    const store = new JournalStore({ deskRoot })
    const created = await store.createEntry({
      date: '2026-11-21',
      time: '09:15',
      body: '个人隐私备忘',
      category: '生活',
      private: true,
    })
    assert.equal(created.ok, true)
    assert.equal(created.entry.private, true)

    const updated = await store.updateEntry('2026-11-21', created.entry.id, {
      body: '更新后的个人隐私备忘',
    })
    assert.equal(updated.ok, true)
    assert.equal(updated.entry.private, true, 'updateEntry must preserve private flag')

    const day = await store.getDay('2026-11-21')
    assert.equal(day.ok, true)
    assert.equal(day.entries[0].private, true, 'parseDayMarkdown must restore private flag')
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
  }

  // Deterministic fallback IDs for meta-less markdown entries
  const looseMd = '# 2026-11-21\n\n### 08:00 · 生活\n记得买咖啡豆\n'
  const p1 = md.parseDayMarkdown('2026-11-21', looseMd)
  const p2 = md.parseDayMarkdown('2026-11-21', looseMd)
  assert.equal(p1[0].id, p2[0].id, 'meta-less entry ID must be deterministic across parses')
})

test('anthropic-messages-client: joins text blocks after thinking block, falls back default baseUrl, classifies 401 as needs_config', async () => {
  const client = loadTsModule(resolve(rootDir, 'electron/anthropic-messages-client.ts'))

  assert.equal(
    client.buildAnthropicMessagesEndpoint(''),
    'https://api.anthropic.com/v1/messages',
  )
  assert.equal(
    client.buildAnthropicMessagesEndpoint('https://api.minimaxi.com/anthropic'),
    'https://api.minimaxi.com/anthropic/v1/messages',
  )

  // Reasoning model response where content[0] is thinking and content[1] is text
  const thinkingPayload = {
    model: 'MiniMax-M3.1-Flash',
    content: [
      { type: 'thinking', thinking: 'internal chain of thought...' },
      { type: 'text', text: '{"ignoredNoiseCount":1,"todos":[]}' },
    ],
    usage: { input_tokens: 120, output_tokens: 45 },
  }
  assert.equal(client.extractAnthropicText(thinkingPayload), '{"ignoredNoiseCount":1,"todos":[]}')

  // 401 -> needs_config with zero retries
  let calls = 0
  const authRes = await client.callAnthropicMessages(
    { authToken: 'bad-token', apiKey: '', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3.1-Flash' },
    { messages: [{ role: 'user', content: 'hi' }] },
    {
      fetchFn: async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { message: 'invalid token' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
  )
  assert.equal(authRes.ok, false)
  assert.equal(authRes.kind, 'needs_config')
  assert.equal(calls, 1)

  // 429 -> retries honoring retry-after, then succeeds
  let rateCalls = 0
  const slept = []
  const sentEfforts = []
  const retryRes = await client.callAnthropicMessages(
    { authToken: 'ok-token', apiKey: '', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3.1-Flash' },
    { messages: [{ role: 'user', content: 'hi' }], effort: 'low' },
    {
      sleep: async (ms) => { slept.push(ms) },
      fetchFn: async (_url, init) => {
        sentEfforts.push(JSON.parse(init.body).output_config)
        rateCalls += 1
        if (rateCalls === 1) {
          return new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } })
        }
        return new Response(JSON.stringify(thinkingPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
  )
  assert.equal(retryRes.ok, true)
  assert.equal(rateCalls, 2)
  assert.deepEqual(sentEfforts, [{ effort: 'low' }, { effort: 'low' }])
  assert.deepEqual(slept, [1000])
  assert.equal(retryRes.text, '{"ignoredNoiseCount":1,"todos":[]}')
})

test('intent-todo-analyzer: analyzes targetDate in isolation (never sweeps other historical days), handles fenced JSON, repair retry, 28-char title truncation, privacy filtering, and suggestedDone without hiding', async () => {
  const analyzer = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-analyzer.ts'))

  const requestedDates = []
  const fakeJournalStore = {
    async getDay(date) {
      requestedDates.push(date)
      if (date === '2026-11-20') {
        return {
          ok: true,
          entries: [
            {
              id: 'je_old_day',
              date: '2026-11-20',
              time: '12:00',
              ts: '2026-11-20T04:00:00.000Z',
              kind: 'note',
              body: '前一天历史日记不应在分析今日时被顺带扫入',
              category: '生活',
              tags: [],
              projectRefs: [],
              source: 'local',
              provenance: 'human',
              images: [],
            },
          ],
        }
      }
      if (date === '2026-11-21') {
        return {
          ok: true,
          entries: [
            {
              id: 'je_priv_1',
              date: '2026-11-21',
              time: '17:00',
              ts: '2026-11-21T09:00:00.000Z',
              kind: 'note',
              body: '#私密去银行改密码',
              category: '生活',
              tags: [],
              projectRefs: [],
              source: 'local',
              provenance: 'human',
              images: [],
            },
            {
              id: 'je_eng_1',
              date: '2026-11-21',
              time: '21:06',
              ts: '2026-11-21T13:06:00.000Z',
              kind: 'note',
              body: '在 AgentOS 时间日记里修复竖版图片上下裁切问题，不要裁掉上下两端',
              category: '工程',
              tags: [],
              projectRefs: ['AgentOS'],
              source: 'local',
              provenance: 'human',
              images: [],
            },
            {
              id: 'je_life_1',
              date: '2026-11-21',
              time: '22:30',
              ts: '2026-11-21T14:30:00.000Z',
              kind: 'note',
              body: '明早起来先给汽车轮胎打气，胎压报警了',
              category: '生活',
              tags: [],
              projectRefs: [],
              source: 'local',
              provenance: 'human',
              images: [],
            },
          ],
        }
      }
      return { ok: true, entries: [] }
    },
  }

  let llmCalls = 0
  let capturedPrompt = ''
  const res = await analyzer.runIntentTodoAnalysis({
    journalStore: fakeJournalStore,
    projects: [{ id: 'p_agentos', name: 'AgentOS', path: '/tmp/AgentOS' }],
    processedEntryHashes: {},
    openItems: [],
    droppedFingerprints: [],
    resolvedConfig: { authToken: 'tok', apiKey: '', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3.1-Flash' },
    providerName: 'MiniMax-CN',
    targetDate: '2026-11-21',
    now: new Date('2026-11-21T20:05:00Z'), // 2026-11-22 04:05 +08:00
    gitLogFetcher: async (_proj, sinceIso) => {
      assert.equal(sinceIso, '2026-11-20T04:00:00+08:00')
      return ['8ed17f3 fix(journal): portrait image object-fit contain']
    },
    callLlm: async (_cfg, req) => {
      llmCalls += 1
      if (llmCalls === 1) {
        capturedPrompt = req.messages[0].content
        // Return broken JSON on attempt 1 to verify repair retry
        return { ok: true, text: 'Here is my analysis: { broken json', model: 'MiniMax-M3.1-Flash', durationMs: 10 }
      }
      // Return fenced JSON with overly long title and suggestedDone hint on repair attempt
      return {
        ok: true,
        model: 'MiniMax-M3.1-Flash',
        durationMs: 12,
        text: '```json\n' + JSON.stringify({
          ignoredNoiseCount: 0,
          todos: [
            {
              matchesExistingId: null,
              title: '修复时间日记竖版图片上下两端被裁切显示的视觉样式问题并且保持左右留白',
              reason: '已出现视觉缺陷，验收标准明确',
              track: 'engineering',
              urgency: 'high',
              suggestedProjectName: 'AgentOS',
              antiPatterns: ['裁掉上下两端'],
              anchorEntryIds: ['je_eng_1'],
              suggestedDoneSha: '8ed17f3',
              suggestedDoneMessage: 'fix(journal): portrait image object-fit contain',
            },
            {
              matchesExistingId: null,
              title: '给汽车轮胎打气处理胎压报警',
              reason: '涉行车安全，需尽快处理',
              track: 'life',
              urgency: 'high',
              suggestedProjectName: null,
              antiPatterns: [],
              anchorEntryIds: ['je_life_1'],
              suggestedDoneSha: null,
              suggestedDoneMessage: null,
            },
          ],
        }) + '\n```',
      }
    },
  })

  assert.equal(res.ok, true)
  assert.deepEqual(requestedDates, ['2026-11-21'], 'must only read the single targetDate')
  assert.equal(res.logicalDate, '2026-11-21')
  assert.equal(llmCalls, 2, 'should perform 1 repair retry')
  assert.equal(res.stats.skippedPrivate, 1)
  assert.doesNotMatch(capturedPrompt, /银行改密码/, 'private entry must never reach LLM prompt')
  assert.doesNotMatch(capturedPrompt, /前一天历史日记/, 'other historical days must never leak into prompt')
  assert.equal(res.candidates.length, 2, 'both single-day items must appear')
  assert.ok(res.candidates[0].title.length <= 28, 'title must be clamped to <= 28 chars')
  assert.equal(res.candidates[0].suggestedProjectId, 'p_agentos')
  assert.equal(res.candidates[0].projectExplicitlyBound, true)
  assert.equal(res.candidates[0].suggestedDone?.sha, '8ed17f3')
})

test('intent-todo-store & service: serializes writes and concurrent dispatch, preserves permission scope and life cwd', async () => {
  const { IntentTodoService } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'intent-todo-ud-'))
  const deskRoot = mkdtempSync(join(tmpdir(), 'intent-todo-desk-'))

  try {
    let clock = new Date('2026-11-22T00:10:00Z') // 2026-11-22 08:10 +08:00
    const dispatchedCalls = []
    let threadSeq = 0

    const fakeBroker = {
      async createThread(input) {
        threadSeq += 1
        return { ok: true, value: { threadId: `th_${threadSeq}`, workspaceRevision: threadSeq } }
      },
      async submitRun(input, context) {
        // Artificial async delay to test concurrent 3x dispatch queueing
        await new Promise((r) => setTimeout(r, 15))
        dispatchedCalls.push({ input, context })
        return { ok: true, value: { requestId: `req_${dispatchedCalls.length}` } }
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

    const fakeJournalStore = {
      getDeskRoot: () => deskRoot,
      async getDay() {
        return { ok: true, entries: [] }
      },
    }

    const service = new IntentTodoService({
      userDataPath,
      journalStore: fakeJournalStore,
      settingsStore: fakeSettings,
      getWorkspaceState: () => ({
        projects: [
          { id: 'p_agentos', name: 'AgentOS', path: '/tmp/AgentOS' },
          { id: 'p_quant', name: 'jevquant', path: '/tmp/jevquant' },
        ],
      }),
      getBroker: () => fakeBroker,
      now: () => clock,
    })

    // Seed 5 pending items via mergeAnalysisResult
    const seed = await service.store.mergeAnalysisResult({
      logicalDate: '2026-11-22',
      ranAt: clock.toISOString(),
      providerName: 'MiniMax-CN',
      modelUsed: 'MiniMax-M3.1-Flash',
      processedHashes: ['h1'],
      deskRoot,
      stats: { scannedEntries: 5, newHumanEntries: 5, skippedPrivate: 0, suspectedAiPaste: 0, ignoredNoiseCount: 0, durationMs: 50 },
      candidates: [
        { title: '修复竖版图片裁切', reason: '视觉缺陷', track: 'engineering', urgency: 'high', suggestedProjectId: 'p_agentos', suggestedProjectName: 'AgentOS', projectExplicitlyBound: true, antiPatterns: ['裁切上下'], anchors: [{ date: '2026-11-21', time: '21:06', entryId: 'e1', contentHash: 'h1', flags: ['人类手写'] }] },
        { title: '补全私密标记', reason: '隐私红线', track: 'engineering', urgency: 'high', suggestedProjectId: 'p_agentos', suggestedProjectName: 'AgentOS', projectExplicitlyBound: true, antiPatterns: [], anchors: [{ date: '2026-11-21', time: '17:41', entryId: 'e2', contentHash: 'h2', flags: ['人类手写'] }] },
        { title: '调研网易叭哥说硬件', reason: '开车安全', track: 'life', urgency: 'medium', suggestedProjectId: null, suggestedProjectName: null, projectExplicitlyBound: false, antiPatterns: [], anchors: [{ date: '2026-11-21', time: '17:45', entryId: 'e3', contentHash: 'h3', flags: ['人类手写'] }] },
        { title: '跟进任务A', reason: 'r', track: 'life', urgency: 'low', suggestedProjectId: null, suggestedProjectName: null, projectExplicitlyBound: false, antiPatterns: [], anchors: [{ date: '2026-11-21', time: '10:00', entryId: 'e4', contentHash: 'h4', flags: ['人类手写'] }] },
        { title: '跟进任务B', reason: 'r', track: 'life', urgency: 'low', suggestedProjectId: null, suggestedProjectName: null, projectExplicitlyBound: false, antiPatterns: [], anchors: [{ date: '2026-11-21', time: '10:01', entryId: 'e5', contentHash: 'h5', flags: ['人类手写'] }] },
        { title: '跟进任务C', reason: 'r', track: 'life', urgency: 'low', suggestedProjectId: null, suggestedProjectName: null, projectExplicitlyBound: false, antiPatterns: [], anchors: [{ date: '2026-11-21', time: '10:02', entryId: 'e6', contentHash: 'h6', flags: ['人类手写'] }] },
        { title: '跟进任务D', reason: 'r', track: 'life', urgency: 'low', suggestedProjectId: null, suggestedProjectName: null, projectExplicitlyBound: false, antiPatterns: [], anchors: [{ date: '2026-11-21', time: '10:03', entryId: 'e7', contentHash: 'h7', flags: ['人类手写'] }] },
      ],
    })

    // Deterministic Markdown report written to deskRoot
    const reportPath = join(deskRoot, 'intent-todos', 'reports', '2026-11-22.md')
    assert.equal(existsSync(reportPath), true)
    assert.match(readFileSync(reportPath, 'utf8'), /修复竖版图片裁切/)

    const [idEng1, idEng2, idLife, idA, idB, idC, idD] = seed.createdIds

    // Concurrent 3x dispatch (2 engineering + 1 sandboxed life breakdown) — NONE may be silently dropped!
    const [d1, d2, d3] = await Promise.all([
      service.dispatchItem({ itemId: idEng1, projectId: 'p_agentos' }),
      service.dispatchItem({ itemId: idEng2, projectId: 'p_agentos' }),
      service.dispatchItem({ itemId: idLife, sandboxedLife: true }),
    ])
    assert.equal(d1.ok, true)
    assert.equal(d2.ok, true)
    assert.equal(d3.ok, true)
    assert.equal(dispatchedCalls.length, 3, 'all 3 concurrent dispatches must complete')

    for (const call of dispatchedCalls) {
      assert.doesNotMatch(call.input.text, /<untrusted_journal_quote/)
      assert.match(call.input.text, /<ai_triage_suggestion/)
    }
    const lifeCall = dispatchedCalls[2]
    for (const call of dispatchedCalls.filter((call) => call !== lifeCall)) {
      assert.equal(call.context?.permissionModeOverride, undefined, 'project dispatch inherits the global mode')
      assert.doesNotMatch(call.input.text, /只读 plan 模式/)
    }
    assert.equal(lifeCall.context.permissionModeOverride, 'plan')
    assert.equal(lifeCall.context.cwdOverride, join(userDataPath, 'intent-todo-sandbox'))
    assert.ok(!lifeCall.context.cwdOverride.includes(deskRoot), 'life sandbox cwd must never touch deskRoot/journal')

    // Live runtime phase derivation from ProjectChatBroker event
    service.observeProjectChatEvent({
      projectId: 'p_agentos',
      snapshot: {
        runs: [{ projectId: 'p_agentos', threadId: d1.threadId, requestId: 'req_1', phase: 'waiting_permission', routeGeneration: 1, startedAt: Date.now() }],
      },
    })
    const ovLive = service.getOverview('2026-11-22')
    const hydratedEng1 = ovLive.activeItems.find((i) => i.id === idEng1)
    assert.equal(hydratedEng1?.dispatchRuntimePhase, 'waiting_permission')

    // Re-running mergeAnalysisResult matching idEng1 MUST NOT overwrite its `now` + `dispatch` state
    await service.store.mergeAnalysisResult({
      logicalDate: '2026-11-22',
      ranAt: clock.toISOString(),
      providerName: 'MiniMax-CN',
      modelUsed: 'MiniMax-M3.1-Flash',
      processedHashes: ['h1_repeat'],
      stats: { scannedEntries: 1, newHumanEntries: 1, skippedPrivate: 0, suspectedAiPaste: 0, ignoredNoiseCount: 0, durationMs: 10 },
      candidates: [
        { matchesExistingId: idEng1, title: '修复竖版图片裁切', reason: '再提一次', track: 'engineering', urgency: 'medium', suggestedProjectId: 'p_agentos', suggestedProjectName: 'AgentOS', projectExplicitlyBound: true, antiPatterns: [], anchors: [{ date: '2026-11-22', time: '09:00', entryId: 'e1_b', contentHash: 'h1_b', flags: ['人类手写'] }] },
      ],
    })
    const afterMerge = service.store.getItem(idEng1)
    assert.equal(afterMerge.status, 'now', 'user decision status must never be clobbered')
    assert.equal(afterMerge.dispatch?.threadId, d1.threadId, 'dispatch metadata must survive merge')
    assert.equal(afterMerge.anchors.length, 2, 'merged anchor must be appended')

    // Follow-up daily cap (3/day) & 14-day auto-archive
    await Promise.all([
      service.decideItem(idA, { action: 'later', snoozeDays: 3 }),
      service.decideItem(idB, { action: 'later', snoozeDays: 3 }),
      service.decideItem(idC, { action: 'later', snoozeDays: 3 }),
      service.decideItem(idD, { action: 'later', snoozeDays: 3 }),
    ])

    // Advance 3 days -> 4 later items are due, but daily cap surfaces max 3 (snoozedLaterCount = 1)
    clock = new Date('2026-11-25T00:10:00Z')
    const ovDay3 = service.getOverview('2026-11-25')
    const surfacedLater = ovDay3.activeItems.filter((i) => i.status === 'later')
    assert.equal(surfacedLater.length, 3, 'daily follow-up surface must cap at 3')
    assert.equal(ovDay3.snoozedLaterCount, 1)

    // Advance 15 days -> untouched later items auto-archive
    clock = new Date('2026-12-07T00:10:00Z')
    await service.store.runHousekeepingIfNeeded()
    const archivedA = service.store.getItem(idA)
    assert.equal(archivedA.status, 'dropped')
    assert.equal(archivedA.autoArchived, true)

    service.dispose()
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(deskRoot, { recursive: true, force: true })
  }
})

test('pinned-modules & app-shell-constants: intent-todo is registered as the 2nd pinned module and routed cleanly', () => {
  const { PINNED_MODULES } = loadTsModule(resolve(rootDir, 'src/components/pinned-modules.ts'))
  const { normalizeViewId, VIEW_HEADING_KEYS } = loadTsModule(resolve(rootDir, 'src/components/app-shell-constants.ts'))

  assert.equal(PINNED_MODULES[0].id, 'journal')
  assert.equal(PINNED_MODULES[1].id, 'intent-todo')
  assert.equal(PINNED_MODULES[1].hash, '#intent-todo')
  assert.equal(normalizeViewId('intent-todo'), 'intent-todo')
  assert.equal(normalizeViewId('journal/2026-11-21/je_123'), 'journal')
  assert.equal(VIEW_HEADING_KEYS['intent-todo'], 'shell.viewIntentTodo')
})

test('intent-todo-analyzer: strips <think> blocks, gives reasoning models 16384 maxTokens, and reports max_tokens exhaustion clearly', async () => {
  const analyzer = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-analyzer.ts'))

  // <think> containing braces must not fool extractJsonObjectText
  const rawWithThink = '<think>considering { "wrong": true } first</think>\n```json\n{"ignoredNoiseCount":1,"todos":[]}\n```'
  const parsed = analyzer.validateAndParseModelJson(rawWithThink)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.payload.ignoredNoiseCount, 1)

  const seenOptions = []
  const res = await analyzer.runIntentTodoAnalysis({
    journalStore: {
      async getDay(date) {
        if (date !== '2026-11-21') return { ok: true, entries: [] }
        return {
          ok: true,
          entries: [
            {
              id: 'je_think_1',
              date: '2026-11-21',
              time: '10:00',
              body: '今天要修复登录按钮的点击问题',
              kind: 'human',
              provenance: 'human',
              category: '工程',
              tags: [],
              projectRefs: [],
              attachments: [],
            },
          ],
        }
      },
    },
    projects: [],
    processedEntryHashes: {},
    openItems: [],
    droppedFingerprints: [],
    resolvedConfig: { apiKey: '', authToken: 'tok', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3.1-Flash' },
    providerName: 'MiniMax-CN',
    now: new Date('2026-11-21T04:00:00Z'),
    async callLlm(_cfg, req) {
      seenOptions.push({ maxTokens: req.maxTokens, effort: req.effort })
      return {
        ok: true,
        text: '',
        model: 'MiniMax-M3.1-Flash',
        stopReason: 'max_tokens',
        usage: { inputTokens: 1000, outputTokens: 16384 },
        durationMs: 100,
      }
    },
  })

  assert.deepEqual(seenOptions, [
    { maxTokens: 16384, effort: 'low' },
    { maxTokens: 16384, effort: 'low' },
  ])
  assert.equal(res.ok, false)
  assert.equal(res.kind, 'parse_error')
  assert.match(res.message, /max_tokens/)
})

test('intent-todo: auto-marks detected completed items as done, preserves accurate private count across refreshes, and isolates empty days', async () => {
  const { IntentTodoService } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'intent-todo-iso-ud-'))
  const deskRoot = mkdtempSync(join(tmpdir(), 'intent-todo-iso-desk-'))

  try {
    let clock = new Date('2026-11-21T19:50:00Z') // 2026-11-22 03:50 +08:00 -> logical 2026-11-21
    const journalStore = {
      getDeskRoot: () => deskRoot,
      async getDay(date) {
        if (date === '2026-11-21') {
          return {
            ok: true,
            entries: [
              { id: 'p1', date: '2026-11-21', time: '17:28', body: '私事一', kind: 'note', provenance: 'human', category: '未归类', tags: [], projectRefs: [], private: true },
              { id: 'p2', date: '2026-11-21', time: '20:01', body: '私事二', kind: 'note', provenance: 'human', category: '未归类', tags: [], projectRefs: [], private: true },
              { id: 'e1', date: '2026-11-21', time: '21:06', body: '修复 AgentOS 竖版图片裁切', kind: 'note', provenance: 'human', category: '工程', tags: [], projectRefs: [] },
              { id: 'e2', date: '2026-11-21', time: '13:54', body: '给 AgentOS 加年月选择器', kind: 'note', provenance: 'human', category: '工程', tags: [], projectRefs: [] },
            ],
          }
        }
        return { ok: true, entries: [] }
      },
    }

    const service = new IntentTodoService({
      userDataPath,
      journalStore,
      settingsStore: {
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [{ id: 'p1', name: 'MiniMax-CN', model: 'MiniMax-M3.1-Flash' }] } }),
        resolve: () => ({ configSource: 'settings', apiKey: '', authToken: 'tok', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3.1-Flash' }),
      },
      getWorkspaceState: () => ({
        projects: [
          { id: 'p_ag', name: '【Mitchi Sentinel】AgentOS', path: '/tmp/【Mitchi Sentinel】AgentOS' },
          { id: 'p_news', name: 'NewsAgent-0.4-notion-feishu', path: '/tmp/NewsAgent-0.4-notion-feishu' },
        ],
      }),
      getBroker: () => null,
      now: () => clock,
      gitLogFetcher: async (proj) => (proj.id === 'p_ag' ? ['8ed17f3 feat(journal): calendar/month picker'] : []),
      callLlm: async () => ({
        ok: true,
        model: 'MiniMax-M3.1-Flash',
        durationMs: 20,
        text: JSON.stringify({
          ignoredNoiseCount: 0,
          todos: [
            {
              matchesExistingId: null,
              title: '修复竖版图片完整显示',
              reason: '竖图上下被裁切',
              track: 'engineering',
              urgency: 'high',
              suggestedProjectName: 'AgentOS',
              antiPatterns: ['不得裁切竖版图片上下内容'],
              anchorEntryIds: ['e1'],
              alreadyDone: false,
              suggestedDoneSha: null,
              suggestedDoneMessage: null,
            },
            {
              matchesExistingId: null,
              title: '增加年月与日期选择组件',
              reason: '',
              track: 'engineering',
              urgency: 'medium',
              suggestedProjectName: 'AgentOS',
              antiPatterns: [],
              anchorEntryIds: ['e2'],
              alreadyDone: true,
              suggestedDoneSha: '8ed17f3',
              suggestedDoneMessage: '已提交 calendar/month picker',
            },
          ],
        }),
      }),
    })

    // 1st run on 2026-11-21
    const r1 = await service.refreshAnalysis('2026-11-21')
    assert.equal(r1.ok, true)
    assert.equal(r1.overview.snapshot.stats.skippedPrivate, 2, 'must count both private entries')
    assert.equal(r1.overview.pendingItems.length, 1, 'only open item should be pending')
    assert.equal(r1.overview.pendingItems[0].suggestedProjectId, 'p_ag', 'stripped alias AgentOS must bind to 【Mitchi Sentinel】AgentOS')
    assert.equal(r1.overview.resolvedItems.length, 1, 'alreadyDone item must auto-land in resolved/done')
    assert.equal(r1.overview.resolvedItems[0].status, 'done')

    // 2nd incremental refresh on 2026-11-21 must STILL report skippedPrivate === 2 and preserve newHumanEntries
    const r2 = await service.refreshAnalysis('2026-11-21')
    assert.equal(r2.ok, true)
    assert.equal(r2.overview.snapshot.stats.skippedPrivate, 2, 'second refresh must not zero out skippedPrivate')
    assert.equal(r2.overview.snapshot.stats.newHumanEntries, 2, 'second refresh must preserve day human entry count')

    // Clock advances past 04:00 into empty 2026-11-22
    clock = new Date('2026-11-21T20:05:00Z') // 2026-11-22 04:05 +08:00 -> logical 2026-11-22
    await service.checkSchedule('tick')
    const ov22 = service.getOverview('2026-11-22')
    assert.equal(ov22.snapshot, null, 'empty 2026-11-22 must NOT create a phantom snapshot')
    assert.equal(ov22.pendingItems.length, 0, '2026-11-21 pending items must NOT bleed onto empty 2026-11-22')
    const cal = service.listCalendarDays()
    assert.deepEqual(cal.map((d) => d.date), ['2026-11-21'], 'empty 2026-11-22 must not be activated in calendar')

    // 3-day auto-expiry of untouched pending items:
    // Day +2 (2026-11-23): still pending
    clock = new Date('2026-11-23T00:10:00Z')
    await service.store.runHousekeepingIfNeeded()
    assert.equal(service.getOverview('2026-11-21').pendingItems.length, 1, 'pending item should survive day +2')

    // Day +3 (2026-11-24): auto-archived to dropped/autoArchived
    clock = new Date('2026-11-24T00:10:00Z')
    await service.store.runHousekeepingIfNeeded()
    const ovExpired = service.getOverview('2026-11-21')
    assert.equal(ovExpired.pendingItems.length, 0, 'untouched pending item must auto-expire after 3 days')
    assert.equal(ovExpired.autoArchivedCount, 1)

    service.dispose()
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(deskRoot, { recursive: true, force: true })
  }
})

test('intent-todo: pure cloud analysis sends all non-private entries directly, supports dedicated modelPick, and re-analyzes on cloud model switch', async () => {
  const { IntentTodoService } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'intent-todo-modelpick-'))
  const deskRoot = mkdtempSync(join(tmpdir(), 'intent-todo-desk-'))
  try {
    const entries = [
      { id: 'n1', date: '2026-11-22', time: '09:00', ts: '2026-11-22T01:00:00Z', body: '起床了喝杯咖啡', kind: 'note', provenance: 'human', category: '生活', tags: [], projectRefs: [] },
      { id: 'e1', date: '2026-11-22', time: '09:15', ts: '2026-11-22T01:15:00Z', body: '给意图待办加一个云端模型切换菜单 @AgentOS', kind: 'note', provenance: 'human', category: '工程', tags: [], projectRefs: [] },
    ]
    const providers = [
      {
        id: 'prov-minimax',
        name: 'MiniMax-CN',
        apiKey: '',
        authToken: 'tok-mm',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        model: 'MiniMax-M3.1-Flash',
        defaultHaikuModel: '',
        defaultSonnetModel: '',
        defaultOpusModel: '',
      },
      {
        id: 'prov-anthropic',
        name: 'Anthropic',
        apiKey: 'sk-ant-test',
        authToken: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        defaultHaikuModel: '',
        defaultSonnetModel: 'claude-sonnet-4-6',
        defaultOpusModel: 'claude-opus-4-6',
      },
    ]
    const calls = []
    const svc = new IntentTodoService({
      userDataPath,
      journalStore: {
        getDeskRoot: () => deskRoot,
        async getDay() {
          return { ok: true, entries }
        },
      },
      settingsStore: {
        getSnapshot: () => ({
          settings: {
            configSource: 'settings',
            activeProviderId: 'prov-minimax',
            activeAnthropicModel: '',
            providers,
          },
          env: {},
        }),
        resolve: (pick) => {
          const prov = pick
            ? providers.find((p) => p.id === pick.providerId) ?? providers[0]
            : providers[0]
          return {
            configSource: 'settings',
            apiKey: prov.apiKey,
            authToken: prov.authToken,
            baseUrl: prov.baseUrl,
            model: pick?.anthropicModel || prov.model,
            supportsImages: true,
          }
        },
      },
      getWorkspaceState: () => ({
        projects: [{ id: 'p_ag', name: '【Mitchi Sentinel】AgentOS', path: '/tmp/【Mitchi Sentinel】AgentOS' }],
      }),
      getBroker: () => null,
      now: () => new Date('2026-11-22T02:00:00Z'),
      gitLogFetcher: async () => [],
      callLlm: async (cfg, req) => {
        calls.push({ model: cfg.model, prompt: req.messages[0].content })
        return {
          ok: true,
          model: cfg.model,
          durationMs: 20,
          text: JSON.stringify({
            ignoredNoiseCount: 1,
            todos: [
              {
                title: '新增意图待办云端模型切换菜单',
                reason: '支持选用更高精度云端模型',
                track: 'engineering',
                urgency: 'medium',
                suggestedProjectName: '【Mitchi Sentinel】AgentOS',
                anchorEntryIds: ['e1'],
                alreadyDone: false,
              },
            ],
          }),
        }
      },
    })

    // 1. Default run uses global MiniMax-M3.1-Flash and sends ALL non-private entries directly (no local pre-filter)
    const first = await svc.refreshAnalysis('2026-11-22')
    assert.equal(first.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].model, 'MiniMax-M3.1-Flash')
    assert.match(calls[0].prompt, /起床了喝杯咖啡/, 'must not drop entries via local pre-triage before cloud LLM')
    assert.equal(first.overview.providerName, 'MiniMax-CN')
    assert.equal(first.overview.modelName, 'MiniMax-M3.1-Flash')

    // 2. Repeating refresh on same model with no new entries costs 0 cloud calls
    const repeat = await svc.refreshAnalysis('2026-11-22')
    assert.equal(repeat.ok, true)
    assert.equal(calls.length, 1)

    // 3. Switching dedicated Intent Todo cloud model to Claude Opus & clicking Run Now re-analyzes the day
    await svc.saveConfig({
      modelPick: { providerId: 'prov-anthropic', anthropicModel: 'claude-opus-4-6' },
    })
    const overviewAfterSwitch = svc.getOverview('2026-11-22')
    assert.equal(overviewAfterSwitch.providerName, 'Anthropic')
    assert.equal(overviewAfterSwitch.modelName, 'claude-opus-4-6')

    const second = await svc.refreshAnalysis('2026-11-22')
    assert.equal(second.ok, true)
    assert.equal(calls.length, 2, 'switching cloud model must re-analyze the day on manual refresh')
    assert.equal(calls[1].model, 'claude-opus-4-6')
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(deskRoot, { recursive: true, force: true })
  }
})

test('intent-todo: forceReanalyze never duplicates done/dropped items, preserves monotonic dates, caps human entry stats, and runs beforeScheduledAnalysis before cloud read', async () => {
  const { IntentTodoService } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-service.ts'))
  const { IntentTodoStore } = loadTsModule(resolve(rootDir, 'electron/desk/intent-todo-store.ts'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'agentos-it-tier1-'))
  const deskRoot = mkdtempSync(join(tmpdir(), 'agentos-it-desk-tier1-'))

  try {
    // 1. Store-level monotonic lastMentionedDate & snoozeUntil + autoArchived droppedFingerprint
    let nowIso = '2026-11-22T02:00:00Z'
    const store = new IntentTodoStore({ userDataPath, now: () => new Date(nowIso) })

    const created = await store.mergeAnalysisResult({
      logicalDate: '2026-11-22',
      ranAt: nowIso,
      providerName: 'MiniMax-CN',
      modelUsed: 'MiniMax-M3.1-Flash',
      processedHashes: ['h1'],
      processedBodyHashes: ['b1'],
      candidates: [
        {
          title: '隐藏未来日期同步按钮',
          reason: '未来日期不应导入历史',
          track: 'engineering',
          urgency: 'medium',
          suggestedProjectId: 'p1',
          suggestedProjectName: 'AgentOS',
          projectExplicitlyBound: true,
          antiPatterns: [],
          anchors: [{ date: '2026-11-22', time: '08:16', entryId: 'e_future', contentHash: 'h1' }],
        },
        {
          title: '待沉睡的旧项',
          reason: '测试自动归档指纹',
          track: 'life',
          urgency: 'low',
          suggestedProjectId: null,
          suggestedProjectName: null,
          projectExplicitlyBound: false,
          antiPatterns: [],
          anchors: [{ date: '2026-11-22', time: '09:00', entryId: 'e_old', contentHash: 'h2' }],
        },
      ],
      stats: { scannedEntries: 2, newHumanEntries: 2, skippedPrivate: 0, suspectedAiPaste: 0, ignoredNoiseCount: 0, durationMs: 20 },
    })

    const itemId = created.createdIds[0]
    await store.applyDecision(itemId, { action: 'later', snoozeDays: 3 })
    const beforeBackfill = store.getItem(itemId)
    assert.equal(beforeBackfill.snoozeUntil, '2026-11-25')

    // Re-analyzing an earlier date (2026-11-21) matching the 11-22 item must NOT regress lastMentionedDate or snoozeUntil
    await store.mergeAnalysisResult({
      logicalDate: '2026-11-21',
      ranAt: '2026-11-22T02:10:00Z',
      providerName: 'MiniMax-CN',
      modelUsed: 'MiniMax-M3.1-Flash',
      processedHashes: ['h_prev'],
      processedBodyHashes: ['b_prev'],
      candidates: [
        {
          matchesExistingId: itemId,
          title: '隐藏未来日期同步按钮',
          reason: '旧日志提及',
          track: 'engineering',
          urgency: 'medium',
          suggestedProjectId: 'p1',
          suggestedProjectName: 'AgentOS',
          projectExplicitlyBound: true,
          antiPatterns: [],
          anchors: [{ date: '2026-11-21', time: '20:00', entryId: 'e_prev', contentHash: 'h_prev' }],
        },
      ],
      stats: { scannedEntries: 1, newHumanEntries: 1, skippedPrivate: 0, suspectedAiPaste: 0, ignoredNoiseCount: 0, durationMs: 10 },
    })
    const afterBackfill = store.getItem(itemId)
    assert.equal(afterBackfill.lastMentionedDate, '2026-11-22', 'lastMentionedDate must never regress backwards')
    assert.equal(afterBackfill.snoozeUntil, '2026-11-25', 'historical re-analysis must not pull future snoozeUntil backwards')

    // Auto-archiving stale pending item after 3 days must record a droppedFingerprint
    nowIso = '2026-11-26T02:00:00Z'
    const archivedChanged = await store.runHousekeepingIfNeeded()
    assert.equal(archivedChanged, true)
    const archivedItem = store.getItem(created.createdIds[1])
    assert.equal(archivedItem.status, 'dropped')
    assert.equal(archivedItem.autoArchived, true)
    assert.equal(
      store.getDroppedFingerprints().some((fp) => fp.title === '待沉睡的旧项'),
      true,
      'auto-archived items must be recorded in droppedFingerprints',
    )

    // 2. Service-level: forceReanalyze after marking item done must NOT duplicate, and stats.newHumanEntries must not double-count
    const svcDir = mkdtempSync(join(tmpdir(), 'agentos-it-tier1-svc-'))
    try {
      const dayEntries = [
        {
          id: 'e_fix',
          date: '2026-11-22',
          time: '08:16',
          ts: '2026-11-22T00:16:00Z',
          kind: 'note',
          body: '请修复私密条目漏判和未来日期按钮',
          category: '工程',
          tags: [],
          projectRefs: ['【Mitchi Sentinel】AgentOS'],
          source: 'feishu',
          provenance: 'human',
          images: [],
        },
        {
          id: 'e_secret',
          date: '2026-11-22',
          time: '08:20',
          ts: '2026-11-22T00:20:00Z',
          kind: 'note',
          body: '明天去医院复查，住址上海市徐汇区xx路18号',
          category: '未归类',
          tags: [],
          projectRefs: [],
          source: 'feishu',
          provenance: 'human',
          images: [],
          private: false,
        },
      ]

      const providers = [
        { id: 'p-mm', name: 'MiniMax-CN', apiKey: 'sk-mm', authToken: '', baseUrl: 'https://api.minimax.example', model: 'MiniMax-M3.1-Flash', defaultHaikuModel: '', defaultSonnetModel: '', defaultOpusModel: '' },
        { id: 'p-ant', name: 'Anthropic', apiKey: 'sk-ant', authToken: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', defaultHaikuModel: '', defaultSonnetModel: '', defaultOpusModel: '' },
      ]

      const callOrder = []
      const llmPrompts = []
      let llmRunIndex = 0
      const svc = new IntentTodoService({
        userDataPath: svcDir,
        journalStore: {
          getDeskRoot: () => deskRoot,
          async getDay() {
            callOrder.push('read_journal')
            return { ok: true, entries: dayEntries }
          },
        },
        settingsStore: {
          getSnapshot: () => ({
            settings: { configSource: 'settings', activeProviderId: 'p-mm', activeAnthropicModel: '', providers },
            env: {},
          }),
          resolve: (pick) => {
            const prov = pick ? providers.find((p) => p.id === pick.providerId) ?? providers[0] : providers[0]
            return {
              configSource: 'settings',
              apiKey: prov.apiKey,
              authToken: prov.authToken,
              baseUrl: prov.baseUrl,
              model: pick?.anthropicModel || prov.model,
              supportsImages: true,
            }
          },
        },
        getWorkspaceState: () => ({
          projects: [{ id: 'p_ag', name: '【Mitchi Sentinel】AgentOS', path: '/tmp/AgentOS' }],
        }),
        getBroker: () => null,
        now: () => new Date('2026-11-22T02:00:00Z'),
        gitLogFetcher: async () => [],
        beforeScheduledAnalysis: async () => {
          callOrder.push('auto_tag')
          // Simulate local privacy auto-tagger flagging e_secret BEFORE cloud analysis reads it
          dayEntries[1].private = true
          dayEntries[1].autoApplied = { private: true }
        },
        callLlm: async (cfg, req) => {
          llmRunIndex += 1
          llmPrompts.push(req.messages[0].content)
          if (llmRunIndex === 1) {
            return {
              ok: true,
              model: cfg.model,
              durationMs: 15,
              text: JSON.stringify({
                ignoredNoiseCount: 0,
                todos: [
                  {
                    title: '隐藏未来日期同步按钮',
                    reason: '未来日期不应导入',
                    track: 'engineering',
                    urgency: 'medium',
                    suggestedProjectName: '【Mitchi Sentinel】AgentOS',
                    anchorEntryIds: ['e_fix'],
                    alreadyDone: false,
                  },
                ],
              }),
            }
          }
          // Second run (after cloud model switch): model tries to re-emit the already-done item (both via matchesExistingId and via duplicate title)
          const existingDoneId = svc.getOverview('2026-11-22').resolvedItems[0]?.id
          return {
            ok: true,
            model: cfg.model,
            durationMs: 15,
            text: JSON.stringify({
              ignoredNoiseCount: 0,
              todos: [
                {
                  matchesExistingId: existingDoneId,
                  title: '隐藏未来日期同步按钮',
                  reason: '再次提及',
                  track: 'engineering',
                  urgency: 'medium',
                  suggestedProjectName: '【Mitchi Sentinel】AgentOS',
                  anchorEntryIds: ['e_fix'],
                  alreadyDone: false,
                },
                {
                  title: '隐藏未来日期同步按钮',
                  reason: '重复标题兜底测试',
                  track: 'engineering',
                  urgency: 'medium',
                  suggestedProjectName: '【Mitchi Sentinel】AgentOS',
                  anchorEntryIds: ['e_fix'],
                  alreadyDone: false,
                },
              ],
            }),
          }
        },
      })

      await svc.saveConfig({ providerConsentAcknowledged: true, enabled: true })
      await svc.checkSchedule('boot')

      // Boot must run auto-tag BEFORE cloud LLM sees the journal, so e_secret is filtered out
      assert.equal(callOrder[0], 'auto_tag', 'beforeScheduledAnalysis must run before journal analysis on boot')
      assert.equal(llmPrompts.length, 1)
      assert.doesNotMatch(llmPrompts[0], /徐汇区/, 'entry marked private by beforeScheduledAnalysis must never reach cloud LLM')

      const ov1 = svc.getOverview('2026-11-22')
      assert.equal(ov1.pendingItems.length, 1)
      assert.equal(ov1.snapshot.stats.skippedPrivate, 1)
      assert.equal(ov1.snapshot.stats.newHumanEntries, 1)

      // Mark item done, switch cloud model -> forceReanalyze
      await svc.decideItem(ov1.pendingItems[0].id, { action: 'done' }, '2026-11-22')
      await svc.saveConfig({ modelPick: { providerId: 'p-ant', anthropicModel: 'claude-sonnet-4-6' } })
      const res2 = await svc.refreshAnalysis('2026-11-22')
      assert.equal(res2.ok, true)
      assert.equal(llmPrompts.length, 2)
      assert.match(llmPrompts[1], /当日已闭环/, 'closed items must be passed to prompt on re-analysis')
      assert.equal(res2.overview.pendingItems.length, 0, 'done item must never be resurrected as a duplicate pending item')
      assert.equal(res2.overview.resolvedItems.length, 1, 'resolved item count must remain 1 with zero duplicates')
      assert.equal(res2.overview.snapshot.stats.newHumanEntries, 1, 'forceReanalyze must not double-count newHumanEntries')
    } finally {
      rmSync(svcDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(deskRoot, { recursive: true, force: true })
  }
})
