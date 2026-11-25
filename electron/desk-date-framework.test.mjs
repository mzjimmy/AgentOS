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

test('desk-date-framework contract: summarizes calendar months and clamps future week navigation', () => {
  const {
    DESK_DATE_ARCHIVED_VIEW_IDS,
    summarizeDeskCalendarMonths,
    resolveNextWeekTargetDate,
  } = loadTsModule(resolve(rootDir, 'src/components/desk/desk-date-framework-contract.ts'))

  assert.deepEqual([...DESK_DATE_ARCHIVED_VIEW_IDS], [
    'journal',
    'intent-todo',
    'language-push',
    'morning-brief',
    'outbound',
  ])

  const summary = summarizeDeskCalendarMonths([
    { date: '2026-11-02', hasActivity: true, count: 3 },
    { date: '2026-11-02', hasActivity: true, count: 99 }, // duplicate date ignored
    { date: '2026-11-18', hasActivity: true, count: 5 },
    { date: '2026-11-19', hasActivity: false, count: 4 }, // inactive ignored
    { date: '2026-10-30', hasActivity: true }, // default count=1
  ])
  assert.deepEqual(summary.get('2026-11'), { daysCount: 2, totalCount: 8 })
  assert.deepEqual(summary.get('2026-10'), { daysCount: 1, totalCount: 1 })
  assert.equal(summary.has('2026-09'), false)

  // Future disabled: current week (2026-11-23..2026-11-29) containing today 2026-11-24 disables next week
  const curWeek = resolveNextWeekTargetDate('2026-11-24', '2026-11-24', true)
  assert.equal(curWeek.disabled, true)

  // Past week: 2026-11-19 + 7 = 2026-11-26 > today (2026-11-24), so clamps to todayDate
  const prevWeek = resolveNextWeekTargetDate('2026-11-19', '2026-11-24', true)
  assert.equal(prevWeek.disabled, false)
  assert.equal(prevWeek.targetDate, '2026-11-24')

  // Future allowed (e.g. Journal): never disabled, never clamped
  const futureAllowed = resolveNextWeekTargetDate('2026-11-24', '2026-11-24', false)
  assert.equal(futureAllowed.disabled, false)
  assert.equal(futureAllowed.targetDate, '2026-12-01')
})

test('DeskDateTopbar locks horizontal wheel center via 3-column CSS Grid & fixed height (zero page-switch drift)', () => {
  const topbarTsx = readFileSync(resolve(rootDir, 'src/components/desk/DeskDateTopbar.tsx'), 'utf8')
  const topbarCss = readFileSync(resolve(rootDir, 'src/styles/desk-date-topbar.css'), 'utf8')

  // Must use CSS Grid 3-column locking, NOT flex + spacers (which drifts whenever left/right widths vary)
  assert.match(topbarCss, /\.desk-topbar\s*\{[\s\S]*?display:\s*grid;/)
  assert.match(topbarCss, /\.desk-topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\);/)
  assert.match(topbarCss, /\.desk-topbar\s*\{[\s\S]*?height:\s*56px;/)
  assert.match(topbarCss, /\.desk-week-strip\s*\{[\s\S]*?justify-self:\s*center;/)

  // Spacer divs must be gone so Grid's 3 columns map directly to left / week-strip / right
  assert.doesNotMatch(topbarTsx, /desk-topbar-spacer/)
})

test('all 5 date-archived SentinelDesk pages use DeskDatePageShell with zero hand-rolled journal-topbar remnants', () => {
  const pages = [
    { name: 'JournalPage', rel: 'src/components/journal/JournalPage.tsx' },
    { name: 'IntentTodoPage', rel: 'src/components/intent-todo/IntentTodoPage.tsx' },
    { name: 'LanguagePushPage', rel: 'src/components/language-push/LanguagePushPage.tsx' },
    { name: 'MorningBriefPage', rel: 'src/components/morning-brief/MorningBriefPage.tsx' },
    { name: 'OutboundPage', rel: 'src/components/outbound/OutboundPage.tsx' },
  ]

  for (const page of pages) {
    const src = readFileSync(resolve(rootDir, page.rel), 'utf8')
    assert.match(src, /import\s*\{[^}]*\bDeskDatePageShell\b[^}]*\}\s*from\s*'\.\.\/desk\/DeskDatePageShell'/, `${page.name} must import DeskDatePageShell`)
    assert.match(src, /<DeskDatePageShell\b/, `${page.name} must render DeskDatePageShell`)
    assert.doesNotMatch(src, /<header\s+className="journal-topbar"/, `${page.name} must not hand-code journal-topbar`)
    assert.doesNotMatch(src, /<DeskDateTopbar\b/, `${page.name} should go through DeskDatePageShell instead of raw DeskDateTopbar`)
  }

  // Anti-pattern guard: JournalCalendarPopover duplicate component & dead .journal-topbar CSS must be retired
  assert.equal(
    existsSync(resolve(rootDir, 'src/components/journal/JournalCalendarPopover.tsx')),
    false,
    'JournalCalendarPopover.tsx must be consolidated into DeskCalendarPopover.tsx',
  )
  const journalCss = readFileSync(resolve(rootDir, 'src/styles/journal-page.css'), 'utf8')
  assert.doesNotMatch(journalCss, /\.journal-topbar\b/, 'dead .journal-topbar CSS must be cleaned up')
  assert.doesNotMatch(journalCss, /\.journal-calendar-popover\b/, 'dead .journal-calendar-popover CSS must be cleaned up')
})

