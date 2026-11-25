import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const sourceText = readFileSync(resolvedPath, 'utf8').replace(/\bimport\.meta\.env\b/g, '({ DEV: false })')
  const { outputText } = ts.transpileModule(sourceText, {
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

test('language-push-service: strictly strips private entries and scrubs secrets before cloud egress, archives corpus silently, and stays idempotent', async () => {
  const { LanguagePushService } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-svc-'))

  try {
    const sentPrompts = []
    const journalByDate = {
      '2026-11-23': {
        entries: [
          {
            id: 'je_priv_1',
            date: '2026-11-23',
            time: '09:00',
            body: 'SECRET_PRIVATE_DIARY_MUST_NEVER_LEAK #私密',
            category: '生活',
            tags: [],
            private: true,
            provenance: 'human',
          },
          {
            id: 'je_pub_1',
            date: '2026-11-23',
            time: '10:00',
            body: '今天用测试密钥 sk-ant-api03-1234567890abcdef1234567890 调试模块解耦，希望架构更有韧性。',
            category: '工程',
            tags: [],
            private: false,
            provenance: 'human',
          },
        ],
      },
    }

    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({ ok: true, date, filePath: '', entries: journalByDate[date]?.entries ?? [] }),
      },
      settingsStore: {
        resolve: () => ({
          apiKey: 'dummy-test-key',
          authToken: '',
          baseUrl: 'https://example.invalid',
          model: 'test-model',
          configSource: 'settings',
        }),
        getSnapshot: () => ({
          settings: {
            activeProviderId: 'p1',
            providers: [{ id: 'p1', name: 'TestProvider', model: 'test-model' }],
          },
        }),
      },
      now: () => new Date('2026-11-23T06:00:00Z'),
      llmCaller: async (_cfg, req) => {
        const userText = req.messages.map((m) => m.content).join('\n')
        sentPrompts.push(userText)
        const isJa = userText.includes('Target language: Japanese')
        return {
          ok: true,
          model: 'test-model',
          durationMs: 42,
          text: JSON.stringify(
            isJa
              ? {
                  corpus: [
                    {
                      entryId: 'je_pub_1',
                      translatedText: '今日はモジュールの疎結合を調整し、より強靭な設計を目指した。',
                    },
                  ],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: '疎結合',
                      reading: 'そけつごう',
                      meaning: '松耦合',
                      grammarNote: null,
                      levelTag: 'N1',
                      exampleSentence: '疎結合な設計にすると拡張しやすい。',
                      exampleTranslation: '采用松耦合设计后更易于扩展。',
                      exampleReadings: [
                        { surface: '疎結合', reading: 'そけつごう' },
                        { surface: '設計', reading: 'せっけい' },
                        { surface: '拡張', reading: 'かくちょう' },
                      ],
                      sourceEntryId: 'je_pub_1',
                    },
                  ],
                }
              : {
                  corpus: [
                    {
                      entryId: 'je_pub_1',
                      translatedText: 'Debugged module decoupling today to build stronger architectural resilience.',
                    },
                  ],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: 'decoupling',
                      reading: '/diːˈkʌplɪŋ/',
                      meaning: '解耦；分离耦合关系',
                      grammarNote: null,
                      levelTag: 'B2',
                      exampleSentence: 'Module decoupling keeps upstream merges predictable.',
                      exampleTranslation: '模块解耦让上游合并保持可控。',
                      sourceEntryId: 'je_pub_1',
                    },
                  ],
                },
          ),
        }
      },
    })

    const res = await service.runExtraction({ date: '2026-11-23' })
    assert.equal(res.ok, true)
    assert.equal(sentPrompts.length, 2, 'must issue 1 dedicated call per enabled language (EN + JA)')
    for (const prompt of sentPrompts) {
      assert.equal(prompt.includes('SECRET_PRIVATE_DIARY_MUST_NEVER_LEAK'), false, 'private entry leaked!')
      assert.equal(prompt.includes('sk-ant-api03-1234567890'), false, 'API key was not scrubbed!')
    }
    assert.equal(res.overview.counts.todayTotal, 2)
    assert.equal(res.overview.lastRun.stats.skippedPrivate, 1)
    assert.equal(res.overview.lastRun.stats.corpusArchivedCount, 2)

    // Re-running without force must be idempotent (0 new cloud calls)
    const second = await service.runExtraction({ date: '2026-11-23' })
    assert.equal(second.ok, true)
    assert.equal(sentPrompts.length, 2, 'idempotent re-run must not re-call LLM for already processed entries')

    // Card familiarity decision updates overview immediately & feeds next extraction prompt
    const jaCard = res.overview.todayCards.find((c) => c.lang === 'ja')
    assert.ok(jaCard)
    const unfRes = await service.decideCard(jaCard.id, 'unfamiliar')
    assert.equal(unfRes.ok, true)
    assert.equal(unfRes.card.familiarity, 'unfamiliar')
    assert.equal(unfRes.overview.counts.unfamiliarTotal, 1)

    // Next day extraction injects both 7-day translated corpus high-freq candidates and familiarity history
    journalByDate['2026-11-24'] = {
      entries: [
        {
          id: 'je_pub_2',
          date: '2026-11-24',
          time: '11:00',
          body: '今天继续优化模块解耦，希望架构更加稳健。',
          category: '工程',
          tags: [],
          private: false,
          provenance: 'human',
        },
      ],
    }
    const day2 = await service.runExtraction({ date: '2026-11-24' })
    assert.equal(day2.ok, true)
    const jaDay2Prompt = sentPrompts.slice(2).find((p) => p.includes('Target language: Japanese'))
    assert.ok(jaDay2Prompt, 'expected JA prompt on day 2')
    assert.ok(jaDay2Prompt.includes('疎結合'), 'day 2 prompt must inject unfamiliar familiarity history & 7-day corpus terms')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('registerLanguagePushIpc: registers 5 channels lazily and cleans up cleanly', async () => {
  const { DESKTOP_INVOKE_CHANNELS } = loadTsModule(resolve(rootDir, 'src/desktop-seam.ts'))
  const { registerLanguagePushIpc } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-ipc.ts'))

  const handlers = new Map()
  const removed = []
  const fakeIpc = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => {
      removed.push(ch)
      handlers.delete(ch)
    },
  }

  let getterCount = 0
  const fakeService = {
    getOverview: (date) => ({ todayCards: [], ...(typeof date === 'string' ? { selectedDate: date } : {}) }),
    runExtraction: (opts) => ({ ok: true, opts }),
    decideCard: (id, action, date) => ({
      ok: true,
      id,
      action,
      ...(typeof date === 'string' ? { date } : {}),
    }),
    getConfig: () => ({ dailyLimit: 8 }),
    saveConfig: (patch) => ({ dailyLimit: 8, ...patch }),
    speak: (input) => ({ ok: true, input }),
  }

  const dispose = registerLanguagePushIpc(fakeIpc, () => {
    getterCount += 1
    return fakeService
  })
  assert.equal(getterCount, 0)
  assert.equal(handlers.size, 6)
  assert.deepEqual(handlers.get(DESKTOP_INVOKE_CHANNELS.decideLanguagePushCard)({}, 'lp_1', 'invalid_action'), {
    ok: true,
    id: 'lp_1',
    action: 'fuzzy',
  })
  assert.deepEqual(handlers.get(DESKTOP_INVOKE_CHANNELS.getLanguagePushOverview)({}, '2026-11-20'), {
    todayCards: [],
    selectedDate: '2026-11-20',
  })
  assert.deepEqual(handlers.get(DESKTOP_INVOKE_CHANNELS.getLanguagePushOverview)({}, 42), {
    todayCards: [],
  })
  assert.deepEqual(
    handlers.get(DESKTOP_INVOKE_CHANNELS.decideLanguagePushCard)({}, 'lp_9', 'familiar', '2026-11-20'),
    { ok: true, id: 'lp_9', action: 'familiar', date: '2026-11-20' },
  )
  assert.deepEqual(handlers.get(DESKTOP_INVOKE_CHANNELS.decideLanguagePushCard)({}, 'lp_9', 'familiar', 42), {
    ok: true,
    id: 'lp_9',
    action: 'familiar',
  })
  assert.equal(getterCount, 5)
  dispose()
  assert.equal(handlers.size, 0)
  assert.equal(removed.length, 6)
})

