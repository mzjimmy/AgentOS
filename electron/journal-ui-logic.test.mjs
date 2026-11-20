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
  const rawSource = readFileSync(resolvedPath, 'utf8')
  const { outputText } = ts.transpileModule(rawSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: resolvedPath,
  })
  const executable = outputText.replace(/\bimport\.meta\.env\b/g, '({ DEV: false, VITE_SHOW_DEVELOPER_SETTINGS: "false" })')
  const module = { exports: {} }
  cache.set(resolvedPath, module)
  const localRequire = (specifier) => {
    if (specifier.startsWith('.')) {
      const base = resolve(dirname(resolvedPath), specifier)
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
        if (existsSync(candidate)) return loadTsModule(candidate, cache)
      }
    }
    return require(specifier)
  }
  Function('exports', 'module', 'require', executable)(module.exports, module, localRequire)
  return module.exports
}

test('PINNED_MODULES exposes extensible journal slot entry as the first pinned module', () => {
  const { PINNED_MODULES, resolvePinnedModuleByViewId } = loadTsModule(
    resolve(rootDir, 'src/components/pinned-modules.ts'),
  )
  assert.ok(Array.isArray(PINNED_MODULES) && PINNED_MODULES.length >= 1)
  assert.deepEqual(PINNED_MODULES[0], {
    id: 'journal',
    labelKey: 'sidebar.pinnedJournal',
    icon: 'journal',
    hash: '#journal',
  })
  assert.equal(resolvePinnedModuleByViewId('journal')?.id, 'journal')
  assert.equal(resolvePinnedModuleByViewId('nonexistent'), undefined)
})

test('normalizeViewId defaults empty hash to journal while preserving home, docs, settings, journal', () => {
  const { normalizeViewId, VIEW_HEADING_KEYS } = loadTsModule(
    resolve(rootDir, 'src/components/app-shell-constants.ts'),
  )
  assert.equal(normalizeViewId(''), 'journal')
  assert.equal(normalizeViewId('journal'), 'journal')
  assert.equal(normalizeViewId('home'), 'home')
  assert.equal(normalizeViewId('docs'), 'docs')
  assert.equal(normalizeViewId('settings'), 'settings')
  assert.equal(normalizeViewId('settings/mcp'), 'settings')
  assert.equal(typeof VIEW_HEADING_KEYS.journal, 'string')
  assert.ok(VIEW_HEADING_KEYS.journal.length > 0)
})

test('journal-ui-helpers computes Mon-Sun week dates and calendar formatting cleanly across boundaries', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  assert.deepEqual(helpers.getWeekDates('2026-11-18'), [
    '2026-11-16',
    '2026-11-17',
    '2026-11-18',
    '2026-11-19',
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
  ])
  // Sunday stays in the same Mon-Sun week
  assert.deepEqual(helpers.getWeekDates('2026-11-22')[0], '2026-11-16')
  // Monday stays first day
  assert.deepEqual(helpers.getWeekDates('2026-11-16')[6], '2026-11-22')
  // Year boundary Mon-Sun week
  assert.deepEqual(helpers.getWeekDates('2026-12-30'), [
    '2026-12-28',
    '2026-12-29',
    '2026-12-30',
    '2026-12-31',
    '2027-01-01',
    '2027-01-02',
    '2027-01-03',
  ])

  assert.equal(helpers.shiftDateString('2026-11-18', -7), '2026-11-11')
  assert.equal(helpers.shiftDateString('2026-11-30', 1), '2026-12-01')
  assert.equal(helpers.formatJournalHeroDate('2026-11-18'), '11.18')
  assert.equal(helpers.formatJournalYearMonth('2026-11-18'), '2026 / 11')
  assert.equal(helpers.formatWeekdayLabel('2026-11-18', 'zh'), '星期三')
  assert.equal(helpers.formatWeekdayLabel('2026-11-18', 'en'), 'Wednesday')
  assert.equal(helpers.formatShortWeekday('2026-11-18', 'zh'), '三')
  assert.equal(helpers.formatShortWeekday('2026-11-18', 'en'), 'Wed')
})

