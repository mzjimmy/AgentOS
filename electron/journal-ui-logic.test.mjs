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
    { id: 'p3', name: '【Mitchi Sentinel】AgentOS' },
  ]
  const parsed = helpers.extractJournalTokens(
    '今天复盘 @PFMEA 和 @AgentOS，以及 @【Mitchi Sentinel】AgentOS 参考 https://example.com/#anchor #agent_os #需求反馈 #PFMEA #agent_os',
    projects,
  )

  assert.deepEqual(parsed.tags, ['agent_os', '需求反馈', 'PFMEA'])
  assert.deepEqual(parsed.projectRefs, ['【Mitchi Sentinel】AgentOS', 'AgentOS', 'PFMEA'])
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


test('journal-ui-helpers aligns default date and time strictly to Asia/Shanghai regardless of host timezone', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  assert.equal(helpers.toLocalDateString(new Date('2026-11-20T20:53:00.000Z')), '2026-11-21')
  assert.equal(helpers.toLocalTimeString(new Date('2026-11-20T20:53:00.000Z')), '04:53')
  assert.equal(helpers.toLocalDateString(new Date('2026-11-18T08:03:18.740Z')), '2026-11-18')
  assert.equal(helpers.toLocalTimeString(new Date('2026-11-18T08:03:18.740Z')), '16:03')
})

test('journal-ui-helpers builds explicit discuss targets prioritizing SentinelDesk and matched @projectRefs', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))
  const projects = [
    { id: 'p-unrelated', name: '【2026-029】PFMEA', path: '/Users/sentinellab/VibeCoding/PFMEA' },
    { id: 'p-plan', name: '【2026-024】Plan Flow-up', path: '/Users/sentinellab/VibeCoding/Plan' },
  ]
  const deskRoot = '/Users/sentinellab/VibeCoding/SentinelDesk'

  const plainOptions = helpers.buildJournalDiscussTargets(
    { projectRefs: [] },
    projects,
    deskRoot,
  )
  assert.equal(plainOptions[0].kind, 'desk')
  assert.equal(plainOptions[0].deskRoot, deskRoot)
  assert.equal(plainOptions.length, 3)

  const linkedOptions = helpers.buildJournalDiscussTargets(
    { projectRefs: ['【2026-024】Plan Flow-up'] },
    projects,
    deskRoot,
  )
  assert.equal(linkedOptions[0].kind, 'project')
  assert.equal(linkedOptions[0].projectId, 'p-plan')
  assert.equal(linkedOptions[0].matched, true)
  assert.equal(linkedOptions[1].kind, 'desk')
})


test('journal-ui-helpers computes Monday-first 6x7 month calendar grid, month shifts, and month activity summaries', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  // 2026-11-01 is a Sunday -> Monday-first grid starts on 2026-10-26
  const nov2026 = helpers.getMonthCalendarGrid(2026, 11)
  assert.equal(nov2026.length, 42)
  assert.deepEqual(nov2026[0], { date: '2026-10-26', day: 26, inCurrentMonth: false })
  assert.deepEqual(nov2026[6], { date: '2026-11-01', day: 1, inCurrentMonth: true })
  assert.deepEqual(nov2026[35], { date: '2026-11-30', day: 30, inCurrentMonth: true })
  assert.deepEqual(nov2026[36], { date: '2026-12-01', day: 1, inCurrentMonth: false })

  // Leap year Feb 2024 has 29 days; 2024-02-01 is Thursday -> starts on 2024-01-29
  const feb2024 = helpers.getMonthCalendarGrid(2024, 2)
  assert.equal(feb2024.length, 42)
  assert.deepEqual(feb2024[0], { date: '2024-01-29', day: 29, inCurrentMonth: false })
  assert.equal(feb2024.filter((c) => c.inCurrentMonth).length, 29)

  // Year boundary month shifts
  assert.deepEqual(helpers.shiftYearMonth(2026, 1, -1), { year: 2025, month: 12 })
  assert.deepEqual(helpers.shiftYearMonth(2026, 12, 1), { year: 2027, month: 1 })
  assert.deepEqual(helpers.shiftYearMonth(2026, 11, -14), { year: 2025, month: 9 })

  // Month activity aggregation ignores zero-count days
  const monthStats = helpers.summarizeJournalMonths([
    { date: '2026-11-20', count: 3, hasImages: true, hasFeishu: true, hasAi: false },
    { date: '2026-11-18', count: 2, hasImages: false, hasFeishu: false, hasAi: false },
    { date: '2026-11-01', count: 0, hasImages: false, hasFeishu: false, hasAi: false },
    { date: '2026-09-05', count: 4, hasImages: false, hasFeishu: true, hasAi: false },
  ])
  assert.deepEqual(monthStats.get('2026-11'), { daysCount: 2, entriesCount: 5 })
  assert.deepEqual(monthStats.get('2026-09'), { daysCount: 1, entriesCount: 4 })
  assert.equal(monthStats.get('2026-10'), undefined)
})