test('language-push date archive: getOverview(date) and decideCard(id, action, pastDate) keep selectedDate', async () => {
  const { LanguagePushService } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-date-svc-'))

  try {
    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({ ok: true, date, filePath: '', entries: [] }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'k', authToken: '', baseUrl: '', model: 'm', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p', providers: [{ id: 'p', name: 'P', model: 'm' }] } }),
      },
      now: () => new Date('2026-11-24T06:00:00Z'),
    })

    await service.store.mergeExtractionResult({
      logicalDate: '2026-11-20',
      providerName: 'Test',
      modelUsed: 'test-model',
      processedEntryIds: ['e1:en', 'e1:ja'],
      corpusItems: [
        { entryId: 'e1', sourceDate: '2026-11-20', lang: 'en', translatedText: 'Archived note from Nov 20.' },
      ],
      candidates: [
        {
          lang: 'en',
          kind: 'vocab',
          surface: 'resilient',
          reading: '/rɪˈzɪliənt/',
          meaning: '有韧性的',
          levelTag: 'B2',
          exampleSentence: 'A resilient layout survives window resizing.',
          exampleTranslation: '有韧性的布局经得起窗口缩放。',
          sourceDate: '2026-11-20',
          sourceEntryId: 'e1',
        },
        {
          lang: 'ja',
          kind: 'grammar',
          surface: 'にもかかわらず',
          reading: 'にもかかわらず',
          meaning: '尽管',
          levelTag: 'N2',
          exampleSentence: '忙しいにもかかわらず続けた。',
          exampleTranslation: '尽管很忙还是继续了。',
          sourceDate: '2026-11-20',
          sourceEntryId: 'e1',
        },
      ],
      statsBase: { scannedEntries: 1, eligibleEntries: 1, skippedPrivate: 0, skippedAlreadyProcessed: 0, durationMs: 10 },
    })

    const past = service.getOverview('2026-11-20')
    assert.equal(past.selectedDate, '2026-11-20')
    assert.equal(past.todayDate, '2026-11-24')
    assert.equal(past.todayCards.length, 2)
    assert.equal(past.counts.todayTotal, 2)
    assert.equal(past.counts.todayVocab, 1)
    assert.equal(past.counts.todayGrammar, 1)
    const marker = past.calendarMarkers.find((item) => item.date === '2026-11-20')
    assert.ok(marker)
    assert.equal(marker.cardCount, 2)
    assert.equal(marker.hasRun, true)
    assert.equal(marker.hasCorpus, true)
    const markerDates = past.calendarMarkers.map((item) => item.date)
    assert.deepEqual(markerDates, [...markerDates].sort())

    const grammar = past.todayCards.find((card) => card.kind === 'grammar')
    assert.ok(grammar)
    const decided = await service.decideCard(grammar.id, 'unfamiliar', '2026-11-20')
    assert.equal(decided.ok, true)
    assert.equal(decided.overview.selectedDate, '2026-11-20')
    assert.equal(decided.overview.todayDate, '2026-11-24')
    assert.equal(decided.overview.todayCards[0]?.id, grammar.id)
    assert.equal(decided.overview.todayCards.some((card) => card.surface === 'resilient'), true)
    assert.equal(decided.overview.counts.backlogTotal, service.getOverview().counts.backlogTotal)
    assert.equal(decided.overview.counts.masteredTotal, service.getOverview().counts.masteredTotal)
    assert.equal(decided.overview.counts.corpusDaysCount, service.getOverview().counts.corpusDaysCount)

    const invalid = service.getOverview('not-a-date')
    assert.equal(invalid.selectedDate, '2026-11-24')
    assert.equal(invalid.todayDate, '2026-11-24')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('language-push host wiring, single-line desk mount IPC delegation, and 1:1 zh/en locale parity', () => {
  const { PINNED_MODULES } = loadTsModule(resolve(rootDir, 'src/components/pinned-modules.ts'))
  const { normalizeViewId, VIEW_HEADING_KEYS } = loadTsModule(resolve(rootDir, 'src/components/app-shell-constants.ts'))
  const mainSource = readFileSync(resolve(rootDir, 'electron/main.ts'), 'utf8')
  const mountSource = readFileSync(resolve(rootDir, 'sentinel-desk/main/mount.ts'), 'utf8')
  const workspaceSource = readFileSync(resolve(rootDir, 'src/components/AppShellWorkspace.tsx'), 'utf8')
  const pageSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')
  const cardSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguageCard.tsx'), 'utf8')
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/en.json'), 'utf8'))

  assert.equal(PINNED_MODULES[3]?.id, 'language-push')
  assert.equal(normalizeViewId('language-push'), 'language-push')
  assert.equal(VIEW_HEADING_KEYS['language-push'], 'shell.viewLanguagePush')

  // Obeys AGENTS.md guardrail: single-line delegation in the desk mount, zero flat handlers
  assert.match(mountSource, /registerLanguagePushIpc\(\s*host\.ipcMain\s*,\s*getLanguagePushService\s*\)/)
  assert.doesNotMatch(mountSource, /ipcMain\.handle\(\s*DESKTOP_INVOKE_CHANNELS\.getLanguagePushOverview\b/)
  assert.doesNotMatch(mainSource, /registerLanguagePushIpc|DESKTOP_INVOKE_CHANNELS\.getLanguagePushOverview\b/)
  assert.match(workspaceSource, /activeViewId === 'language-push'/)
  assert.match(pageSource, /import\s+['"]\.\.\/\.\.\/styles\/language-push-page\.css['"]/)

  const referencedKeys = new Set()
  for (const src of [pageSource, cardSource]) {
    for (const match of src.matchAll(/t\('languagePush\.([a-zA-Z0-9_]+)'/g)) {
      referencedKeys.add(match[1])
    }
  }
  assert.ok(referencedKeys.size >= 30, 'expected substantial languagePush i18n keys')
  for (const key of referencedKeys) {
    assert.equal(typeof zh.languagePush?.[key], 'string', `missing zh.languagePush.${key}`)
    assert.equal(typeof en.languagePush?.[key], 'string', `missing en.languagePush.${key}`)
  }
  assert.equal(typeof zh.shell.viewLanguagePush, 'string')
  assert.equal(typeof en.shell.viewLanguagePush, 'string')
  assert.equal(typeof zh.sidebar.pinnedLanguagePush, 'string')
  assert.equal(typeof en.sidebar.pinnedLanguagePush, 'string')
})

test('language-push-analyzer: gives MiniMax-M3.1-Flash 16384 maxTokens + low effort and recovers via 1 repair retry after max_tokens truncation', async () => {
  const { analyzeJournalForLanguagePush } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-analyzer.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  const calls = []
  const out = await analyzeJournalForLanguagePush({
    logicalDate: '2026-11-23',
    entries: [
      {
        id: 'je_mm_1',
        date: '2026-11-23',
        time: '12:00',
        body: '今天排查了推理模型因为思考消耗完输出预算导致空文本的问题。',
        category: '工程',
        tags: [],
        private: false,
        provenance: 'human',
      },
    ],
    processedEntryIds: {},
    config: { ...LANGUAGE_PUSH_DEFAULT_CONFIG, enabledLangs: ['en'] },
    resolvedModel: {
      apiKey: 'dummy',
      authToken: '',
      baseUrl: 'https://example.invalid',
      model: 'MiniMax-M3.1-Flash',
    },
    llmCaller: async (_cfg, req) => {
      calls.push(req)
      if (calls.length === 1) {
        return {
          ok: true,
          model: 'MiniMax-M3.1-Flash',
          stopReason: 'max_tokens',
          durationMs: 25,
          text: '',
          usage: { inputTokens: 400, outputTokens: 16384 },
        }
      }
      return {
        ok: true,
        model: 'MiniMax-M3.1-Flash',
        stopReason: 'end_turn',
        durationMs: 20,
        text: '```json\n{"corpus":[{"entryId":"je_mm_1","translatedText":"Diagnosed empty output caused by reasoning budget exhaustion."}],"cards":[{"kind":"vocab","surface":"exhaustion","reading":"/ɪɡˈzɔːstʃən/","meaning":"耗尽；枯竭","grammarNote":null,"levelTag":"B2","exampleSentence":"Token budget exhaustion prevented JSON output.","exampleTranslation":"Token 预算耗尽导致未能输出 JSON。","sourceEntryId":"je_mm_1",}]}\n```',
        usage: { inputTokens: 420, outputTokens: 180 },
      }
    },
  })

  assert.equal(out.ok, true)
  assert.equal(calls.length, 2, 'expected automatic 1-pass repair retry')
  assert.equal(calls[0].maxTokens, 16384)
  assert.equal(calls[0].effort, 'low')
  assert.equal(out.candidates.length, 1)
  assert.equal(out.candidates[0].surface, 'exhaustion')
})

test('language-push-validator & tts: rejects Simplified Chinese/Arabic/code leaks in JA, repairs cleanly, and rewrites kanji to hiragana for MiniMax TTS', async () => {
  const { validateLanguageCard } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-validator.ts'))
  const { prepareMiniMaxTtsText } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-tts.ts'))
  const { analyzeJournalForLanguagePush } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-analyzer.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  // Exact failure modes observed in user screenshot & deck.json
  assert.equal(
    validateLanguageCard({
      lang: 'ja',
      kind: 'grammar',
      surface: '〜ても、〜なければならない',
      reading: '/ても、なければならない/',
      meaning: '即使……也得……',
      exampleSentence: '生成されたものが有用かどうかにかかわらず、人机互动の環境を打ち الثالثとropolisなければなりません。',
    }).ok,
    false,
  )
  assert.equal(
    validateLanguageCard({
      lang: 'ja',
      kind: 'vocab',
      surface: '高頻度プロンプト',
      reading: 'こうひんどぷろんぷと',
      meaning: '高频提示词',
      exampleSentence: '開発流程で高頻度プロンプトをまとめ、kis管理できる页面にする。',
    }).ok,
    false,
  )

  const cleanCheck = validateLanguageCard({
    lang: 'ja',
    kind: 'grammar',
    surface: '〜にかかわらず',
    reading: '/にかかわらず/',
    meaning: '不管……都……',
    exampleSentence: '生成されたものが有用かどうかにかかわらず、環境を整えなければならない。',
  })
  assert.equal(cleanCheck.ok, true)
  assert.equal(cleanCheck.normalizedReading, 'にかかわらず', 'must strip accidental slashes from JA kana reading')

  // Built-in + per-sentence kanji->kana disambiguation prevents Mandarin accent in MiniMax TTS
  const spoken = prepareMiniMaxTtsText(
    '生成されたものが有用かどうかにかかわらず、環境を整えなければならない。',
    'ja',
    [{ surface: '整え', reading: 'ととのえ' }],
  )
  assert.equal(spoken.includes('せいせいされたものが'), true)
  assert.equal(spoken.includes('ゆうようかどうかにかかわらず'), true)
  assert.equal(spoken.includes('かんきょうをととのえ'), true)

  // Standalone single kanji word resolves directly to pure kana reading
  assert.equal(prepareMiniMaxTtsText('生成', 'ja', [{ surface: '生成', reading: 'せいせい' }]), 'せいせい')

  // Automatic quality repair retry recovers when pass 1 emits corrupted Japanese
  let jaCalls = 0
  const repaired = await analyzeJournalForLanguagePush({
    logicalDate: '2026-11-23',
    entries: [
      {
        id: 'je_ja_1',
        date: '2026-11-23',
        time: '12:00',
        body: '不管生成的内容有没有用，都要打造人机协作的环境。',
        category: '工程',
        tags: [],
        private: false,
        provenance: 'human',
      },
    ],
    processedEntryIds: {},
    config: { ...LANGUAGE_PUSH_DEFAULT_CONFIG, enabledLangs: ['ja'] },
    resolvedModel: { apiKey: 'dummy', authToken: '', baseUrl: 'https://example.invalid', model: 'MiniMax-M3.1-Flash' },
    llmCaller: async (_cfg, req) => {
      jaCalls += 1
      assert.equal(req.effort, 'low', 'MiniMax-M3.1-Flash must use low effort to avoid 90s thinking timeout')
      if (jaCalls === 1) {
        return {
          ok: true,
          model: 'MiniMax-M3.1-Flash',
          durationMs: 20,
          text: JSON.stringify({
            corpus: [],
            cards: [
              {
                kind: 'grammar',
                surface: '〜ても',
                reading: 'ても',
                meaning: '即使',
                exampleSentence: '人机互动の環境を打ち الثالثとropolis。',
                exampleTranslation: '打造人机互动环境。',
                sourceEntryId: 'je_ja_1',
              },
            ],
          }),
        }
      }
      return {
        ok: true,
        model: 'MiniMax-M3.1-Flash',
        durationMs: 20,
        text: JSON.stringify({
          corpus: [{ entryId: 'je_ja_1', translatedText: '生成された内容が有用かどうかにかかわらず、人とAIが協働する環境を整える必要がある。' }],
          cards: [
            {
              kind: 'grammar',
              surface: '〜にかかわらず',
              reading: 'にかかわらず',
              meaning: '不管……都……',
              grammarNote: '接在名词或「〜かどうか」后，表示不受前项影响。',
              levelTag: 'N2',
              exampleSentence: '生成された内容が有用かどうかにかかわらず、人とAIが協働する環境を整える必要がある。',
              exampleTranslation: '不管生成的内容是否有用，都需要搭建人机协作的环境。',
              exampleReadings: [
                { surface: '生成', reading: 'せいせい' },
                { surface: '内容', reading: 'ないよう' },
                { surface: '有用', reading: 'ゆうよう' },
                { surface: '協働', reading: 'きょうどう' },
                { surface: '環境', reading: 'かんきょう' },
              ],
              sourceEntryId: 'je_ja_1',
            },
          ],
        }),
      }
    },
  })
  assert.equal(repaired.ok, true)
  assert.equal(jaCalls, 2)
  assert.equal(repaired.candidates.length, 1)
  assert.equal(repaired.candidates[0].examplePronunciations.length, 5)
})

test('language-push-tts: resolves MiniMax origin from anthropic baseUrl, synthesizes HD MP3, applies JA hints, and serves second call from disk cache', async () => {
  const {
    prepareMiniMaxTtsText,
    resolveMiniMaxTtsCredentials,
    synthesizeLanguagePushSpeech,
  } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-tts.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  const creds = resolveMiniMaxTtsCredentials({
    settings: {
      providers: [
        {
          id: 'p1',
          name: 'MiniMax-CN',
          presetId: 'minimax',
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: 'mm-test-key',
        },
      ],
    },
  })
  assert.deepEqual(creds, {
    apiKey: 'mm-test-key',
    origin: 'https://api.minimaxi.com',
    model: 'speech-2.8-hd',
  })

  assert.equal(
    prepareMiniMaxTtsText('7時10分に疎結合（そけつごう）を設計する', 'ja', [
      { surface: '疎結合', reading: 'そけつごう' },
    ]),
    '7じ10ぷんにそけつごうをせっけいする',
  )

  const tempCache = mkdtempSync(join(tmpdir(), 'agentos-lp-tts-'))
  try {
    const requests = []
    const fakeFetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          base_resp: { status_code: 0, status_msg: 'success' },
          data: { audio: Buffer.from('ID3-fake-mp3-bytes').toString('hex') },
        }),
      }
    }

    const first = await synthesizeLanguagePushSpeech({
      credentials: creds,
      config: LANGUAGE_PUSH_DEFAULT_CONFIG,
      input: { text: 'Resilience under pressure.', lang: 'en' },
      cacheDir: tempCache,
      fetchFn: fakeFetch,
    })
    assert.equal(first.ok, true)
    assert.equal(first.cached, false)
    assert.equal(first.voiceId, 'English_Graceful_Lady')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.minimaxi.com/v1/t2a_v2')
    assert.equal(requests[0].body.model, 'speech-2.8-hd')
    assert.equal(requests[0].body.language_boost, 'English')

    const second = await synthesizeLanguagePushSpeech({
      credentials: creds,
      config: LANGUAGE_PUSH_DEFAULT_CONFIG,
      input: { text: 'Resilience under pressure.', lang: 'en' },
      cacheDir: tempCache,
      fetchFn: fakeFetch,
    })
    assert.equal(second.ok, true)
    assert.equal(second.cached, true)
    assert.equal(requests.length, 1, 'second call must hit local disk MP3 cache')
    assert.equal(second.audioBase64, first.audioBase64)
  } finally {
    rmSync(tempCache, { recursive: true, force: true })
  }
})

test('language-push morning brief corpus: provider maps issue items to mb_ entries and round-robins with journal without starvation, preserving sourceKind end-to-end', async () => {
  const { LanguagePushService, createMorningBriefCorpusProvider } = loadTsModule(
    resolve(rootDir, 'electron/desk/language-push-service.ts'),
  )
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-mb-'))

  try {
    // --- Provider unit seam: maps MorningBriefIssue items into corpus entries ---
    const briefIssue = {
      date: '2026-11-23',
      issueTag: '#每日AI早报',
      items: [
        { id: 'story-1', title: 'OpenAI 发布新模型', body: '新一代推理模型在编码基准上大幅领先。', sourceName: 'OpenAI', sourceUrl: 'https://example.com/1', category: '模型与研究' },
        { id: 'story-2', title: '某 Coding Agent 开源', body: '终端智能体框架发布 2.0 版本。', sourceName: 'GitHub', sourceUrl: 'https://example.com/2', category: '开源与工具' },
        { id: 'story-3', title: '   ', body: '', sourceName: 'Empty', sourceUrl: 'https://example.com/3', category: '产业与监管' },
      ],
    }
    const provider = createMorningBriefCorpusProvider({
      getIssue: (date) => (date === '2026-11-23' ? briefIssue : null),
    })
    assert.equal(provider.kind, 'morning_brief')
    assert.deepEqual(await provider.readEntriesForDate('2026-11-24'), [], 'missing issue must yield []')
    const briefEntries = await provider.readEntriesForDate('2026-11-23')
    assert.equal(briefEntries.length, 2, 'empty title+body item must be dropped')
    assert.equal(briefEntries[0].id, 'mb_2026-11-23_story-1')
    assert.equal(briefEntries[0].date, '2026-11-23')
    assert.equal(briefEntries[0].time, '04:30')
    assert.ok(briefEntries[0].body.includes('OpenAI 发布新模型：'), 'title and body must join with ：')
    assert.equal(briefEntries[0].private, false)

    // --- Service seam: 6 journal entries + 4 brief items must share the daily budget ---
    const journalEntries = Array.from({ length: 6 }, (_, i) => ({
      id: `je_j${i + 1}`,
      date: '2026-11-23',
      time: `0${i + 1}:00`,
      body: `日记第 ${i + 1} 条：今天继续打磨系统韧性与模块边界设计。`,
      category: '工程',
      tags: [],
      private: false,
      provenance: 'human',
    }))
    const briefItems = Array.from({ length: 4 }, (_, i) => ({
      id: `story-${i + 1}`,
      title: `早报第 ${i + 1} 条标题`,
      body: `早报第 ${i + 1} 条正文，介绍业界动态。`,
      sourceName: 'Feed',
      sourceUrl: `https://example.com/${i + 1}`,
      category: '模型与研究',
    }))

    const sentPrompts = []
    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({
          ok: true,
          date,
          filePath: '',
          entries: date === '2026-11-23' ? journalEntries : [],
        }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'dummy', authToken: '', baseUrl: 'https://example.invalid', model: 'test-model', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [{ id: 'p1', name: 'TestProvider', model: 'test-model' }] } }),
      },
      extraCorpusProviders: [
        createMorningBriefCorpusProvider({
          getIssue: (date) => (date === '2026-11-23' ? { date, issueTag: '#每日AI早报', items: briefItems } : null),
        }),
      ],
      now: () => new Date('2026-11-23T06:00:00Z'),
      llmCaller: async (_cfg, req) => {
        const userText = req.messages.map((m) => m.content).join('\n')
        sentPrompts.push(userText)
        const isJa = userText.includes('Target language: Japanese')
        return {
          ok: true,
          model: 'test-model',
          durationMs: 10,
          text: JSON.stringify(
            isJa
              ? {
                  corpus: [{ entryId: 'je_j1', translatedText: '今日もシステムの回復力と設計境界を磨き続けた。' }],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: '回復力',
                      reading: 'かいふくりょく',
                      meaning: '韧性；恢复力',
                      grammarNote: null,
                      levelTag: 'N1',
                      exampleSentence: '回復力の高い設計を目指した。',
                      exampleTranslation: '目标是高韧性的设计。',
                      exampleReadings: [
                        { surface: '回復力', reading: 'かいふくりょく' },
                        { surface: '設計', reading: 'せっけい' },
                      ],
                      sourceEntryId: 'je_j1',
                    },
                  ],
                }
              : {
                  corpus: [
                    { entryId: 'je_j1', translatedText: 'Kept polishing system resilience and module boundaries today.' },
                    { entryId: 'mb_2026-11-23_story-1', translatedText: 'Brief item one covered fresh industry momentum.' },
                  ],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: 'resilience',
                      reading: '/rɪˈzɪliəns/',
                      meaning: '韧性；恢复力',
                      grammarNote: null,
                      levelTag: 'B2',
                      exampleSentence: 'System resilience improves with clear module boundaries.',
                      exampleTranslation: '清晰的模块边界能提升系统韧性。',
                      sourceEntryId: 'je_j1',
                    },
                    {
                      kind: 'vocab',
                      surface: 'momentum',
                      reading: '/məˈmentəm/',
                      meaning: '势头；动能',
                      grammarNote: null,
                      levelTag: 'B2',
                      exampleSentence: 'The briefing tracked fresh momentum across the industry.',
                      exampleTranslation: '早报追踪了行业内的新势头。',
                      sourceEntryId: 'mb_2026-11-23_story-1',
                    },
                  ],
                },
          ),
        }
      },
    })

    const res = await service.runExtraction({ date: '2026-11-23' })
    assert.equal(res.ok, true)
    assert.equal(sentPrompts.length, 2)
    const enPrompt = sentPrompts.find((p) => p.includes('Target language: English'))
    assert.ok(enPrompt)
    const entryHeaders = enPrompt.match(/^--- \[/gm) ?? []
    assert.equal(entryHeaders.length, 8, 'daily budget must widen to 8 entries')
    assert.ok(enPrompt.includes('Morning Brief'), 'entry header must tag morning brief provenance')
    assert.ok(enPrompt.includes('Journal'), 'entry header must tag journal provenance')
    const journalPicked = [1, 2, 3, 4, 5, 6].filter((i) => enPrompt.includes(`[je_j${i}]`))
    const briefPicked = [1, 2, 3, 4].filter((i) => enPrompt.includes(`[mb_2026-11-23_story-${i}]`))
    assert.equal(journalPicked.length, 4, 'round-robin must not let 6 journal entries starve the brief')
    assert.equal(briefPicked.length, 4, 'round-robin must not let the brief starve journal entries')

    const enCards = res.overview.todayCards.filter((c) => c.lang === 'en')
    const journalCard = enCards.find((c) => c.example.sourceEntryId === 'je_j1')
    const briefCard = enCards.find((c) => c.example.sourceEntryId === 'mb_2026-11-23_story-1')
    assert.ok(journalCard && briefCard)
    assert.equal(journalCard.example.sourceKind, 'journal')
    assert.equal(briefCard.example.sourceKind, 'morning_brief', 'card must preserve morning_brief provenance')

    const corpusOnDisk = JSON.parse(readFileSync(join(tempRoot, 'language', 'corpus', '2026', '11', '2026-11-23.json'), 'utf8'))
    const corpusKinds = new Map(corpusOnDisk.items.map((item) => [`${item.entryId}:${item.lang}`, item.sourceKind]))
    assert.equal(corpusKinds.get('je_j1:en'), 'journal')
    assert.equal(corpusKinds.get('mb_2026-11-23_story-1:en'), 'morning_brief', 'archived corpus must preserve morning_brief sourceKind')

    // Idempotent re-run: the 2 journal entries that overflowed the daily budget of 8 are
    // picked up, but nothing already processed (journal or brief) is ever re-extracted.
    const second = await service.runExtraction({ date: '2026-11-23' })
    assert.equal(second.ok, true)
    assert.equal(sentPrompts.length, 4, 'second run must only process the 2 leftover journal entries (1 call per language)')
    for (const prompt of sentPrompts.slice(2)) {
      assert.ok(prompt.includes('[je_j5]') && prompt.includes('[je_j6]'))
      assert.equal(prompt.includes('[mb_'), false, 'already-processed brief entries must not be re-extracted')
      assert.equal(prompt.includes('[je_j1]'), false, 'already-processed journal entries must not be re-extracted')
    }
    const third = await service.runExtraction({ date: '2026-11-23', force: false })
    assert.equal(third.ok, true)
    assert.equal(sentPrompts.length, 4, 'third run must be a complete no-op (all entries processed)')
    service.dispose()
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('language-push-analyzer: morning_brief entries bypass the journal human-provenance filter while journal ai entries stay excluded', async () => {
  const { analyzeJournalForLanguagePush } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-analyzer.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  const out = await analyzeJournalForLanguagePush({
    logicalDate: '2026-11-23',
    entries: [
      {
        id: 'je_ai_1',
        date: '2026-11-23',
        time: '08:00',
        body: '这条是 AI 自动生成的日记摘要，不应进入外语提取语料。',
        category: '工程',
        tags: [],
        private: false,
        provenance: 'ai',
      },
      {
        id: 'mb_2026-11-23_story-9',
        date: '2026-11-23',
        time: '04:30',
        body: '早报条目：新一代推理模型在编码基准上大幅领先。',
        category: '模型与研究',
        tags: ['#每日AI早报'],
        private: false,
        provenance: 'ai',
        sourceKind: 'morning_brief',
      },
    ],
    processedEntryIds: {},
    config: { ...LANGUAGE_PUSH_DEFAULT_CONFIG, enabledLangs: ['en'] },
    resolvedModel: { apiKey: 'dummy', authToken: '', baseUrl: 'https://example.invalid', model: 'test-model' },
    llmCaller: async () => ({
      ok: true,
      model: 'test-model',
      durationMs: 5,
      text: JSON.stringify({
        corpus: [{ entryId: 'mb_2026-11-23_story-9', translatedText: 'A new reasoning model leapt ahead on coding benchmarks.' }],
        cards: [
          {
            kind: 'vocab',
            surface: 'benchmark',
            reading: '/ˈbentʃmɑːk/',
            meaning: '基准测试',
            grammarNote: null,
            levelTag: 'B2',
            exampleSentence: 'The model leapt ahead on coding benchmarks.',
            exampleTranslation: '该模型在编码基准上大幅领先。',
            sourceEntryId: 'mb_2026-11-23_story-9',
          },
        ],
      }),
    }),
  })

  assert.equal(out.ok, true)
  assert.equal(out.statsBase.eligibleEntries, 1, 'morning_brief entry must survive the provenance filter; journal ai entry must not')
  assert.equal(out.corpusItems[0].sourceKind, 'morning_brief')
  assert.equal(out.candidates[0].sourceKind, 'morning_brief')
})

test('language-push scheduler: legacy config normalizes to 05:00, 04:59 stays quiet, 05:00 auto-runs once, retries cap at 3, startup catch-up fires and dispose cleans up', async () => {
  const { LanguagePushService } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-service.ts'))

  const makeHarness = (tempRoot, { nowRef, llmOk = true, startupCheckDelayMs } = {}) => {
    const counters = { llmCalls: 0 }
    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({
          ok: true,
          date,
          filePath: '',
          entries:
            date === '2026-11-24'
              ? [
                  {
                    id: 'je_sched_1',
                    date: '2026-11-24',
                    time: '04:35',
                    body: '今天继续推进外语推送的定时调度与早报语料接入。',
                    category: '工程',
                    tags: [],
                    private: false,
                    provenance: 'human',
                  },
                ]
              : [],
        }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'dummy', authToken: '', baseUrl: 'https://example.invalid', model: 'test-model', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [{ id: 'p1', name: 'P1', model: 'test-model' }] } }),
      },
      now: () => nowRef.current,
      startupCheckDelayMs,
      llmCaller: async (_cfg, req) => {
        counters.llmCalls += 1
        if (!llmOk) return { ok: false, kind: 'provider_error', message: 'boom' }
        const userText = req.messages.map((m) => m.content).join('\n')
        const isJa = userText.includes('Target language: Japanese')
        return {
          ok: true,
          model: 'test-model',
          durationMs: 5,
          text: JSON.stringify(
            isJa
              ? {
                  corpus: [{ entryId: 'je_sched_1', translatedText: '今朝は定時実行と朝のニュース速報コーパスの接続を進めた。' }],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: '定時実行',
                      reading: 'ていじじっこう',
                      meaning: '定时执行',
                      grammarNote: null,
                      levelTag: 'N1',
                      exampleSentence: '定時実行で毎朝の抽出を自動化する。',
                      exampleTranslation: '通过定时执行把每天早上的提取自动化。',
                      exampleReadings: [
                        { surface: '定時実行', reading: 'ていじじっこう' },
                        { surface: '毎朝', reading: 'まいあさ' },
                        { surface: '抽出', reading: 'ちゅうしゅつ' },
                        { surface: '自動化', reading: 'じどうか' },
                      ],
                      sourceEntryId: 'je_sched_1',
                    },
                  ],
                }
              : {
                  corpus: [{ entryId: 'je_sched_1', translatedText: 'Kept wiring the 05:00 schedule and morning brief corpus today.' }],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: 'schedule',
                      reading: '/ˈʃedjuːl/',
                      meaning: '调度；日程',
                      grammarNote: null,
                      levelTag: 'B2',
                      exampleSentence: 'The schedule triggers extraction at 05:00 sharp.',
                      exampleTranslation: '调度在 05:00 准时触发提取。',
                      sourceEntryId: 'je_sched_1',
                    },
                  ],
                },
          ),
        }
      },
    })
    return { service, counters }
  }

  // Legacy persisted config (exactly the user's live shape) normalizes to 05:00
  const legacyRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-legacy-'))
  try {
    mkdirSync(join(legacyRoot, 'language'), { recursive: true })
    writeFileSync(
      join(legacyRoot, 'language', 'config.json'),
      JSON.stringify({ cutoverHour: 4, autoRunEnabled: true, modelPick: { providerId: 'p1', anthropicModel: 'deepseek-flash' } }),
    )
    const nowRef = { current: new Date('2026-11-23T20:59:00Z') } // 2026-11-24 04:59 Asia/Shanghai
    const { service, counters } = makeHarness(legacyRoot, { nowRef })
    try {
      const cfg = service.store.getConfig()
      assert.equal(cfg.cutoverHour, 4)
      assert.equal(cfg.autoRunEnabled, true)
      assert.equal(cfg.scheduleHour, 5, 'legacy config must default scheduleHour to 5')
      assert.equal(cfg.scheduleMinute, 0, 'legacy config must default scheduleMinute to 0')

      await service.checkSchedule()
      assert.equal(counters.llmCalls, 0, '04:59 Asia/Shanghai must NOT trigger extraction')
      assert.equal(service.store.hasRunFor('2026-11-24'), false)

      nowRef.current = new Date('2026-11-23T21:00:00Z') // 05:00 Asia/Shanghai
      await service.checkSchedule()
      assert.equal(counters.llmCalls, 2, '05:00 Asia/Shanghai must auto-trigger (1 call per language)')
      assert.equal(service.store.hasRunFor('2026-11-24'), true)

      await service.checkSchedule()
      assert.equal(counters.llmCalls, 2, 'same logical day must stay idempotent (run file already exists)')
    } finally {
      service.dispose()
    }
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
  }

  // Retry cap: at most 3 automatic attempts per logical day when the provider keeps failing
  const retryRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-retry-'))
  try {
    const nowRef = { current: new Date('2026-11-23T21:05:00Z') }
    const { service, counters } = makeHarness(retryRoot, { nowRef, llmOk: false })
    try {
      await service.checkSchedule()
      await service.checkSchedule()
      await service.checkSchedule()
      await service.checkSchedule()
      assert.equal(counters.llmCalls, 6, 'failed auto-runs must stop after 3 attempts (3 runs × 2 languages)')
    } finally {
      service.dispose()
    }
  } finally {
    rmSync(retryRoot, { recursive: true, force: true })
  }

  // Startup catch-up timer fires after start() without waiting for the 5-minute tick
  const bootRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-boot-'))
  try {
    const nowRef = { current: new Date('2026-11-23T22:30:00Z') } // 06:30 Asia/Shanghai
    const { service, counters } = makeHarness(bootRoot, { nowRef, startupCheckDelayMs: 5 })
    try {
      service.start()
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(counters.llmCalls, 2, 'startup catch-up timer must trigger the missed 05:00 run')
      assert.equal(service.store.hasRunFor('2026-11-24'), true)
    } finally {
      service.dispose()
    }
  } finally {
    rmSync(bootRoot, { recursive: true, force: true })
  }

  // dispose() before the startup delay must cancel the pending catch-up timer
  const cancelRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-cancel-'))
  try {
    const nowRef = { current: new Date('2026-11-23T22:30:00Z') }
    const { service, counters } = makeHarness(cancelRoot, { nowRef, startupCheckDelayMs: 20 })
    service.start()
    service.dispose()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(counters.llmCalls, 0, 'disposed service must never run the startup catch-up')
  } finally {
    rmSync(cancelRoot, { recursive: true, force: true })
  }

  // notifySystemResumeOrFocus and saveConfig({autoRunEnabled:true}) both re-check the schedule
  const resumeRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-resume-'))
  try {
    const nowRef = { current: new Date('2026-11-23T22:30:00Z') }
    const { service, counters } = makeHarness(resumeRoot, { nowRef })
    try {
      service.notifySystemResumeOrFocus()
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(counters.llmCalls, 2, 'resume/focus must trigger the missed run')

      const secondRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-savecfg-'))
      try {
        const { service: svc2, counters: c2 } = makeHarness(secondRoot, { nowRef })
        try {
          await svc2.saveConfig({ autoRunEnabled: true })
          await new Promise((r) => setTimeout(r, 40))
          assert.equal(c2.llmCalls, 2, 'enabling autoRunEnabled via saveConfig must trigger the schedule check')
        } finally {
          svc2.dispose()
        }
      } finally {
        rmSync(secondRoot, { recursive: true, force: true })
      }
    } finally {
      service.dispose()
    }
  } finally {
    rmSync(resumeRoot, { recursive: true, force: true })
  }
})

