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

    // Card decision updates overview immediately
    const jaCard = res.overview.todayCards.find((c) => c.lang === 'ja')
    assert.ok(jaCard)
    const pinRes = await service.decideCard(jaCard.id, 'pin')
    assert.equal(pinRes.ok, true)
    assert.equal(pinRes.card.pinned, true)
    assert.equal(pinRes.overview.counts.pinnedTotal, 1)
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
    getOverview: () => ({ todayCards: [] }),
    runExtraction: (opts) => ({ ok: true, opts }),
    decideCard: (id, action) => ({ ok: true, id, action }),
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
    action: 'later',
  })
  assert.equal(getterCount, 1)
  dispose()
  assert.equal(handlers.size, 0)
  assert.equal(removed.length, 6)
})

test('language-push host wiring, single-line main.ts IPC delegation, and 1:1 zh/en locale parity', () => {
  const { PINNED_MODULES } = loadTsModule(resolve(rootDir, 'src/components/pinned-modules.ts'))
  const { normalizeViewId, VIEW_HEADING_KEYS } = loadTsModule(resolve(rootDir, 'src/components/app-shell-constants.ts'))
  const mainSource = readFileSync(resolve(rootDir, 'electron/main.ts'), 'utf8')
  const workspaceSource = readFileSync(resolve(rootDir, 'src/components/AppShellWorkspace.tsx'), 'utf8')
  const pageSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')
  const cardSource = readFileSync(resolve(rootDir, 'src/components/language-push/LanguageCard.tsx'), 'utf8')
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/en.json'), 'utf8'))

  assert.equal(PINNED_MODULES[3]?.id, 'language-push')
  assert.equal(normalizeViewId('language-push'), 'language-push')
  assert.equal(VIEW_HEADING_KEYS['language-push'], 'shell.viewLanguagePush')

  // Obeys AGENTS.md guardrail: single-line delegation in main.ts, zero flat handlers
  assert.match(mainSource, /registerLanguagePushIpc\(\s*ipcMain\s*,\s*getLanguagePushService\s*\)/)
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(\s*DESKTOP_INVOKE_CHANNELS\.getLanguagePushOverview\b/)
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



