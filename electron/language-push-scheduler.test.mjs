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

test('language-push-scheduler: scheduleNextReview follows 3-tier familiarity intervals (unfamiliar +1d, fuzzy [3,7,14,30]d)', () => {
  const { scheduleNextReview } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
  assert.equal(scheduleNextReview(0, '2026-11-23', 'unfamiliar'), '2026-11-24')
  assert.equal(scheduleNextReview(3, '2026-11-23', 'unfamiliar'), '2026-11-24')
  assert.equal(scheduleNextReview(0, '2026-11-23', 'fuzzy'), '2026-11-26')
  assert.equal(scheduleNextReview(1, '2026-11-23', 'fuzzy'), '2026-11-30')
  assert.equal(scheduleNextReview(2, '2026-11-23', 'fuzzy'), '2026-12-07')
  assert.equal(scheduleNextReview(3, '2026-11-23', 'fuzzy'), '2026-12-23')
  assert.equal(scheduleNextReview(99, '2026-11-23', 'fuzzy'), '2026-12-23')
})

test('language-push-scheduler: filters basic words below threshold and cleans Japanese speech text', () => {
  const {
    isBelowDifficultyThreshold,
    normalizeCanonicalKey,
    prepareSpeechText,
  } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  assert.equal(normalizeCanonicalKey('  Resilience  ', 'en'), 'resilience')
  assert.equal(normalizeCanonicalKey('にもかかわらず', 'ja'), 'にもかかわらず')

  assert.equal(isBelowDifficultyThreshold('good', 'en', 'vocab', LANGUAGE_PUSH_DEFAULT_CONFIG), true)
  assert.equal(isBelowDifficultyThreshold('resilience', 'en', 'vocab', LANGUAGE_PUSH_DEFAULT_CONFIG), false)
  assert.equal(isBelowDifficultyThreshold('これ', 'ja', 'vocab', LANGUAGE_PUSH_DEFAULT_CONFIG), true)
  assert.equal(isBelowDifficultyThreshold('にもかかわらず', 'ja', 'grammar', LANGUAGE_PUSH_DEFAULT_CONFIG), false)

  assert.equal(prepareSpeechText('曖昧（あいまい）な表現', 'ja'), '曖昧な表現')
  assert.equal(prepareSpeechText('**resilience** under load', 'en'), 'resilience under load')
})

test('language-push-scheduler: extractCorpusHighFreqTerms mines multi-day threshold-passing EN & JA terms', () => {
  const { extractCorpusHighFreqTerms } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  const corpus = [
    { entryId: 'je_1', sourceDate: '2026-11-20', lang: 'en', translatedText: 'Architectural resilience is good when decoupling modules.', createdAt: '2026-11-20T00:00:00Z' },
    { entryId: 'je_2', sourceDate: '2026-11-21', lang: 'en', translatedText: 'We improved system resilience and modularity today.', createdAt: '2026-11-21T00:00:00Z' },
    { entryId: 'je_3', sourceDate: '2026-11-22', lang: 'en', translatedText: 'Resilience matters in production.', createdAt: '2026-11-22T00:00:00Z' },
    { entryId: 'je_1', sourceDate: '2026-11-20', lang: 'ja', translatedText: '疎結合な設計でシステム環境を改善した。', createdAt: '2026-11-20T00:00:00Z' },
    { entryId: 'je_2', sourceDate: '2026-11-22', lang: 'ja', translatedText: '今日も疎結合を意識して保守性を高めた。', createdAt: '2026-11-22T00:00:00Z' },
  ]

  const enTerms = extractCorpusHighFreqTerms(corpus, 'en', LANGUAGE_PUSH_DEFAULT_CONFIG, new Set(['modularity']))
  assert.equal(enTerms[0].wordKey, 'resilience')
  assert.equal(enTerms[0].docDays, 3)
  assert.equal(enTerms[0].totalCount, 3)
  assert.equal(enTerms.some((t) => t.wordKey === 'good'), false, 'stopword must be excluded')
  assert.equal(enTerms.some((t) => t.wordKey === 'modularity'), false, 'excluded wordKey must be skipped')

  const jaTerms = extractCorpusHighFreqTerms(corpus, 'ja', LANGUAGE_PUSH_DEFAULT_CONFIG, new Set())
  assert.ok(jaTerms.some((t) => t.term.includes('疎結合') && t.docDays === 2), 'multi-day JA high-freq term must rank top')
})

