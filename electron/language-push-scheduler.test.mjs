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