test('planJournalDayLayout pairs note+short (8/4 compact) and photo+note (5/7) preserving entry order', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  const makeEntry = (overrides) => ({
    id: 'je_base',
    date: '2026-11-21',
    time: '12:00',
    ts: '2026-11-21T12:00:00.000+08:00',
    kind: 'note',
    body: '',
    category: '未归类',
    tags: [],
    projectRefs: [],
    source: 'feishu',
    provenance: 'human',
    images: [],
    ...overrides,
  })

  // Exact scenario from the right screenshot:
  // 12:34 long note, 13:27 short text, 13:28 photo, 13:45 long note
  const entries = [
    makeEntry({
      id: 'e1',
      time: '12:34',
      ts: '2026-11-21T12:34:00.000+08:00',
      body: '刚才已经打开的agentos软件崩溃了。在实现新功能的同时记得检查回归测试。1、你帮我停用；2、你帮我在egolite浏览器里面确认有没有添加，我找不到。3、等你完成打开后我会测试。',
    }),
    makeEntry({
      id: 'e2',
      time: '13:27',
      ts: '2026-11-21T13:27:00.000+08:00',
      body: 'hello, can you hear me',
    }),
    makeEntry({
      id: 'e3',
      time: '13:28',
      ts: '2026-11-21T13:28:00.000+08:00',
      body: '',
      images: [{ relativePath: 'attachments/2026/11/park.jpg', fileName: 'park.jpg', mimeType: 'image/jpeg' }],
    }),
    makeEntry({
      id: 'e4',
      time: '13:45',
      ts: '2026-11-21T13:45:00.000+08:00',
      body: '测试成功了，暂时没有任何异常。接下来我想探讨一下关于日记隐私的问题。像这种挂载在 Agent OS 上面的时间日记软件，会有私人信息上传到服务器或者第三方吗？',
    }),
  ]

  const layout = helpers.planJournalDayLayout(entries)
  assert.equal(layout.length, 4)
  assert.deepEqual(
    layout.map((item) => ({
      id: item.entry.id,
      groupKind: item.groupKind,
      colStart: item.colStart,
      colSpan: item.colSpan,
      rowStart: item.rowStart,
      rowSpan: item.rowSpan,
      presentation: item.presentation,
    })),
    [
      { id: 'e1', groupKind: 'pair-note-short', colStart: 1, colSpan: 8, rowStart: 1, rowSpan: 1, presentation: 'default' },
      { id: 'e2', groupKind: 'pair-note-short', colStart: 9, colSpan: 4, rowStart: 1, rowSpan: 1, presentation: 'compact-thought' },
      { id: 'e3', groupKind: 'pair-photo-note', colStart: 1, colSpan: 5, rowStart: 2, rowSpan: 1, presentation: 'default' },
      { id: 'e4', groupKind: 'pair-photo-note', colStart: 6, colSpan: 7, rowStart: 2, rowSpan: 1, presentation: 'default' },
    ],
  )
  // Entry raw kind must remain untouched
  assert.equal(entries[1].kind, 'note')
})