test('language-push mount wiring: mount.ts feeds MorningBriefStore into LanguagePushService and both desk guardrails stay green', () => {
  const mountSource = readFileSync(resolve(rootDir, 'sentinel-desk/main/mount.ts'), 'utf8')
  assert.match(mountSource, /createMorningBriefCorpusProvider/, 'mount.ts must import the morning brief corpus provider')
  assert.match(
    mountSource,
    /extraCorpusProviders:\s*\[createMorningBriefCorpusProvider\(getMorningBriefService\(\)\.store\)\]/,
    'LanguagePushService must receive the MorningBriefStore-backed corpus provider',
  )

  execFileSync(process.execPath, [resolve(rootDir, 'sentinel-desk/scripts/desk-boundary.mjs')], { cwd: rootDir, stdio: 'pipe' })
  execFileSync(process.execPath, [resolve(rootDir, 'sentinel-desk/scripts/upstream-surface.mjs')], { cwd: rootDir, stdio: 'pipe' })
})

test('language-push card morning brief source: morning_brief cards render plain-text brief source without journal jump, locales stay 1:1', () => {
  const cardSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguageCard.tsx'), 'utf8')
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/en.json'), 'utf8'))

  assert.match(cardSource, /card\.example\.sourceKind === 'morning_brief'/, 'card must branch on morning_brief sourceKind')
  assert.match(cardSource, /t\('languagePush\.exampleLabelMorningBrief'\)/)
  assert.match(cardSource, /t\('languagePush\.sourceMorningBrief'/)
  assert.match(
    cardSource,
    /isMorningBrief \? \([\s\S]*?lp-meta[\s\S]*?\) : card\.example\.sourceDate && onNavigateToJournalAnchor \? \(/,
    'morning_brief cards must render plain-text source and never the journal jump button',
  )

  assert.equal(zh.languagePush.exampleLabelMorningBrief, '早报语境例句')
  assert.equal(zh.languagePush.sourceMorningBrief, '早报 · {{date}}')
  assert.equal(en.languagePush.exampleLabelMorningBrief, 'From Morning Brief')
  assert.equal(en.languagePush.sourceMorningBrief, 'Brief · {{date}}')
})

test('language-push regression (F1): empty auto-run before morning brief arrives does not lock out later extraction once brief lands', async () => {
  const { LanguagePushService, createMorningBriefCorpusProvider } = loadTsModule(
    resolve(rootDir, 'electron/desk/language-push-service.ts'),
  )
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-f1-'))
  try {
    let briefReady = false
    let llmCalls = 0
    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({ ok: true, date, filePath: '', entries: [] }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'k', authToken: '', baseUrl: 'https://example.invalid', model: 'deepseek-flash', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [{ id: 'p1', name: 'DeepSeek', model: 'deepseek-flash' }] } }),
      },
      extraCorpusProviders: [
        createMorningBriefCorpusProvider({
          getIssue: (date) =>
            briefReady && date === '2026-11-25'
              ? {
                  date: '2026-11-25',
                  issueTag: '#每日AI早报',
                  items: [
                    {
                      id: 'mbs_late_1',
                      title: '循环 Transformer 正式落地通用编码',
                      body: '最新模型在长上下文推理与工具编排上显著提升稳定性与吞吐量。',
                      category: '模型与研究',
                    },
                  ],
                }
              : null,
        }),
      ],
      now: () => new Date('2026-11-24T21:05:00Z'), // 2026-11-25 05:05 Asia/Shanghai
      llmCaller: async (_cfg, req) => {
        llmCalls += 1
        const isJa = req.messages.some((m) => m.content.includes('Target language: Japanese'))
        return {
          ok: true,
          model: 'deepseek-flash',
          durationMs: 5,
          text: JSON.stringify(
            isJa
              ? {
                  corpus: [{ entryId: 'mb_2026-11-25_mbs_late_1', translatedText: '循環型トランスフォーマーが汎用コーディングに導入された。' }],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: '汎用',
                      reading: 'はんよう',
                      meaning: '通用',
                      grammarNote: null,
                      levelTag: 'N1',
                      exampleSentence: '汎用コーディングの安定性が向上した。',
                      exampleTranslation: '通用编码的稳定性得到提升。',
                      exampleReadings: [
                        { surface: '汎用', reading: 'はんよう' },
                        { surface: '安定性', reading: 'あんていせい' },
                        { surface: '向上', reading: 'こうじょう' },
                      ],
                      sourceEntryId: 'mb_2026-11-25_mbs_late_1',
                    },
                  ],
                }
              : {
                  corpus: [{ entryId: 'mb_2026-11-25_mbs_late_1', translatedText: 'Recurrent transformers landed in general-purpose coding.' }],
                  cards: [
                    {
                      kind: 'vocab',
                      surface: 'resilience',
                      reading: '/rɪˈzɪliəns/',
                      meaning: '韧性；稳定性',
                      grammarNote: null,
                      levelTag: 'B2',
                      exampleSentence: 'The new runtime improved coding resilience.',
                      exampleTranslation: '新运行时提升了编码稳定性。',
                      sourceEntryId: 'mb_2026-11-25_mbs_late_1',
                    },
                  ],
                },
          ),
        }
      },
    })
    try {
      // 05:05 before morning brief has finished writing -> 0 eligible entries, must NOT write empty runs/2026-11-25.json
      await service.checkSchedule()
      assert.equal(llmCalls, 0)
      assert.equal(service.store.hasRunFor('2026-11-25'), false, 'empty run must not write runs/2026-11-25.json and lock out the day')

      // Morning brief finishes seconds later -> subsequent checkSchedule() must extract it automatically
      briefReady = true
      await service.checkSchedule()
      assert.equal(llmCalls, 2, 'must extract automatically once morning brief lands')
      assert.equal(service.store.hasRunFor('2026-11-25'), true)
    } finally {
      service.dispose()
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('language-push regression (F2): MiniMax-M3.1-Flash JA 4-entry slice only marks actually sent entries as processed', async () => {
  const { analyzeJournalForLanguagePush } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-analyzer.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  const entries = Array.from({ length: 6 }, (_, i) => ({
    id: `mb_2026-11-25_item_${i + 1}`,
    date: '2026-11-25',
    time: '04:30',
    body: `第 ${i + 1} 条早报关于大模型架构与智能体工具链的深度工程实践总结。`,
    category: '模型与研究',
    tags: ['#每日AI早报'],
    private: false,
    provenance: 'human',
    sourceKind: 'morning_brief',
  }))

  const out = await analyzeJournalForLanguagePush({
    logicalDate: '2026-11-25',
    entries,
    processedEntryIds: {},
    config: { ...LANGUAGE_PUSH_DEFAULT_CONFIG, enabledLangs: ['ja'] },
    resolvedModel: { apiKey: 'dummy', authToken: '', baseUrl: 'https://example.invalid', model: 'MiniMax-M3.1-Flash' },
    llmCaller: async () => ({
      ok: true,
      model: 'MiniMax-M3.1-Flash',
      durationMs: 10,
      text: JSON.stringify({
        corpus: [{ entryId: 'mb_2026-11-25_item_1', translatedText: '大規模モデルの設計実践をまとめた。' }],
        cards: [
          {
            kind: 'vocab',
            surface: '実践',
            reading: 'じっせん',
            meaning: '实践',
            grammarNote: null,
            levelTag: 'N2',
            exampleSentence: '現場での実践を通じて品質を高める。',
            exampleTranslation: '通过一线实践提升质量。',
            exampleReadings: [
              { surface: '現場', reading: 'げんば' },
              { surface: '実践', reading: 'じっせん' },
              { surface: '品質', reading: 'ひんしつ' },
            ],
            sourceEntryId: 'mb_2026-11-25_item_1',
          },
        ],
      }),
    }),
  })

  assert.equal(out.ok, true)
  assert.equal(out.processedEntryIds.length, 4, 'only the 4 entries actually sent to MiniMax-M3.1-Flash JA may be marked processed')
  assert.equal(out.processedEntryIds.includes('mb_2026-11-25_item_5:ja'), false)
  assert.equal(out.processedEntryIds.includes('mb_2026-11-25_item_6:ja'), false)
})

test('language-push regression (F3): dispose() prevents in-flight extraction from persisting files after disposal', async () => {
  const { LanguagePushService } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-f3-'))
  try {
    let releaseLlm
    const llmStarted = new Promise((resolveStart) => {
      releaseLlm = resolveStart
    })
    let resolveResponse
    const llmGate = new Promise((r) => {
      resolveResponse = r
    })

    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({
          ok: true,
          date,
          filePath: '',
          entries:
            date === '2026-11-25'
              ? [{ id: 'je_disp_1', date: '2026-11-25', time: '09:00', body: '今天测试服务销毁时的并发持久化保护机制。', category: '工程', tags: [], private: false, provenance: 'human' }]
              : [],
        }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'k', authToken: '', baseUrl: 'https://example.invalid', model: 'deepseek-flash', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [{ id: 'p1', name: 'DeepSeek', model: 'deepseek-flash' }] } }),
      },
      now: () => new Date('2026-11-25T02:00:00Z'),
      llmCaller: async () => {
        releaseLlm()
        await llmGate
        return {
          ok: true,
          model: 'deepseek-flash',
          durationMs: 5,
          text: JSON.stringify({
            corpus: [{ entryId: 'je_disp_1', translatedText: 'Tested disposal persistence guard.' }],
            cards: [
              {
                kind: 'vocab',
                surface: 'disposal',
                reading: '/dɪˈspəʊzəl/',
                meaning: '销毁；处置',
                grammarNote: null,
                levelTag: 'B2',
                exampleSentence: 'Clean disposal prevents post-shutdown disk writes.',
                exampleTranslation: '干净销毁可避免关停后的磁盘写入。',
                sourceEntryId: 'je_disp_1',
              },
            ],
          }),
        }
      },
    })

    await service.saveConfig({ enabledLangs: ['en'] })
    const runPromise = service.runExtraction({ date: '2026-11-25' })
    await llmStarted
    service.dispose()
    resolveResponse()
    const res = await runPromise
    assert.equal(res.ok, false, 'run finishing after dispose() must not report ok')
    assert.equal(service.store.hasRunFor('2026-11-25'), false, 'disposed service must not persist runs/2026-11-25.json')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})