test('language-push-scheduler: buildDailyQueue prioritizes unfamiliar cards, interleaves EN/JA, and pruneActiveBacklog prevents backlog bloat', () => {
  const { buildDailyQueue, pruneActiveBacklog } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))

  const makeCard = (id, lang, kind, overrides = {}) => ({
    id,
    lang,
    kind,
    wordKey: id,
    readingKey: '',
    surface: id,
    reading: '',
    meaning: 'meaning',
    grammarNote: kind === 'grammar' ? 'pattern' : null,
    levelTag: lang === 'en' ? 'B2' : 'N2',
    example: { sentence: 'ex', translation: '译', sourceDate: '2026-11-23', sourceEntryId: 'je_1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-23',
    lastSeenDate: '2026-11-23',
    dueAt: '2026-11-23',
    lastShownAt: null,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
    ...overrides,
  })

  const cards = [
    ...Array.from({ length: 6 }, (_, i) => makeCard(`en_v_${i}`, 'en', 'vocab')),
    ...Array.from({ length: 6 }, (_, i) => makeCard(`ja_v_${i}`, 'ja', 'vocab')),
    makeCard('en_g_1', 'en', 'grammar'),
    makeCard('en_g_2', 'en', 'grammar'),
    makeCard('ja_g_1', 'ja', 'grammar'),
    makeCard('ja_g_2', 'ja', 'grammar'),
    makeCard('future_1', 'en', 'vocab', { dueAt: '2026-11-25' }),
    makeCard('mastered_1', 'en', 'vocab', { status: 'mastered', familiarity: 'familiar' }),
    makeCard('unfamiliar_ja', 'ja', 'vocab', { familiarity: 'unfamiliar' }),
  ]

  const { todayCards, backlogCards } = buildDailyQueue(cards, '2026-11-23', LANGUAGE_PUSH_DEFAULT_CONFIG)
  assert.equal(todayCards.length, 8)
  const vocab = todayCards.filter((c) => c.kind === 'vocab')
  const grammar = todayCards.filter((c) => c.kind === 'grammar')
  assert.equal(vocab.length, 6)
  assert.equal(grammar.length, 2)
  assert.equal(todayCards[0].id, 'unfamiliar_ja', 'unfamiliar card must take top priority')
  assert.ok(vocab.filter((c) => c.lang === 'en').length >= 2, 'EN vocab must not be starved')
  assert.ok(vocab.filter((c) => c.lang === 'ja').length >= 2, 'JA vocab must not be starved')
  assert.equal(grammar.filter((c) => c.lang === 'en').length, 1)
  assert.equal(grammar.filter((c) => c.lang === 'ja').length, 1)
  assert.ok(backlogCards.some((c) => c.id === 'future_1'))
  assert.ok(!todayCards.some((c) => c.status === 'mastered'))

  // Anti-bloat test: 35 active cards with backlogCap=15 + 1 stale 20-day-old untouched card
  const bloatDeck = [
    makeCard('stale_untouched', 'en', 'vocab', { lastSeenDate: '2026-11-01', dueAt: '2026-11-01' }),
    makeCard('rated_fuzzy_keep', 'en', 'vocab', { familiarity: 'fuzzy', exposures: 1, dueAt: '2026-11-28', lastSeenDate: '2026-11-10' }),
    ...Array.from({ length: 30 }, (_, i) =>
      makeCard(`bulk_${i}`, i % 2 === 0 ? 'en' : 'ja', 'vocab', {
        lastSeenDate: '2026-11-20',
        dueAt: '2026-11-26',
        seenDays: i < 5 ? 3 : 1,
      }),
    ),
  ]
  const archived = pruneActiveBacklog(
    bloatDeck,
    '2026-11-23',
    { ...LANGUAGE_PUSH_DEFAULT_CONFIG, backlogCap: 15 },
    '2026-11-23T12:00:00Z',
  )
  assert.ok(archived.includes('stale_untouched'), 'stale >14d untouched card must auto-archive')
  const afterPrune = buildDailyQueue(bloatDeck, '2026-11-23', { ...LANGUAGE_PUSH_DEFAULT_CONFIG, backlogCap: 15 })
  assert.ok(afterPrune.backlogCards.length <= 15, 'backlog must never exceed configured cap')
  assert.ok(afterPrune.backlogCards.some((c) => c.id === 'rated_fuzzy_keep'), 'user-rated card must be protected from cap eviction')
})