test('planJournalDayLayout builds 4-entry photo-span quad and respects AI boundaries', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  const makeEntry = (overrides) => ({
    id: 'je_base',
    date: '2026-11-18',
    time: '06:00',
    ts: '2026-11-18T06:00:00.000+08:00',
    kind: 'note',
    body: '',
    category: '学习',
    tags: [],
    projectRefs: [],
    source: 'local',
    provenance: 'human',
    images: [],
    ...overrides,
  })

  const entries = [
    makeEntry({
      id: 'q1',
      time: '06:51',
      ts: '2026-11-18T06:51:00.000+08:00',
      body: '爬山 800 米。在思考 agent os 的规划，吸取 seven 的设计灵感：分清楚什么是需求、什么是反馈；场景激活；采访模式。',
      tags: ['agent os', '需求 vs 反馈', '采访模式'],
    }),
    makeEntry({
      id: 'q2',
      time: '06:31',
      ts: '2026-11-18T06:31:00.000+08:00',
      kind: 'photo',
      category: '身体',
      body: '到顶了，山下全是云。',
      images: [{ relativePath: 'attachments/2026/11/cloud.jpg', fileName: 'cloud.jpg', mimeType: 'image/jpeg' }],
    }),
    makeEntry({
      id: 'q3',
      time: '06:08',
      ts: '2026-11-18T06:08:00.000+08:00',
      kind: 'moment',
      momentTitle: '单曲循环',
      momentSubtitle: '恰逢那年你明媚 · 陈与默',
      body: '单曲循环',
    }),
    makeEntry({
      id: 'q4',
      time: '05:40',
      ts: '2026-11-18T05:40:00.000+08:00',
      kind: 'thought',
      category: '事务',
      body: '搞定了 VPS 的密钥登录，废除了密码登录。',
      relatedNote: '与周一的密钥整理有关',
    }),
    makeEntry({
      id: 'ai1',
      time: '07:30',
      ts: '2026-11-18T07:30:00.000+08:00',
      kind: 'ai',
      body: '每日摘要',
    }),
  ]

  const layout = helpers.planJournalDayLayout(entries)
  assert.deepEqual(
    layout.map((item) => ({
      id: item.entry.id,
      groupKind: item.groupKind,
      colStart: item.colStart,
      colSpan: item.colSpan,
      rowStart: item.rowStart,
      rowSpan: item.rowSpan,
      presentation: item.presentation,
    })),
    [
      { id: 'q1', groupKind: 'quad-photo-right', colStart: 1, colSpan: 7, rowStart: 1, rowSpan: 1, presentation: 'default' },
      { id: 'q2', groupKind: 'quad-photo-right', colStart: 8, colSpan: 5, rowStart: 1, rowSpan: 2, presentation: 'default' },
      { id: 'q3', groupKind: 'quad-photo-right', colStart: 1, colSpan: 3, rowStart: 2, rowSpan: 1, presentation: 'default' },
      { id: 'q4', groupKind: 'quad-photo-right', colStart: 4, colSpan: 4, rowStart: 2, rowSpan: 1, presentation: 'compact-thought' },
      { id: 'ai1', groupKind: 'ai-boundary', colStart: 1, colSpan: 12, rowStart: 3, rowSpan: 1, presentation: 'default' },
    ],
  )
})