test('language-push-validator (S1): English IPA accepts θ, normalizes wrappers, and rejects garbled readings; Japanese enforces pure kana + glued-lowercase guard', () => {
  const { validateLanguageCard, normalizeCardReading } = loadTsModule(
    resolve(rootDir, 'electron/desk/language-push-validator.ts'),
  )

  const enCard = (reading) =>
    validateLanguageCard({
      lang: 'en',
      kind: 'vocab',
      surface: 'throughput',
      reading,
      meaning: '吞吐量',
      exampleSentence: 'Higher throughput keeps the queue drained under load.',
    })

  // Legitimate IPA with θ (U+03B8) must pass — the old FOREIGN_SCRIPT_RE killed it
  const theta = enCard('/ˈθruːpʊt/')
  assert.equal(theta.ok, true, 'valid IPA with θ must pass validation')
  assert.equal(theta.normalizedReading, '/ˈθruːpʊt/')
  assert.equal(enCard('/θɪŋk/').ok, true, 'think IPA must pass')

  // Unwrapped IPA gets wrapped; stray inner spaces next to slashes are trimmed
  assert.equal(normalizeCardReading('θɪŋk', 'en'), '/θɪŋk/')
  assert.equal(normalizeCardReading('/rɪˈɡɑːrdləs ... /', 'en'), '/rɪˈɡɑːrdləs .../')
  assert.equal(normalizeCardReading('rɪˈzɪliəns', 'en'), '/rɪˈzɪliəns/')

  // Garbled EN readings are intercepted
  assert.equal(normalizeCardReading('/ˈθruːpʊt�/', 'en'), '', 'replacement char must be rejected')
  assert.equal(normalizeCardReading('/θɪŋk α/', 'en'), '', 'non-θ Greek must be rejected')
  assert.equal(normalizeCardReading('/hǎo/', 'en'), '', 'pinyin tone marks must be rejected')
  assert.equal(normalizeCardReading('???', 'en'), '', 'punctuation-only garbage must be rejected')
  assert.equal(normalizeCardReading('N/A', 'en'), '', 'N/A placeholder must be rejected')
  assert.equal(normalizeCardReading('/@#$%^&*+=<>|/', 'en'), '', 'non-IPA symbols must be rejected')
  assert.equal(normalizeCardReading('思考', 'en'), '', 'CJK in EN reading must be rejected')
  assert.equal(normalizeCardReading('/θɪŋk/'.repeat(30), 'en'), '', 'overlong reading must be rejected')
  assert.equal(enCard('/θɪŋk α/').ok, false, 'card with garbled EN reading must be rejected')
  assert.equal(enCard('/ˈθruːpʊt�/').ok, false, 'card with corrupt EN reading must be rejected')

  // EN surface / example still reject every Greek letter including θ, plus corrupt chars
  assert.equal(
    validateLanguageCard({
      lang: 'en',
      kind: 'vocab',
      surface: 'throughput θ',
      meaning: '吞吐量',
      exampleSentence: 'Higher throughput keeps the queue drained under load.',
    }).ok,
    false,
    'θ in EN surface must still be rejected',
  )
  assert.equal(
    validateLanguageCard({
      lang: 'en',
      kind: 'vocab',
      surface: 'throughput',
      meaning: '吞吐量',
      exampleSentence: 'Higher throughput� keeps the queue drained.',
    }).ok,
    false,
    'corrupt char in EN example must be rejected',
  )

  // Japanese readings: strict kana-only whitelist
  const jaCard = (reading, sentence = '生成された内容が有用かどうかにかかわらず、環境を整える。') =>
    validateLanguageCard({
      lang: 'ja',
      kind: 'grammar',
      surface: '〜にかかわらず',
      reading,
      meaning: '不管……都……',
      exampleSentence: sentence,
    })
  assert.equal(jaCard('にかかわらず').ok, true)
  assert.equal(normalizeCardReading('にかかわらず、かんきょう', 'ja'), 'にかかわらず、かんきょう')
  assert.equal(normalizeCardReading('にかかわらず★', 'ja'), '', 'stray symbol in JA reading must be rejected')
  assert.equal(normalizeCardReading('にかかわらず�', 'ja'), '', 'replacement char in JA reading must be rejected')
  assert.equal(normalizeCardReading('にかかわらず漢字', 'ja'), '', 'kanji in JA reading must be rejected')
  assert.equal(normalizeCardReading('にかかわらずabc', 'ja'), '', 'latin in JA reading must be rejected')
  assert.equal(jaCard('にかかわらず★').ok, false, 'card with symbol-garbled JA reading must be rejected')

  // Lowercase letters glued to kana/kanji are token-collapse artifacts
  assert.equal(jaCard('にかかわらず', 'これはaきのテストです。').ok, false, 'aき artifact must be rejected')
  assert.equal(jaCard('にかかわらず', '開発流程でdeき管理する。').ok, false, 'deき artifact must be rejected')
  assert.equal(jaCard('にかかわらず', 'タスクをk管理する。').ok, false, 'k管理 artifact must be rejected')
  // Standalone lowercase single letters are no longer silently allowed
  assert.equal(jaCard('にかかわらず', 'これは a のテストです。').ok, false, 'stray lowercase latin must be rejected')
  // Tech acronyms and uppercase grades remain allowed
  assert.equal(jaCard('にかかわらず', 'AIを使って毎日の振り返りを自動化している。').ok, true, 'AI must stay allowed')
  assert.equal(jaCard('にかかわらず', 'N2の試験に向けて毎日少しずつ勉強している。').ok, true, 'N2 must stay allowed')

  // Corrupt chars anywhere in JA fields are rejected
  assert.equal(jaCard('にかかわらず', '環境を整える。').ok, false, 'control char in JA example must be rejected')
})

