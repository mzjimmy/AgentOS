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

test('language-push-scheduler: scheduleNextReview follows SentinelLab [1,2,4,7,15,30] SRS intervals', () => {
  const { scheduleNextReview } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
  assert.equal(scheduleNextReview(0, '2026-11-23'), '2026-11-24')
  assert.equal(scheduleNextReview(1, '2026-11-23'), '2026-11-25')
  assert.equal(scheduleNextReview(2, '2026-11-23'), '2026-11-27')
  assert.equal(scheduleNextReview(3, '2026-11-23'), '2026-11-30')
  assert.equal(scheduleNextReview(4, '2026-11-23'), '2026-12-08')
  assert.equal(scheduleNextReview(5, '2026-11-23'), '2026-12-23')
  assert.equal(scheduleNextReview(99, '2026-11-23'), '2026-12-23')
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

test('language-push-scheduler: buildDailyQueue enforces 6 vocab + 2 grammar budget and interleaves EN/JA fairly', () => {
  const { buildDailyQueue } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-scheduler.ts'))
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
    pinned: false,
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
    makeCard('mastered_1', 'en', 'vocab', { status: 'mastered' }),
    makeCard('pinned_ja', 'ja', 'vocab', { pinned: true }),
  ]

  const { todayCards, backlogCards } = buildDailyQueue(cards, '2026-11-23', LANGUAGE_PUSH_DEFAULT_CONFIG)
  assert.equal(todayCards.length, 8)
  const vocab = todayCards.filter((c) => c.kind === 'vocab')
  const grammar = todayCards.filter((c) => c.kind === 'grammar')
  assert.equal(vocab.length, 6)
  assert.equal(grammar.length, 2)
  assert.equal(todayCards[0].id, 'pinned_ja', 'pinned card must take top priority')
  assert.ok(vocab.filter((c) => c.lang === 'en').length >= 2, 'EN vocab must not be starved')
  assert.ok(vocab.filter((c) => c.lang === 'ja').length >= 2, 'JA vocab must not be starved')
  assert.equal(grammar.filter((c) => c.lang === 'en').length, 1)
  assert.equal(grammar.filter((c) => c.lang === 'ja').length, 1)
  assert.ok(backlogCards.some((c) => c.id === 'future_1'))
  assert.ok(!todayCards.some((c) => c.status === 'mastered'))
})

test('language-push-store: deduplicates canonical words, archives corpus silently, respects mastered, and persists SRS decisions', async () => {
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
      processedEntryIds: ['je_1'],
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

    const enCard = overview.todayCards.find((c) => c.lang === 'en')
    assert.ok(enCard)

    // Later -> moves dueAt forward by 1 day and removes from todayCards
    const laterRes = await store.applyDecision(enCard.id, 'later')
    assert.equal(laterRes.card.exposures, 1)
    assert.equal(laterRes.card.dueAt, '2026-11-24')
    const afterLater = store.buildOverview({
      runState: 'idle',
      runError: null,
      providerDisplay: { providerName: 'DeepSeek', modelName: 'deepseek-flash', configured: true, ttsConfigured: false },
    })
    assert.equal(afterLater.todayCards.some((c) => c.id === enCard.id), false)

    // Master -> retires card and blocks re-creation on future extraction
    await store.applyDecision(enCard.id, 'master')
    const second = await store.mergeExtractionResult({
      logicalDate: '2026-11-24',
      providerName: 'DeepSeek',
      modelUsed: 'deepseek-flash',
      processedEntryIds: ['je_2'],
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