test('planJournalDayLayout falls back to 2-entry layout on chronological jump or unsuitable heights', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  const makeEntry = (overrides) => ({
    id: 'je_base',
    date: '2026-11-21',
    time: '09:00',
    ts: '2026-11-21T09:00:00.000+08:00',
    kind: 'note',
    body: '',
    category: '学习',
    tags: [],
    projectRefs: [],
    source: 'local',
    provenance: 'human',
    images: [],
    ...overrides,
  })

  const shortNote = (id, time, body) =>
    makeEntry({ id, time, ts: `2026-11-21T${time}:00.000+08:00`, body })

  const photo = (id, time, count = 1, body = '一张风景') =>
    makeEntry({
      id,
      time,
      ts: `2026-11-21T${time}:00.000+08:00`,
      kind: 'photo',
      body,
      images: Array.from({ length: count }, (_, idx) => ({
        relativePath: `attachments/2026/11/p${idx}.jpg`,
        fileName: `p${idx}.jpg`,
        mimeType: 'image/jpeg',
      })),
    })

  // Case 1: Non-monotonic timestamps -> falls back from quad to pair-photo-note
  const nonMonotonic = [
    makeEntry({
      id: 'nm1',
      time: '09:00',
      ts: '2026-11-21T09:00:00.000+08:00',
      body: '这是一段长度适中的长笔记，用于测试时间跳序时应该退回到双条目布局而不是强行拼成四条目。',
    }),
    photo('nm2', '09:30'),
    shortNote('nm3', '09:10', '短句一'),
    shortNote('nm4', '09:20', '短句二'),
  ]
  const nmLayout = helpers.planJournalDayLayout(nonMonotonic)
  assert.equal(nmLayout[0].groupKind, 'pair-photo-note')
  assert.equal(nmLayout[1].groupKind, 'pair-photo-note')
  assert.equal(nmLayout[1].rowSpan, 1)

  // Case 2: Overly long note (> 180 chars) -> height unsuitable -> falls back to pair-photo-note
  const tooTallNote = [
    makeEntry({
      id: 'ht1',
      time: '09:00',
      ts: '2026-11-21T09:00:00.000+08:00',
      body: '很长的复盘记录。'.repeat(30),
    }),
    photo('ht2', '09:10'),
    shortNote('ht3', '09:20', '短句一'),
    shortNote('ht4', '09:30', '短句二'),
  ]
  const htLayout = helpers.planJournalDayLayout(tooTallNote)
  assert.equal(htLayout[0].groupKind, 'pair-photo-note')
  assert.equal(htLayout[1].rowSpan, 1)

  // Case 3: Multi-line text with 3+ lines is not treated as compact short record
  const multiLine = makeEntry({
    id: 'ml1',
    body: '第一行\n第二行\n第三行',
  })
  assert.equal(helpers.isCompactShortEntry(multiLine), false)
})

test('sliceWeekDayEntries caps visible week-column items to 12 and reports overflow count', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))
  assert.equal(helpers.WEEK_VIEW_MAX_VISIBLE_ENTRIES, 12)

  const twelve = Array.from({ length: 12 }, (_, idx) => idx)
  assert.deepEqual(helpers.sliceWeekDayEntries(twelve), { visible: twelve, overflowCount: 0 })

  const fifteen = Array.from({ length: 15 }, (_, idx) => idx)
  assert.deepEqual(helpers.sliceWeekDayEntries(fifteen), {
    visible: twelve,
    overflowCount: 3,
  })
})