test('language-push-store: deduplicates canonical words, archives corpus silently, respects 3-tier familiarity, and revives archived cards on recurrence', async () => {
  const { LanguagePushStore } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-store.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-store-'))

  try {
    const store = new LanguagePushStore({
      getDeskRoot: () => tempRoot,
      now: () => new Date('2026-11-23T05:00:00Z'), // 13:00 Asia/Shanghai
    })

    const first = await store.mergeExtractionResult({
      logicalDate: '2026-11-23',
      providerName: 'DeepSeek',
      modelUsed: 'deepseek-flash',
      processedEntryIds: ['je_1:en', 'je_1:ja'],
      corpusItems: [
        {
          entryId: 'je_1',
          sourceDate: '2026-11-23',
          lang: 'en',
          translatedText: 'Full background translation should stay archived on disk only.',
        },
      ],
      candidates: [
        {
          lang: 'en',
          kind: 'vocab',
          surface: 'Resilience',
          reading: '/rɪˈzɪliəns/',
          meaning: '韧性；恢复力',
          grammarNote: null,
          levelTag: 'B2',
          exampleSentence: 'System resilience improves when each module owns its boundaries.',
          exampleTranslation: '当每个模块管好自身边界时，系统韧性会提升。',
          sourceDate: '2026-11-23',
          sourceEntryId: 'je_1',
        },
        {
          lang: 'en',
          kind: 'vocab',
          surface: 'good', // below threshold -> must be filtered
          reading: '/ɡʊd/',
          meaning: '好的',
          grammarNote: null,
          levelTag: 'A1',
          exampleSentence: 'This is a good day.',
          exampleTranslation: '今天很好。',
          sourceDate: '2026-11-23',
          sourceEntryId: 'je_1',
        },
        {
          lang: 'ja',
          kind: 'grammar',
          surface: 'にもかかわらず',
          reading: 'にもかかわらず',
          meaning: '尽管……却……',
          grammarNote: '接在名词/普通形后，表示出乎意料的转折。',
          levelTag: 'N2',
          exampleSentence: '忙しいにもかかわらず、毎日の日記を続けている。',
          exampleTranslation: '尽管很忙，仍然坚持每天写日记。',
          sourceDate: '2026-11-23',
          sourceEntryId: 'je_1',
        },
      ],
      statsBase: { scannedEntries: 2, eligibleEntries: 1, skippedPrivate: 1, skippedAlreadyProcessed: 0, durationMs: 120 },
    })

    assert.equal(first.addedCards, 2)
    assert.equal(first.filteredBelowThreshold, 1)

    // Silent corpus archived on disk, NOT leaked into overview
    const corpusFile = join(tempRoot, 'language', 'corpus', '2026', '11', '2026-11-23.json')
    assert.equal(existsSync(corpusFile), true)
    const overview = store.buildOverview({
      runState: 'idle',
      runError: null,
      providerDisplay: { providerName: 'DeepSeek', modelName: 'deepseek-flash', configured: true, ttsConfigured: false },
    })
    assert.equal(overview.todayCards.length, 2)
    assert.equal('corpus' in overview, false)
    assert.equal(overview.counts.corpusDaysCount, 1)
    assert.equal(overview.counts.backlogCap, 40)

    const enCard = overview.todayCards.find((c) => c.lang === 'en')
    const jaCard = overview.todayCards.find((c) => c.lang === 'ja')
    assert.ok(enCard && jaCard)

    // Unfamiliar -> +1 day
    const unfRes = await store.applyDecision(jaCard.id, 'unfamiliar')
    assert.equal(unfRes.card.familiarity, 'unfamiliar')
    assert.equal(unfRes.card.dueAt, '2026-11-24')

    // Fuzzy -> +3 days and increments exposures
    const fuzzyRes = await store.applyDecision(enCard.id, 'fuzzy')
    assert.equal(fuzzyRes.card.familiarity, 'fuzzy')
    assert.equal(fuzzyRes.card.exposures, 1)
    assert.equal(fuzzyRes.card.dueAt, '2026-11-26')
    const afterFuzzy = store.buildOverview({
      runState: 'idle',
      runError: null,
      providerDisplay: { providerName: 'DeepSeek', modelName: 'deepseek-flash', configured: true, ttsConfigured: false },
    })
    assert.equal(afterFuzzy.todayCards.some((c) => c.id === enCard.id), false)

    // Familiar -> retires card as mastered and blocks re-creation on future extraction
    await store.applyDecision(enCard.id, 'familiar')
    const profile = store.buildFamiliarityProfileByLang()
    assert.ok(profile.en.familiar.includes('Resilience'))
    assert.ok(profile.ja.unfamiliar.some((x) => x.surface === 'にもかかわらず'))

    const second = await store.mergeExtractionResult({
      logicalDate: '2026-11-24',
      providerName: 'DeepSeek',
      modelUsed: 'deepseek-flash',
      processedEntryIds: ['je_2:en'],
      corpusItems: [],
      candidates: [
        {
          lang: 'en',
          kind: 'vocab',
          surface: 'resilience',
          reading: '/rɪˈzɪliəns/',
          meaning: '韧性',
          grammarNote: null,
          levelTag: 'B2',
          exampleSentence: 'Resilience matters.',
          exampleTranslation: '韧性很重要。',
          sourceDate: '2026-11-24',
          sourceEntryId: 'je_2',
        },
      ],
      statsBase: { scannedEntries: 1, eligibleEntries: 1, skippedPrivate: 0, skippedAlreadyProcessed: 0, durationMs: 50 },
    })
    assert.equal(second.addedCards, 0)
    assert.equal(second.skippedMastered, 1)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('language-push (S2): dailyLimit 24 with 18 vocab + 6 grammar is accepted by config normalization and buildDailyQueue', async () => {
  const { LanguagePushStore } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-store.ts'))
  const { buildDailyQueue } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
  const { LANGUAGE_PUSH_DEFAULT_CONFIG } = loadTsModule(resolve(rootDir, 'src/language-push-contract.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-24-'))

  try {
    const store = new LanguagePushStore({
      getDeskRoot: () => tempRoot,
      now: () => new Date('2026-11-23T05:00:00Z'),
    })
    const saved = await store.saveConfig({ dailyLimit: 24, dailyVocabLimit: 18, dailyGrammarLimit: 6 })
    assert.equal(saved.dailyLimit, 24, 'config must accept dailyLimit 24')
    assert.equal(saved.dailyVocabLimit, 18)
    assert.equal(saved.dailyGrammarLimit, 6)
    assert.equal(store.getConfig().dailyLimit, 24, 'persisted config must keep dailyLimit 24')

    const makeCard = (id, lang, kind) => ({
      id,
      lang,
      kind,
      wordKey: id,
      readingKey: '',
      surface: id,
      reading: '',
      meaning: 'meaning',
      grammarNote: kind === 'grammar' ? 'pattern' : null,
      levelTag: lang === 'en' ? 'B2' : 'N2',
      example: { sentence: 'ex', translation: '译', sourceDate: '2026-11-23', sourceEntryId: 'je_1' },
      status: 'active',
      familiarity: null,
      exposures: 0,
      seenDays: 1,
      firstSeenDate: '2026-11-23',
      lastSeenDate: '2026-11-23',
      dueAt: '2026-11-23',
      lastShownAt: null,
      createdAt: '2026-11-23T00:00:00Z',
      updatedAt: '2026-11-23T00:00:00Z',
    })
    const cards = [
      ...Array.from({ length: 14 }, (_, i) => makeCard(`en_v_${i}`, 'en', 'vocab')),
      ...Array.from({ length: 14 }, (_, i) => makeCard(`ja_v_${i}`, 'ja', 'vocab')),
      ...Array.from({ length: 4 }, (_, i) => makeCard(`en_g_${i}`, 'en', 'grammar')),
      ...Array.from({ length: 4 }, (_, i) => makeCard(`ja_g_${i}`, 'ja', 'grammar')),
    ]
    const config24 = { ...LANGUAGE_PUSH_DEFAULT_CONFIG, dailyLimit: 24, dailyVocabLimit: 18, dailyGrammarLimit: 6 }
    const { todayCards } = buildDailyQueue(cards, '2026-11-23', config24)
    assert.equal(todayCards.length, 24, 'daily queue must fill all 24 slots')
    assert.equal(todayCards.filter((c) => c.kind === 'vocab').length, 18)
    assert.equal(todayCards.filter((c) => c.kind === 'grammar').length, 6)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('language-push-player (S3): playlist auto-expands accordion, phases term→example, collapses and resets to top when loop is off', async () => {
  const { LanguagePushPlayerController, LANGUAGE_PUSH_LOOP_STORAGE_KEY } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/language-push-player.ts'),
  )
  const makeCard = (id) => ({
    id,
    lang: 'en',
    kind: 'vocab',
    wordKey: id,
    readingKey: '',
    surface: `surface_${id}`,
    reading: '/sɜːfɪs/',
    meaning: '含义',
    grammarNote: null,
    levelTag: 'B2',
    example: { sentence: `sentence_${id}`, translation: '译文', sourceDate: '2026-11-23', sourceEntryId: 'je_1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-23',
    lastSeenDate: '2026-11-23',
    dueAt: '2026-11-23',
    lastShownAt: null,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
  })
  const queue = [makeCard('c1'), makeCard('c2'), makeCard('c3')]

  const spoken = []
  const entered = []
  const events = []
  const storageData = new Map()
  const controller = new LanguagePushPlayerController({
    speak: async ({ text }) => {
      spoken.push(text)
      return { outcome: 'ok', provider: 'minimax' }
    },
    sleep: async () => true,
    stopSpeech: () => events.push('stopSpeech'),
    storage: {
      getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
      setItem: (key, value) => storageData.set(key, value),
    },
    onCardEnter: (card, index) => entered.push(`${card.id}@${index}`),
    onResetToTop: () => events.push('resetToTop'),
    onComplete: (count) => events.push(`complete:${count}`),
  })

  const transitions = []
  controller.subscribe(() => {
    const s = controller.getSnapshot()
    transitions.push(`${s.activeCardId ?? '-'}:${s.phase ?? '-'}:${s.openCardId ?? '-'}`)
  })

  assert.equal(controller.getSnapshot().loop, false)
  controller.setLoop(true)
  assert.equal(storageData.get(LANGUAGE_PUSH_LOOP_STORAGE_KEY), '1', 'loop must persist to storage')
  controller.setLoop(false)
  assert.equal(storageData.get(LANGUAGE_PUSH_LOOP_STORAGE_KEY), '0')

  await controller.playQueue(queue, { speed: 0.95, resolveVoiceId: () => undefined })

  assert.deepEqual(spoken, [
    'surface_c1', 'sentence_c1',
    'surface_c2', 'sentence_c2',
    'surface_c3', 'sentence_c3',
  ])
  assert.deepEqual(entered, ['c1@0', 'c2@1', 'c3@2'])
  // Accordion auto-expands the active row and collapses the previous one
  assert.ok(transitions.includes('c1:term:c1'), 'term phase must auto-expand card 1')
  assert.ok(transitions.includes('c1:example:c1'), 'example phase must keep card 1 expanded')
  assert.ok(transitions.includes('c2:term:c2'), 'card 2 must auto-expand after card 1')
  assert.ok(
    transitions.indexOf('c2:term:c2') > transitions.indexOf('c1:example:c1'),
    'expanding card 2 must come after card 1 finished',
  )
  // Playlist finished with loop off: collapse, reset play state, jump back to top
  const snap = controller.getSnapshot()
  assert.equal(snap.openCardId, null)
  assert.equal(snap.activeCardId, null)
  assert.equal(snap.phase, null)
  assert.equal(snap.isPlaylist, false)
  assert.equal(snap.index, -1)
  assert.ok(events.includes('resetToTop'), 'must scroll back to the top of the list')
  assert.ok(events.includes('complete:3'))

  // toggleOpen expands / collapses manually
  controller.toggleOpen('c2')
  assert.equal(controller.getSnapshot().openCardId, 'c2')
  controller.toggleOpen('c2')
  assert.equal(controller.getSnapshot().openCardId, null)
})

test('language-push-player (S3): loop wraps seamlessly to index 0, persists across instances, and all-error runs break instead of spinning', async () => {
  const { LanguagePushPlayerController, LANGUAGE_PUSH_LOOP_STORAGE_KEY } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/language-push-player.ts'),
  )
  const makeCard = (id) => ({
    id,
    lang: 'en',
    kind: 'vocab',
    wordKey: id,
    readingKey: '',
    surface: `surface_${id}`,
    reading: '',
    meaning: '含义',
    grammarNote: null,
    levelTag: null,
    example: { sentence: `sentence_${id}`, translation: '译文', sourceDate: '2026-11-23', sourceEntryId: 'je_1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-23',
    lastSeenDate: '2026-11-23',
    dueAt: '2026-11-23',
    lastShownAt: null,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
  })
  const queue = [makeCard('c1'), makeCard('c2'), makeCard('c3')]

  const spoken = []
  const storageData = new Map([[LANGUAGE_PUSH_LOOP_STORAGE_KEY, '1']])
  let controller
  controller = new LanguagePushPlayerController({
    speak: async ({ text }) => {
      spoken.push(text)
      if (spoken.length >= 13) controller.stop()
      return { outcome: 'ok', provider: 'minimax' }
    },
    sleep: async () => true,
    stopSpeech: () => {},
    storage: {
      getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
      setItem: (key, value) => storageData.set(key, value),
    },
  })
  assert.equal(controller.getSnapshot().loop, true, 'loop must be restored from storage')

  await controller.playQueue(queue, { speed: 1, resolveVoiceId: () => undefined })
  assert.ok(spoken.length >= 13, 'loop mode must keep playing past the end of the queue')
  assert.equal(spoken[6], 'surface_c1', 'after the last card the playlist must wrap back to index 0')
  assert.equal(controller.getSnapshot().activeCardId, null, 'stop() must clear playing state')

  // All-error queue with loop on must terminate instead of looping forever
  const events = []
  const broken = new LanguagePushPlayerController({
    speak: async () => ({ outcome: 'error', provider: 'none', fallbackReason: 'boom' }),
    sleep: async () => true,
    stopSpeech: () => {},
    onError: (message) => events.push(`error:${message}`),
    onResetToTop: () => events.push('resetToTop'),
    onComplete: (count) => events.push(`complete:${count}`),
  })
  broken.setLoop(true)
  await broken.playQueue(queue, { speed: 1, resolveVoiceId: () => undefined })
  assert.equal(broken.getSnapshot().isPlaylist, false, 'all-error loop must terminate')
  assert.ok(events.includes('resetToTop'))
  assert.ok(events.includes('complete:3'))
  assert.ok(events.some((e) => e.startsWith('error:')), 'errors must surface via onError')
})

test('language-push-player (S3): playSingle keeps the row open, stepPrev/stepNext jump within the cached queue, stop cancels immediately', async () => {
  const { LanguagePushPlayerController } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/language-push-player.ts'),
  )
  const makeCard = (id) => ({
    id,
    lang: 'en',
    kind: 'vocab',
    wordKey: id,
    readingKey: '',
    surface: `surface_${id}`,
    reading: '',
    meaning: '含义',
    grammarNote: null,
    levelTag: null,
    example: { sentence: `sentence_${id}`, translation: '译文', sourceDate: '2026-11-23', sourceEntryId: 'je_1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-23',
    lastSeenDate: '2026-11-23',
    dueAt: '2026-11-23',
    lastShownAt: null,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
  })
  const queue = [makeCard('c1'), makeCard('c2'), makeCard('c3')]

  // Single preview: plays one card, then keeps the accordion open on it
  const singleSpoken = []
  const single = new LanguagePushPlayerController({
    speak: async ({ text }) => {
      singleSpoken.push(text)
      return { outcome: 'ok', provider: 'minimax' }
    },
    sleep: async () => true,
    stopSpeech: () => {},
  })
  await single.playSingle(queue[1], { speed: 1, resolveVoiceId: () => undefined })
  const singleSnap = single.getSnapshot()
  assert.equal(singleSnap.openCardId, 'c2', 'single preview must keep the row expanded')
  assert.equal(singleSnap.activeCardId, null)
  assert.equal(singleSnap.isPlaylist, false)

  // One-shot preview (drawer micro buttons): speaks a single text, no playlist state
  await single.preview({ text: 'preview_only', lang: 'en', speed: 1 })
  assert.equal(singleSpoken[singleSpoken.length - 1], 'preview_only')
  assert.equal(single.getSnapshot().isPlaylist, false)
  assert.equal(single.getSnapshot().activeCardId, null)

  // Step navigation: gate the first speak so the playlist stays parked on card 1
  let releaseFirst
  const gate = new Promise((resolvePromise) => {
    releaseFirst = resolvePromise
  })
  const spoken = []
  const stepper = new LanguagePushPlayerController({
    speak: async ({ text }) => {
      spoken.push(text)
      if (spoken.length === 1) await gate
      return { outcome: 'ok', provider: 'minimax' }
    },
    sleep: async () => true,
    stopSpeech: () => {},
  })
  const run = stepper.playQueue(queue, { speed: 1, resolveVoiceId: () => undefined })
  assert.equal(stepper.getSnapshot().openCardId, 'c1')
  assert.equal(stepper.getSnapshot().phase, 'term')
  assert.equal(stepper.getSnapshot().isPlaylist, true)
  assert.equal(stepper.getSnapshot().index, 0)
  assert.equal(stepper.getSnapshot().total, 3)

  stepper.stepNext()
  assert.equal(stepper.getSnapshot().openCardId, 'c2', 'stepNext must jump to the next card')
  assert.equal(stepper.getSnapshot().index, 1)
  assert.ok(spoken.includes('surface_c2'))

  stepper.stepPrev()
  assert.equal(stepper.getSnapshot().openCardId, 'c1', 'stepPrev must jump back')
  assert.equal(stepper.getSnapshot().index, 0)

  releaseFirst()
  stepper.stop()
  await run
  const stoppedSnap = stepper.getSnapshot()
  assert.equal(stoppedSnap.activeCardId, null)
  assert.equal(stoppedSnap.openCardId, null, 'stop() without keepOpen must collapse the accordion')
  assert.equal(stoppedSnap.isPlaylist, false)
})

test('language-push-player regression (R1/R3): syncQueue prunes rated cards mid-playlist keeping activeSurface, and pass-2 total error breaks loop', async () => {
  const { LanguagePushPlayerController } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/language-push-player.ts'),
  )
  const makeCard = (id) => ({
    id,
    lang: 'en',
    kind: 'vocab',
    wordKey: id,
    readingKey: '',
    surface: `surface_${id}`,
    reading: '',
    meaning: '含义',
    grammarNote: null,
    levelTag: null,
    example: { sentence: `sentence_${id}`, translation: '译文', sourceDate: '2026-11-25', sourceEntryId: 'je_1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-25',
    lastSeenDate: '2026-11-25',
    dueAt: '2026-11-25',
    lastShownAt: null,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  })

  // R1: rating removes card c1 while c1 is playing -> activeSurface stays populated & loop pass 2 does NOT replay c1
  const q1 = [makeCard('c1'), makeCard('c2')]
  const spoken = []
  let synced = false
  const player = new LanguagePushPlayerController({
    speak: async ({ text }) => {
      spoken.push(text)
      if (!synced && text === 'surface_c1') {
        synced = true
        // User marks c1 familiar -> c1 disappears from todayCards
        player.syncQueue([q1[1]])
        assert.equal(player.getSnapshot().activeSurface, 'surface_c1', 'activeSurface must stay populated for now-playing bar')
      }
      if (spoken.filter((s) => s === 'surface_c2').length >= 2) {
        player.stop()
      }
      return { outcome: 'ok', provider: 'minimax' }
    },
    sleep: async () => true,
    stopSpeech: () => {},
  })
  player.setLoop(true)
  await player.playQueue(q1, { speed: 1, resolveVoiceId: () => undefined })
  assert.equal(spoken.filter((s) => s === 'surface_c1').length, 1, 'removed card c1 must not replay on loop pass 2')
  assert.equal(spoken.filter((s) => s === 'surface_c2').length, 2, 'remaining card c2 must continue looping')

  // R3: pass 1 succeeds, pass 2 fails completely -> loop must break instead of spinning endlessly
  let passCalls = 0
  const errors = []
  const pass2Fail = new LanguagePushPlayerController({
    speak: async () => {
      passCalls += 1
      if (passCalls <= 2) return { outcome: 'ok', provider: 'minimax' }
      return { outcome: 'error', provider: 'none', fallbackReason: 'offline' }
    },
    sleep: async () => true,
    stopSpeech: () => {},
    onError: (msg) => errors.push(msg),
  })
  pass2Fail.setLoop(true)
  await pass2Fail.playQueue([makeCard('only')], { speed: 1, resolveVoiceId: () => undefined })
  assert.equal(pass2Fail.getSnapshot().isPlaylist, false, 'loop must terminate when pass 2 fails completely')
  assert.equal(passCalls, 4, 'must run pass 1 (2 calls ok) + pass 2 (2 calls error) and stop')
  assert.equal(errors.length, 2)
})

test('language-push-validator regression (R5): accepts ASCII colon, tie-bar, variant labels without double-slash; rejects bare English words, punctuation-only JA, and corrupt meaning', () => {
  const { normalizeCardReading, validateLanguageCard } = loadTsModule(
    resolve(rootDir, 'electron/desk/language-push-validator.ts'),
  )

  // Valid English IPA variants that must NOT be falsely rejected or double-slashed
  assert.equal(normalizeCardReading('/di:ˈkʌplɪŋ/', 'en'), '/diːˈkʌplɪŋ/', 'ASCII colon in IPA should normalize to ː')
  assert.equal(normalizeCardReading('/t͡ʃeɪndʒ/', 'en'), '/t͡ʃeɪndʒ/', 'IPA tie-bar t͡ʃ must be accepted')
  assert.equal(normalizeCardReading('/ˈskɛdʒuːl/ (US)', 'en'), '/ˈskɛdʒuːl/ (US)', 'slashed IPA with region label must not be double-slashed')
  assert.equal(normalizeCardReading('/ˈʃedjuːl/; /ˈskedʒuːl/', 'en'), '/ˈʃedjuːl/; /ˈskedʒuːl/', 'semicolon UK/US variants must be accepted')

  // Missed garble that MUST be rejected
  assert.equal(normalizeCardReading('resilience', 'en'), '', 'bare English word without IPA symbols must not be accepted as IPA')
  assert.equal(normalizeCardReading('yappari', 'en'), '', 'bare romaji without IPA symbols must not be accepted as IPA')
  assert.equal(normalizeCardReading('〜', 'ja'), '', 'punctuation-only JA reading must be rejected')
  assert.equal(normalizeCardReading('()', 'ja'), '', 'parentheses-only JA reading must be rejected')

  const badMeaning = validateLanguageCard({
    lang: 'en',
    kind: 'vocab',
    surface: 'resilience',
    reading: '/rɪˈzɪliəns/',
    meaning: '韧性乱码\uFFFD',
    exampleSentence: 'Resilience keeps services stable.',
  })
  assert.equal(badMeaning.ok, false, 'meaning with replacement char U+FFFD must be rejected')
})