test('language-push-store (S1): buildOverview sanitizes legacy corrupted readings on the returned copy without mutating deck.json', () => {
  const { LanguagePushStore } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-store.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-sanitize-'))

  try {
    const nowIso = '2026-11-23T01:00:00.000Z'
    const makeStored = (id, lang, reading) => ({
      id,
      lang,
      kind: 'vocab',
      wordKey: id,
      readingKey: reading,
      surface: lang === 'en' ? 'think' : '疎結合',
      reading,
      meaning: '含义',
      grammarNote: null,
      levelTag: lang === 'en' ? 'B2' : 'N2',
      example: {
        sentence: lang === 'en' ? 'Think in systems.' : '疎結合な設計を意識した。',
        translation: '译文',
        sourceDate: '2026-11-23',
        sourceEntryId: 'je_1',
      },
      status: 'active',
      familiarity: null,
      lastRatedAt: null,
      exposures: 0,
      seenDays: 1,
      firstSeenDate: '2026-11-23',
      lastSeenDate: '2026-11-23',
      extractedDate: '2026-11-23',
      dueAt: '2026-11-23',
      lastShownAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })

    const deckPayload = {
      version: 2,
      cards: {
        lp_en_bad: makeStored('lp_en_bad', 'en', '/θɪŋk α�/'),
        lp_en_wrap: makeStored('lp_en_wrap', 'en', 'θɪŋk'),
        lp_ja_bad: makeStored('lp_ja_bad', 'ja', 'そかつごう★漢'),
      },
      processedEntryIds: {},
    }
    const deckPath = join(tempRoot, 'language', 'deck.json')
    mkdirSync(dirname(deckPath), { recursive: true })
    const deckText = `${JSON.stringify(deckPayload, null, 2)}\n`
    writeFileSync(deckPath, deckText, 'utf8')

    const store = new LanguagePushStore({
      getDeskRoot: () => tempRoot,
      now: () => new Date('2026-11-23T05:00:00Z'),
    })
    const overview = store.buildOverview({
      runState: 'idle',
      runError: null,
      providerDisplay: { providerName: 'DeepSeek', modelName: 'deepseek-flash', configured: true, ttsConfigured: false },
    })

    const byId = new Map(overview.todayCards.map((c) => [c.id, c]))
    assert.equal(byId.get('lp_en_bad').reading, '', 'corrupt EN IPA must never reach the renderer')
    assert.equal(byId.get('lp_en_wrap').reading, '/θɪŋk/', 'legacy unwrapped IPA must be normalized for display')
    assert.equal(byId.get('lp_ja_bad').reading, '', 'garbled JA reading must never reach the renderer')

    assert.equal(readFileSync(deckPath, 'utf8'), deckText, 'deck.json on disk must stay byte-identical after read')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('language-push UI (S4): Option 3 accordion index list, IPA-safe fonts, 24-card setting pill, single loop entry, locales 1:1', () => {
  const pageSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')
  const cardSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguageCard.tsx'), 'utf8')
  const css = readFileSync(resolve(rootDir, 'src/styles/language-push-page.css'), 'utf8')
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/en.json'), 'utf8'))

  // C2: 24-card daily capacity in the settings pills
  assert.match(pageSource, /\[6, 8, 12, 16, 24\]/, 'settings must offer the 24-card pill')

  // C3/C4: pure player controller drives the accordion UI & unified DeskAudioBar
  assert.match(pageSource, /language-push-player/, 'page must use the pure player controller')
  assert.match(pageSource, /useSyncExternalStore/, 'page must subscribe to the player snapshot')
  assert.match(pageSource, /<DeskAudioBar\b/, 'unified DeskAudioBar must replace legacy lp-nowplaying')
  assert.match(pageSource, /<DeskAudioStickyStrip\b/, 'overlay DeskAudioStickyStrip must exist')
  assert.match(pageSource, /lp-group/, 'grouped index sections must exist')
  assert.match(cardSource, /lp-row-bar/, 'accordion row bar must exist')
  assert.match(cardSource, /lp-drawer-wrap/, 'accordion drawer must exist')
  assert.match(cardSource, /t\('languagePush\.playFromHere'\)/, 'drawer must offer play-from-here')

  // C1: IPA-safe sans font stack; the mono font (missing IPA glyphs) is gone
  assert.equal(css.includes('var(--j-font-mono)'), false, 'readings must never use the mono font')
  assert.match(css, /Lucida Grande/, 'IPA reading font stack must be present')

  // C4: dead CSS from the old card grid is removed
  for (const dead of ['.lp-grid', '.lp-card-top', '.lp-hero', '.lp-speak-btn', '.lp-example-box', '.lp-actions-rating']) {
    assert.equal(css.includes(dead), false, `dead CSS rule ${dead} must be removed`)
  }

  // C4: single entry point for the loop toggle (unified DeskAudioBar handler)
  const loopToggles = pageSource.match(/toggleLoop/g) ?? []
  assert.equal(loopToggles.length, 1, 'loop toggle must have exactly one entry point')
  assert.match(pageSource, /loop:\s*playerSnap\.loop/)

  // Locale parity for the new keys
  for (const key of [
    'groupVocab',
    'groupGrammar',
    'groupCount',
    'loop',
    'nowPlayingTerm',
    'nowPlayingExample',
    'prevCard',
    'nextCard',
    'stopPlayback',
    'playFromHere',
  ]) {
    assert.equal(typeof zh.languagePush?.[key], 'string', `missing zh.languagePush.${key}`)
    assert.equal(typeof en.languagePush?.[key], 'string', `missing en.languagePush.${key}`)
  }
})

test('sleepCancellable: clears its 60ms poll interval on normal completion and on cancellation, leaving no timer behind', async () => {
  const { sleepCancellable } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/speech-helper.ts'),
  )
  const prevWindow = globalThis.window

  const createFakeTimers = () => {
    let nextId = 1
    const timers = new Map()
    const cleared = []
    const windowStub = {
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.set(id, { id, fn, ms, kind: 'timeout' })
        return id
      },
      clearTimeout: (id) => {
        cleared.push(['clearTimeout', id])
        timers.delete(id)
      },
      setInterval: (fn, ms) => {
        const id = nextId++
        timers.set(id, { id, fn, ms, kind: 'interval' })
        return id
      },
      clearInterval: (id) => {
        cleared.push(['clearInterval', id])
        timers.delete(id)
      },
    }
    return {
      windowStub,
      timers,
      cleared,
      find: (kind, ms) => [...timers.values()].find((t) => t.kind === kind && t.ms === ms),
      fire: (timer) => {
        assert.ok(timer, 'the timer must still be pending')
        // A fired timeout is no longer pending, exactly like the DOM timer queue.
        if (timer.kind === 'timeout') timers.delete(timer.id)
        timer.fn()
      },
    }
  }

  try {
    // --- normal completion: the sleep timer fires and the poll interval must go with it ---
    const normal = createFakeTimers()
    globalThis.window = normal.windowStub

    const pending = sleepCancellable(100, () => false)
    const sleepTimer = normal.find('timeout', 100)
    const pollTimer = normal.find('interval', 60)
    assert.ok(sleepTimer, 'sleepCancellable schedules its own timeout')
    assert.ok(pollTimer, 'sleepCancellable schedules a 60ms cancellation poll')

    normal.fire(sleepTimer)
    const normalResult = await pending

    assert.equal(normalResult, true, 'a completed sleep resolves true')
    assert.ok(
      normal.cleared.some(([kind, id]) => kind === 'clearInterval' && id === pollTimer.id),
      'the 60ms poll interval is cleared when the timeout finishes normally',
    )
    assert.equal(
      normal.timers.size,
      0,
      `no timer may survive the sleep, left behind: ${JSON.stringify([...normal.timers.values()])}`,
    )

    // --- cancellation: both the sleep timeout and the poll interval must be cleared ---
    const cancelled = createFakeTimers()
    globalThis.window = cancelled.windowStub

    let isCancelled = false
    const cancelledPending = sleepCancellable(100, () => isCancelled)
    const cancelledSleepTimer = cancelled.find('timeout', 100)
    const cancelledPollTimer = cancelled.find('interval', 60)
    assert.ok(cancelledSleepTimer, 'sleepCancellable schedules its own timeout')
    assert.ok(cancelledPollTimer, 'sleepCancellable schedules a 60ms cancellation poll')

    isCancelled = true
    cancelled.fire(cancelledPollTimer)
    const cancelledResult = await cancelledPending

    assert.equal(cancelledResult, false, 'a cancelled sleep resolves false')
    assert.ok(
      cancelled.cleared.some(([kind, id]) => kind === 'clearTimeout' && id === cancelledSleepTimer.id),
      'the sleep timeout is cleared when the sleep is cancelled',
    )
    assert.ok(
      cancelled.cleared.some(([kind, id]) => kind === 'clearInterval' && id === cancelledPollTimer.id),
      'the 60ms poll interval is cleared when the sleep is cancelled',
    )
    assert.equal(
      cancelled.timers.size,
      0,
      `no timer may survive a cancelled sleep, left behind: ${JSON.stringify([...cancelled.timers.values()])}`,
    )
  } finally {
    globalThis.window = prevWindow
  }
})