test('resolveJournalBodyCollapsePolicy collapses long note cards and uses a relaxed threshold for thought cards', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))

  const makeEntry = (overrides) => ({
    id: 'je_collapse',
    date: '2026-11-21',
    time: '20:12',
    ts: '2026-11-21T20:12:00.000+08:00',
    kind: 'note',
    body: '',
    category: '工程',
    tags: [],
    projectRefs: [],
    source: 'local',
    provenance: 'human',
    images: [],
    ...overrides,
  })

  // Short note: not collapsible
  assert.deepEqual(
    helpers.resolveJournalBodyCollapsePolicy(makeEntry({ body: '简短笔记，不需要收起。' })),
    { collapsible: false, collapsedLines: 0 },
  )

  // Long note (> 180 chars): collapsible to 5 lines
  assert.deepEqual(
    helpers.resolveJournalBodyCollapsePolicy(makeEntry({ body: '这是一段很长的方框笔记内容。'.repeat(16) })),
    { collapsible: true, collapsedLines: 5 },
  )

  // Multi-line note (> 6 lines): collapsible to 5 lines
  assert.deepEqual(
    helpers.resolveJournalBodyCollapsePolicy(
      makeEntry({ body: '1\n2\n3\n4\n5\n6\n7' }),
    ),
    { collapsible: true, collapsedLines: 5 },
  )

  // Moderately long thought (~240 chars, would collapse if it were a note): NOT collapsible (relaxed threshold)
  assert.deepEqual(
    helpers.resolveJournalBodyCollapsePolicy(
      makeEntry({ kind: 'thought', body: '这是一段中等长度的随想记录，应该完整展开不被过早折叠。'.repeat(10) }),
    ),
    { collapsible: false, collapsedLines: 0 },
  )

  // Extra-long thought (> 420 chars): collapsible with relaxed 10-line clamp
  assert.deepEqual(
    helpers.resolveJournalBodyCollapsePolicy(
      makeEntry({ kind: 'thought', body: '这是一段非常非常长的随想深度复盘文本。'.repeat(28) }),
    ),
    { collapsible: true, collapsedLines: 10 },
  )

  // Extra-long multi-line thought (> 12 lines): collapsible with 10-line clamp
  assert.deepEqual(
    helpers.resolveJournalBodyCollapsePolicy(
      makeEntry({ kind: 'thought', body: Array.from({ length: 13 }, (_, i) => `行${i + 1}`).join('\n') }),
    ),
    { collapsible: true, collapsedLines: 10 },
  )

  // Non-note/thought species (ai, photo, moment, judgment) and compact-thought presentation: never collapsible
  assert.equal(
    helpers.resolveJournalBodyCollapsePolicy(makeEntry({ kind: 'ai', body: '总结。'.repeat(150) })).collapsible,
    false,
  )
  assert.equal(
    helpers.resolveJournalBodyCollapsePolicy(
      makeEntry({ kind: 'note', body: '这是一段很长的方框笔记内容。'.repeat(16) }),
      'compact-thought',
    ).collapsible,
    false,
  )
})

test('resolvePhotoOrientation classifies portrait, landscape, and square dimensions', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))
  assert.equal(helpers.resolvePhotoOrientation(900, 1600), 'portrait')
  assert.equal(helpers.resolvePhotoOrientation(1600, 900), 'landscape')
  assert.equal(helpers.resolvePhotoOrientation(1000, 1000), 'square')
  assert.equal(helpers.resolvePhotoOrientation(0, 100), 'landscape')
})

test('shouldShowLegacySyncButton hides legacy sync controls on future dates and wires into JournalPage', () => {
  const helpers = loadTsModule(resolve(rootDir, 'src/components/journal/journal-ui-helpers.ts'))
  assert.equal(helpers.isFutureJournalDate('2026-11-23', '2026-11-22'), true)
  assert.equal(helpers.isFutureJournalDate('2026-12-01', '2026-11-22'), true)
  assert.equal(helpers.isFutureJournalDate('2026-11-22', '2026-11-22'), false)
  assert.equal(helpers.isFutureJournalDate('2026-11-21', '2026-11-22'), false)

  // Future dates never show the legacy history sync button even if legacy DB is available
  assert.equal(helpers.shouldShowLegacySyncButton('2026-11-23', '2026-11-22', true), false)
  assert.equal(helpers.shouldShowLegacySyncButton('2026-12-31', '2026-11-22', true), false)
  // Today and past dates show it when legacy DB is available
  assert.equal(helpers.shouldShowLegacySyncButton('2026-11-22', '2026-11-22', true), true)
  assert.equal(helpers.shouldShowLegacySyncButton('2026-11-21', '2026-11-22', true), true)
  // Unavailable legacy DB hides it
  assert.equal(helpers.shouldShowLegacySyncButton('2026-11-21', '2026-11-22', false), false)

  // Verify JournalPage actually gates both the empty-state CTA and hero sync button
  const pageSource = readFileSync(resolve(rootDir, 'src/components/journal/JournalPage.tsx'), 'utf8')
  assert.match(pageSource, /shouldShowLegacySyncButton/)
  assert.match(pageSource, /isFutureJournalDate/)
})