test('journal-ui-helpers deterministically classifies 12-column card spans and effective species', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  const baseEntry = {
    id: 'je_1',
    date: '2026-11-18',
    time: '06:51',
    ts: '2026-11-18T06:51:00.000+08:00',
    kind: 'note',
    body: '短笔记',
    category: '学习',
    tags: [],
    projectRefs: [],
    source: 'local',
    provenance: 'human',
    images: [],
  }

  // Long rich note gets 7-8 cols; short note gets 5-6 cols
  const longNote = {
    ...baseEntry,
    body: '爬山 800 米。在思考 agent os 的规划，吸取 seven 的设计灵感：分清楚什么是需求、什么是反馈；场景激活；采访模式；人应该负责解决问题的思路模式。',
    tags: ['agent os', '需求 vs 反馈', '采访模式'],
  }
  const longSpan = helpers.classifyJournalCardSpan(longNote, 0)
  const shortSpan = helpers.classifyJournalCardSpan(baseEntry, 1)
  assert.ok(longSpan >= 7 && longSpan <= 8, `expected 7-8 cols for rich note, got ${longSpan}`)
  assert.ok(shortSpan >= 4 && shortSpan <= 6, `expected 4-6 cols for short note, got ${shortSpan}`)

  // AI entry spans full 12 cols
  assert.equal(helpers.classifyJournalCardSpan({ ...baseEntry, kind: 'ai' }, 2), 12)

  // Note with image and concise caption resolves to photo species
  const noteWithImage = {
    ...baseEntry,
    kind: 'note',
    body: '到顶了，山下全是云。',
    images: [{ relativePath: 'attachments/2026/11/cloud.jpg', fileName: 'cloud.jpg', mimeType: 'image/jpeg' }],
  }
  assert.equal(helpers.resolveEffectiveCardKind(noteWithImage), 'photo')
  assert.equal(helpers.resolveEffectiveCardKind({ ...baseEntry, kind: 'moment' }), 'moment')

  // Deterministic across repeated calls
  assert.equal(
    helpers.classifyJournalCardSpan(longNote, 0),
    helpers.classifyJournalCardSpan(longNote, 0),
  )
})

test('journal-ui-helpers extracts #tags and @projects without duplicating or capturing URL hashes', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  const projects = [
    { id: 'p1', name: 'PFMEA' },
    { id: 'p2', name: 'AgentOS' },
  ]
  const parsed = helpers.extractJournalTokens(
    '今天复盘 @PFMEA 和 @AgentOS，参考 https://example.com/#anchor #agent_os #需求反馈 #PFMEA #agent_os',
    projects,
  )

  assert.deepEqual(parsed.tags, ['agent_os', '需求反馈', 'PFMEA'])
  assert.deepEqual(parsed.projectRefs, ['PFMEA', 'AgentOS'])
})

test('journal-ui-helpers cycles categories and provides stable category slugs', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  assert.equal(helpers.getJournalCategorySlug('身体'), 'body')
  assert.equal(helpers.getJournalCategorySlug('工作'), 'work')
  assert.equal(helpers.getJournalCategorySlug('事务'), 'affairs')
  assert.equal(helpers.getJournalCategorySlug('学习'), 'study')
  assert.equal(helpers.getJournalCategorySlug('生活'), 'life')
  assert.equal(helpers.getJournalCategorySlug('工程'), 'engineering')
  assert.equal(helpers.getJournalCategorySlug('未归类'), 'uncategorized')

  assert.equal(helpers.getNextJournalCategory('学习'), '工作')
  assert.equal(helpers.getNextJournalCategory('未归类'), '学习')
})

test('journal-ui-helpers handles lightbox wrapping, snippet truncation, and chat discuss prompt', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  assert.equal(helpers.stepLightboxIndex(0, 3, -1), 2)
  assert.equal(helpers.stepLightboxIndex(2, 3, 1), 0)
  assert.equal(helpers.stepLightboxIndex(1, 3, 1), 2)
  assert.equal(helpers.stepLightboxIndex(0, 0, 1), 0)

  assert.equal(helpers.summarizeEntrySnippet('  第一行\n第二行   很多空格  ', 12), '第一行 第二行 很多空格')
  assert.equal(helpers.summarizeEntrySnippet('这是一段比较长的日记内容需要被截断展示', 10), '这是一段比较长的日…')

  const prompt = helpers.buildJournalDiscussPrompt({
    id: 'je_1',
    date: '2026-11-18',
    time: '06:51',
    ts: '2026-11-18T06:51:00.000+08:00',
    kind: 'note',
    body: '分清楚什么是需求、什么是反馈',
    category: '学习',
    tags: ['agent os'],
    projectRefs: ['AgentOS'],
    source: 'local',
    provenance: 'human',
    images: [],
  })
  assert.match(prompt, /2026-11-18/)
  assert.match(prompt, /06:51/)
  assert.match(prompt, /分清楚什么是需求、什么是反馈/)
  assert.match(prompt, /#agent os/)
})