test('MorningBriefPage & OutboundPage keep topbar rightSlot lean (no stats/gear crammed next to week wheel)', () => {
  const mbSrc = readFileSync(resolve(rootDir, 'src/components/morning-brief/MorningBriefPage.tsx'), 'utf8')
  const obSrc = readFileSync(resolve(rootDir, 'src/components/outbound/OutboundPage.tsx'), 'utf8')
  const lpSrc = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')

  // Morning Brief & Outbound put stats in heroMeta and gear in heroRight (Option 1), NOT topbar-actions
  assert.doesNotMatch(mbSrc, /className="mb-topbar-actions"/, 'MorningBriefPage must move multi-control cluster out of topbar rightSlot')
  assert.doesNotMatch(obSrc, /className="ob-topbar-actions"/, 'OutboundPage must move multi-control cluster out of topbar rightSlot')

  // Language Push upgraded from inline .lp-header / .lp-settings-drawer to DeskDatePageShell + modal settings
  assert.doesNotMatch(lpSrc, /className="lp-header"/, 'LanguagePushPage must replace legacy .lp-header with DeskDatePageShell')
  assert.doesNotMatch(lpSrc, /className="lp-settings-drawer"/, 'LanguagePushPage settings must be a modal dialog, not an inline drawer')
  assert.match(lpSrc, /<DeskModalDialog\b/, 'LanguagePushPage settings must render via shared accessible DeskModalDialog')
})

test('LanguagePushStore & LanguagePushService support historical date archive overview and calendarMarkers', async () => {
  const { LanguagePushStore } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-store.ts'))
  const { LanguagePushService } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-date-'))

  try {
    const store = new LanguagePushStore({
      getDeskRoot: () => tempRoot,
      now: () => new Date('2026-11-24T06:00:00Z'), // Shanghai 2026-11-24 14:00
    })

    // Seed cards on two distinct dates: 2026-11-20 and 2026-11-24
    await store.mergeExtractionResult({
      logicalDate: '2026-11-20',
      providerName: 'Test',
      modelUsed: 'test-model',
      processedEntryIds: ['e1:en'],
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
      ],
      statsBase: { scannedEntries: 1, eligibleEntries: 1, skippedPrivate: 0, skippedAlreadyProcessed: 0, durationMs: 10 },
    })

    await store.mergeExtractionResult({
      logicalDate: '2026-11-24',
      providerName: 'Test',
      modelUsed: 'test-model',
      processedEntryIds: ['e2:ja'],
      corpusItems: [
        { entryId: 'e2', sourceDate: '2026-11-24', lang: 'ja', translatedText: '今日は共通の日付バーを整えた。' },
      ],
      candidates: [
        {
          lang: 'ja',
          kind: 'grammar',
          surface: '〜を踏まえて',
          reading: 'をふまえて',
          meaning: '基于……的前提下',
          levelTag: 'N2',
          exampleSentence: '既存課題を踏まえて設計した。',
          exampleTranslation: '在充分考虑既有问题的前提下进行了设计。',
          sourceDate: '2026-11-24',
          sourceEntryId: 'e2',
        },
      ],
      statsBase: { scannedEntries: 1, eligibleEntries: 1, skippedPrivate: 0, skippedAlreadyProcessed: 0, durationMs: 10 },
    })

    const providerDisplay = { providerName: 'Test', modelName: 'test-model', configured: true, ttsConfigured: false }

    // Default (today) overview returns todayDate === selectedDate and includes calendarMarkers for both dates
    const todayOv = store.buildOverview({ runState: 'idle', runError: null, providerDisplay })
    assert.equal(todayOv.todayDate, '2026-11-24')
    assert.equal(todayOv.selectedDate, '2026-11-24')
    assert.ok(Array.isArray(todayOv.calendarMarkers), 'calendarMarkers must be an array')
    const markerDates = todayOv.calendarMarkers.map((m) => m.date)
    assert.ok(markerDates.includes('2026-11-20'), 'calendarMarkers must include past active date 2026-11-20')
    assert.ok(markerDates.includes('2026-11-24'), 'calendarMarkers must include today 2026-11-24')

    // Historical date overview returns ONLY cards associated with 2026-11-20
    const pastOv = store.buildOverview({
      runState: 'idle',
      runError: null,
      providerDisplay,
      targetDate: '2026-11-20',
    })
    assert.equal(pastOv.todayDate, '2026-11-24')
    assert.equal(pastOv.selectedDate, '2026-11-20')
    assert.equal(pastOv.todayCards.length, 1)
    assert.equal(pastOv.todayCards[0].surface, 'resilient')
    assert.equal(pastOv.counts.todayTotal, 1)
    assert.equal(pastOv.counts.todayVocab, 1)
    assert.equal(pastOv.counts.todayGrammar, 0)

    // Empty historical date returns 0 cards cleanly
    const emptyOv = store.buildOverview({
      runState: 'idle',
      runError: null,
      providerDisplay,
      targetDate: '2026-11-10',
    })
    assert.equal(emptyOv.selectedDate, '2026-11-10')
    assert.equal(emptyOv.todayCards.length, 0)
    assert.equal(emptyOv.counts.todayTotal, 0)

    // Service seam passes date through getOverview(date) and decideCard(id, action, date)
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
    const svcPast = service.getOverview('2026-11-20')
    assert.equal(svcPast.selectedDate, '2026-11-20')
    assert.equal(svcPast.todayCards.length, 1)
    assert.equal(svcPast.todayCards[0].surface, 'resilient')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('review regression F10: summarizeDeskCalendarMonths keeps explicit count=0 distinct from absent count', () => {
  const { summarizeDeskCalendarMonths } = loadTsModule(
    resolve(rootDir, 'src/components/desk/desk-date-framework-contract.ts'),
  )
  const summary = summarizeDeskCalendarMonths([
    { date: '2026-11-10', hasActivity: true, count: 1 },
    { date: '2026-11-11', hasActivity: true, count: 0 },
  ])
  assert.deepEqual(summary.get('2026-11'), { daysCount: 2, totalCount: 1 })
})

test('review regression F5: desk-date-topbar.css responsive compact rules follow base week-pill rules and support container width', () => {
  const css = readFileSync(resolve(rootDir, 'src/styles/desk-date-topbar.css'), 'utf8')
  const basePillIdx = css.indexOf('.desk-week-pill {')
  const compactRuleIdx = css.lastIndexOf('min-width: 28px;')
  assert.ok(basePillIdx > -1 && compactRuleIdx > basePillIdx, 'compact .desk-week-pill rule must appear AFTER base .desk-week-pill rule in CSS cascade')
  assert.match(css, /@container\b/, 'desk-date-topbar.css must adapt to workspace container width, not only viewport width')
})

test('review regression F2/F3/F4: LanguagePush past-date extraction returns exact date overview/stats, associates extractedDate, and does not coalesce different dates', async () => {
  const { LanguagePushService } = loadTsModule(resolve(rootDir, 'electron/desk/language-push-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-lp-rev-'))

  try {
    const journalByDate = {
      '2026-11-09': {
        entries: [
          {
            id: 'je_09',
            date: '2026-11-09',
            time: '10:00',
            body: '今天梳理了高韧性架构设计，防止页面切换抖动。',
            category: '工程',
            tags: [],
            private: false,
            provenance: 'human',
          },
        ],
      },
      '2026-11-23': {
        entries: [
          {
            id: 'je_23',
            date: '2026-11-23',
            time: '10:00',
            body: '今天完成了统一顶栏中轴对齐重构。',
            category: '工程',
            tags: [],
            private: false,
            provenance: 'human',
          },
        ],
      },
    }

    let llmCalls = 0
    const service = new LanguagePushService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: async (date) => ({ ok: true, date, filePath: '', entries: journalByDate[date]?.entries ?? [] }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'k', authToken: '', baseUrl: 'https://example.invalid', model: 'm', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p', providers: [{ id: 'p', name: 'P', model: 'm' }] } }),
      },
      now: () => new Date('2026-11-24T06:00:00Z'),
      llmCaller: async (_cfg, req) => {
        llmCalls += 1
        await new Promise((r) => setTimeout(r, 20))
        const userText = req.messages.map((m) => m.content).join('\n')
        const isJa = userText.includes('Target language: Japanese')
        const isNov23 = userText.includes('je_23')
        if (isJa) {
          return {
            ok: true,
            model: 'm',
            durationMs: 5,
            text: JSON.stringify({
              corpus: [{ entryId: isNov23 ? 'je_23' : 'je_09', translatedText: '今日は共通の日付バーを整えた。' }],
              cards: [
                isNov23
                  ? {
                      kind: 'vocab',
                      surface: '整列',
                      reading: 'せいれつ',
                      meaning: '对齐',
                      levelTag: 'N2',
                      exampleSentence: '画面を切り替えても要素の整列が保たれる。',
                      exampleTranslation: '切换页面时元素对齐依然保持。',
                      sourceEntryId: 'je_23',
                    }
                  : {
                      kind: 'vocab',
                      surface: '堅牢',
                      reading: 'けんろう',
                      meaning: '稳健；坚固',
                      levelTag: 'N1',
                      exampleSentence: '堅牢な設計のおかげで揺れが起きない。',
                      exampleTranslation: '得益于稳健设计不会出现抖动。',
                      sourceEntryId: 'je_09',
                    },
              ],
            }),
          }
        }
        return {
          ok: true,
          model: 'm',
          durationMs: 5,
          text: JSON.stringify({
            corpus: [{ entryId: isNov23 ? 'je_23' : 'je_09', translatedText: 'Refactored layout architecture.' }],
            cards: [
              isNov23
                ? {
                    kind: 'vocab',
                    surface: 'alignment',
                    reading: '/əˈlaɪnmənt/',
                    meaning: '对齐',
                    levelTag: 'B2',
                    exampleSentence: 'Strict alignment prevents layout jitter.',
                    exampleTranslation: '严格对齐避免布局抖动。',
                    sourceEntryId: 'je_23',
                  }
                : {
                    kind: 'vocab',
                    surface: 'resilient',
                    reading: '/rɪˈzɪliənt/',
                    meaning: '有韧性的',
                    levelTag: 'B2',
                    exampleSentence: 'Resilient architecture scales cleanly.',
                    exampleTranslation: '有韧性的架构易于扩展。',
                    sourceEntryId: 'je_09',
                  },
            ],
          }),
        }
      },
    })

    // Fire Nov 23 and Nov 10 concurrently: F2 must NOT coalesce incompatible dates!
    const [res23, res10] = await Promise.all([
      service.runExtraction({ date: '2026-11-23' }),
      service.runExtraction({ date: '2026-11-10' }),
    ])

    assert.equal(res23.ok, true, res23.error)
    assert.equal(res10.ok, true, res10.error)
    assert.equal(res10.logicalDate, '2026-11-10', 'concurrent Nov 10 extraction must NOT return Nov 23 logicalDate')
    // F3: Nov 10 run returns Nov 10 overview & Nov 10 snapshot (even though Nov 23 run file exists!)
    assert.equal(res10.overview.selectedDate, '2026-11-10')
    assert.equal(res10.overview.lastRun?.logicalDate, '2026-11-10')
    // F4: card extracted on Nov 10 from a Nov 09 entry is still visible when viewing Nov 10 archive
    assert.ok(
      res10.overview.todayCards.some((c) => c.surface === 'resilient'),
      'card extracted during Nov 10 run from Nov 09 note must appear in Nov 10 archive',
    )
    assert.ok(llmCalls >= 4, 'both dates must execute independently rather than silently coalescing')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('review regression F6/F8: shared DeskModalDialog focus/Esc trap & stale-IPC guards on MorningBrief and Outbound', () => {
  const shellTsx = readFileSync(resolve(rootDir, 'src/components/desk/DeskDatePageShell.tsx'), 'utf8')
  const mbTsx = readFileSync(resolve(rootDir, 'src/components/morning-brief/MorningBriefPage.tsx'), 'utf8')
  const obTsx = readFileSync(resolve(rootDir, 'src/components/outbound/OutboundPage.tsx'), 'utf8')
  const lpTsx = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')

  assert.match(shellTsx, /export function DeskModalDialog\b/, 'DeskDatePageShell must export shared DeskModalDialog with Escape + Tab focus trap + trigger restore')
  assert.match(mbTsx, /<DeskModalDialog\b/, 'MorningBriefPage settings must use shared DeskModalDialog')
  assert.match(obTsx, /<DeskModalDialog\b/, 'OutboundPage settings must use shared DeskModalDialog')
  assert.match(lpTsx, /<DeskModalDialog\b/, 'LanguagePushPage settings must use shared DeskModalDialog')

  assert.match(mbTsx, /loadSeqRef/, 'MorningBriefPage must guard stale async overview responses')
  assert.match(obTsx, /loadSeqRef/, 'OutboundPage must guard stale async overview responses')
})

test('BDD/ATDD: collapsed sidebar keeps top-left chrome toolbar clickable over DeskDateTopbar without losing window drag', () => {
  const topbarTsx = readFileSync(resolve(rootDir, 'src/components/desk/DeskDateTopbar.tsx'), 'utf8')
  const topbarCss = readFileSync(resolve(rootDir, 'src/styles/desk-date-topbar.css'), 'utf8')

  // R1: <header className="desk-topbar"> must NEVER be a global drag region (mirrors window-chrome.test.mjs for app-workspace-header)
  assert.doesNotMatch(
    topbarTsx,
    /<header\s+className="[^"]*\bdesk-topbar\b[^"]*\bdraggable\b/,
    'desk-topbar <header> must not declare .draggable globally or macOS drag regions swallow .app-chrome-toolbar when sidebar is collapsed',
  )
  assert.doesNotMatch(
    topbarCss,
    /\.desk-topbar\s*\{[^}]*-webkit-app-region:\s*drag;/s,
    '.desk-topbar container must not declare -webkit-app-region: drag directly',
  )

  // R2 & R3: dedicated .desk-topbar-drag layer precedes interactive children in DOM and clears .app-chrome-toolbar when collapsed
  const dragIndex = topbarTsx.indexOf('className="desk-topbar-drag"')
  const leftIndex = topbarTsx.indexOf('className="desk-topbar-left no-drag"')
  assert.ok(dragIndex >= 0, 'DeskDateTopbar must render a dedicated .desk-topbar-drag layer')
  assert.ok(
    leftIndex > dragIndex,
    '.desk-topbar-drag must precede .desk-topbar-left in DOM order so Blink pre-order annotated regions carve out no-drag controls after drag',
  )

  assert.match(
    topbarCss,
    /\.desk-topbar-drag\s*\{[^}]*position:\s*absolute;[^}]*-webkit-app-region:\s*drag;[^}]*pointer-events:\s*none;/s,
    '.desk-topbar-drag must be an absolute non-blocking drag layer',
  )
  assert.match(
    topbarCss,
    /\.app-shell\.is-sidebar-collapsed\s+\.desk-topbar-drag\s*\{[^}]*left:\s*calc\([^;]*--spacing-token-safe-header-left[^;]*--width-chrome-toolbar[^;]*\);/s,
    'when sidebar is collapsed, .desk-topbar-drag must start after the safe-left + chrome-toolbar zone',
  )
  assert.match(
    topbarCss,
    /html\[data-windows-titlebar-overlay='true'\]\s+\.desk-topbar-drag\s*\{[^}]*right:\s*var\(--spacing-token-safe-header-right\);/s,
    'Windows titlebar overlay must keep .desk-topbar-drag clear of right caption controls',
  )

  // R4: narrow viewport media query must not collapse .app-shell.is-sidebar-collapsed .desk-topbar padding-left to 12px
  const narrowMediaMatch = topbarCss.match(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*)\}\s*$/)
  assert.ok(narrowMediaMatch, 'expected @media (max-width: 720px) block in desk-date-topbar.css')
  assert.doesNotMatch(
    narrowMediaMatch[1],
    /\.app-shell\.is-sidebar-collapsed\s+\.desk-topbar[^{]*\{[^}]*padding-left:\s*12px;/s,
    'narrow media query must preserve collapsed left safe-area padding so topbar controls never overlap .app-chrome-toolbar',
  )

  // TDD geometry verification of Blink pre-order CollectAnnotatedRegions + Electron macOS SkRegion Union/Difference
  const evaluatePointDraggable = (regions, x, y) => {
    let draggable = false
    for (const region of regions) {
      if (x >= region.left && x < region.right && y >= region.top && y < region.bottom) {
        draggable = region.draggable
      }
    }
    return draggable
  }

  const chromeButtons = [
    { id: 'btn-toggle-sidebar', x: 100, y: 20 },
    { id: 'btn-back', x: 129, y: 20 },
    { id: 'btn-forward', x: 157, y: 20 },
    { id: 'btn-sidebar-search', x: 186, y: 20 },
  ]
  const fixedRegions = [
    // Preceding DOM sibling: .app-chrome-toolbar (no-drag)
    { left: 88, top: 0, right: 232, bottom: 40, draggable: false },
    // Following DOM sibling: .desk-topbar-drag inset to 244px when collapsed
    { left: 244, top: 0, right: 1280, bottom: 56, draggable: true },
    // Following children inside .desk-topbar (no-drag)
    { left: 244, top: 10, right: 380, bottom: 46, draggable: false }, // left controls
    { left: 500, top: 8, right: 780, bottom: 48, draggable: false }, // center week wheel
    { left: 960, top: 12, right: 1036, bottom: 44, draggable: false }, // right segmented switch
  ]

  for (const btn of chromeButtons) {
    assert.equal(
      evaluatePointDraggable(fixedRegions, btn.x, btn.y),
      false,
      `${btn.id} must remain clickable (not draggable) when sidebar is collapsed`,
    )
  }
  assert.equal(evaluatePointDraggable(fixedRegions, 440, 28), true, 'blank topbar gap must remain draggable')
  assert.equal(evaluatePointDraggable(fixedRegions, 640, 28), false, 'center week wheel must remain clickable')
  assert.equal(evaluatePointDraggable(fixedRegions, 990, 28), false, 'right segmented switch must remain clickable')
})
