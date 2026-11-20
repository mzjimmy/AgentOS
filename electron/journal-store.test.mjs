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

test('journal-markdown: serializes and parses daily markdown losslessly', () => {
  const { serializeDayMarkdown, parseDayMarkdown } = loadTsModule(
    resolve(rootDir, 'electron/desk/journal-markdown.ts')
  )

  const date = '2026-11-20'
  const entries = [
    {
      id: 'je_20261120_065100_a1b2',
      date: '2026-11-20',
      time: '06:51',
      ts: '2026-11-20T06:51:00.000+08:00',
      kind: 'note',
      body: '爬山 800 米。在思考 agent os 的规划...',
      category: '学习',
      tags: ['agent os', '需求 vs 反馈'],
      projectRefs: ['agent-os'],
      source: 'local',
      provenance: 'human',
      externalId: null,
      images: [
        {
          relativePath: 'attachments/2026/11/img_123.png',
          fileName: 'img_123.png',
          mimeType: 'image/png',
          caption: '山顶日出',
        },
      ],
      relatedNote: null,
      momentTitle: null,
      momentSubtitle: null,
    },
  ]

  const markdown = serializeDayMarkdown(date, entries)
  assert.match(markdown, /^# 2026-11-20/)
  assert.match(markdown, /<!-- journal:entry /)
  assert.match(markdown, /### 06:51 · 学习/)
  assert.match(markdown, /!\[山顶日出\]\(\.\.\/\.\.\/attachments\/2026\/11\/img_123\.png\)/)

  const parsed = parseDayMarkdown(date, markdown)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, entries[0].id)
  assert.equal(parsed[0].date, entries[0].date)
  assert.equal(parsed[0].time, entries[0].time)
  assert.equal(parsed[0].category, entries[0].category)
  assert.equal(parsed[0].body, entries[0].body)
  assert.deepEqual(parsed[0].tags, entries[0].tags)
  assert.deepEqual(parsed[0].projectRefs, entries[0].projectRefs)
  assert.equal(parsed[0].images.length, 1)
  assert.equal(parsed[0].images[0].relativePath, entries[0].images[0].relativePath)
})

test('journal-markdown: gracefully parses external human edits from Obsidian', () => {
  const { parseDayMarkdown } = loadTsModule(
    resolve(rootDir, 'electron/desk/journal-markdown.ts')
  )

  const rawObsidianText = `# 2026-11-20

### 10:15 · 工作
在讨论新架构方案。
随手记录了一段细节。

---

<!-- journal:entry {"id":"je_old_1","ts":"2026-11-20T11:00:00.000Z","time":"11:00","kind":"thought","category":"生活","tags":["think"],"projectRefs":[],"source":"local","provenance":"human","images":[]} -->
### 11:30 · 身体
用户在 Obsidian 中把标题从生活改成了身体，正文也被修改成了这句。

![测试图](../../attachments/2026/11/some_shot.png)

---
`

  const parsed = parseDayMarkdown('2026-11-20', rawObsidianText)
  assert.equal(parsed.length, 2)

  // First entry was typed completely by hand without json comment
  assert.equal(parsed[0].time, '10:15')
  assert.equal(parsed[0].category, '工作')
  assert.equal(parsed[0].body, '在讨论新架构方案。\n随手记录了一段细节。')
  assert.equal(parsed[0].kind, 'note')

  // Second entry had comment metadata, but user changed header to 11:30 and 身体, and edited body
  assert.equal(parsed[1].id, 'je_old_1')
  assert.equal(parsed[1].time, '11:30')
  assert.equal(parsed[1].category, '身体')
  assert.equal(parsed[1].body, '用户在 Obsidian 中把标题从生活改成了身体，正文也被修改成了这句。')
  assert.equal(parsed[1].images.length, 1)
  assert.equal(parsed[1].images[0].relativePath, 'attachments/2026/11/some_shot.png')
})

test('journal-store: create, get, deduplicate, update, and delete entries', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))

  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-test-'))
  try {
    const store = new JournalStore({ deskRoot: tempDeskRoot })
    const config = store.getConfig()
    assert.equal(config.deskRoot, tempDeskRoot)
    assert.equal(config.journalRoot, join(tempDeskRoot, 'journal'))

    // 1. Create entry
    const createRes = await store.createEntry({
      date: '2026-11-20',
      time: '14:00',
      body: '测试第一条日记',
      category: '工作',
      tags: ['test'],
      externalId: 'ext:test-1',
    })

    assert.equal(createRes.ok, true)
    if (!createRes.ok) return
    assert.equal(createRes.deduplicated, false)
    assert.equal(createRes.entry.body, '测试第一条日记')
    assert.equal(createRes.entry.externalId, 'ext:test-1')
    assert.ok(existsSync(createRes.filePath))

    // 2. Read back with getDay
    const dayRes = await store.getDay('2026-11-20')
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return
    assert.equal(dayRes.entries.length, 1)
    assert.equal(dayRes.entries[0].id, createRes.entry.id)
    assert.equal(dayRes.entries[0].body, '测试第一条日记')

    // 3. Deduplication with same externalId
    const dupRes = await store.createEntry({
      date: '2026-11-20',
      time: '14:05',
      body: '尝试重复写入同一条记录',
      category: '工作',
      externalId: 'ext:test-1',
    })
    assert.equal(dupRes.ok, true)
    if (!dupRes.ok) return
    assert.equal(dupRes.deduplicated, true)
    assert.equal(dupRes.entry.id, createRes.entry.id)
    assert.equal(dupRes.entry.body, '测试第一条日记')

    // Check that day still has only 1 entry
    const dayAfterDup = await store.getDay('2026-11-20')
    assert.equal(dayAfterDup.ok, true)
    if (!dayAfterDup.ok) return
    assert.equal(dayAfterDup.entries.length, 1)

    // 4. Update entry
    const updateRes = await store.updateEntry('2026-11-20', createRes.entry.id, {
      body: '更新后的日记正文',
      category: '学习',
    })
    assert.equal(updateRes.ok, true)
    if (!updateRes.ok) return
    assert.equal(updateRes.entry.body, '更新后的日记正文')
    assert.equal(updateRes.entry.category, '学习')

    const dayAfterUpdate = await store.getDay('2026-11-20')
    assert.equal(dayAfterUpdate.ok, true)
    if (!dayAfterUpdate.ok) return
    assert.equal(dayAfterUpdate.entries[0].body, '更新后的日记正文')
    assert.equal(dayAfterUpdate.entries[0].category, '学习')

    // 5. Delete entry
    const deleteRes = await store.deleteEntry('2026-11-20', createRes.entry.id)
    assert.equal(deleteRes.ok, true)

    const dayAfterDelete = await store.getDay('2026-11-20')
    assert.equal(dayAfterDelete.ok, true)
    if (!dayAfterDelete.ok) return
    assert.equal(dayAfterDelete.entries.length, 0)
  } finally {
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})

test('journal-store: image attachment persistence and path traversal guard', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))

  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-img-test-'))
  try {
    const store = new JournalStore({ deskRoot: tempDeskRoot })

    // 1x1 transparent PNG in base64
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const dataUrl = `data:image/png;base64,${pngBase64}`

    const createRes = await store.createEntry({
      date: '2026-11-20',
      time: '15:30',
      body: '日落时刻',
      category: '生活',
      images: [
        {
          fileName: 'sunset.png',
          mimeType: 'image/png',
          dataUrl,
          caption: '美丽的日落',
        },
      ],
    })

    assert.equal(createRes.ok, true)
    if (!createRes.ok) return
    assert.equal(createRes.entry.images.length, 1)
    const img = createRes.entry.images[0]
    assert.equal(img.caption, '美丽的日落')
    assert.match(img.relativePath, /^attachments\/2026\/11\/.*sunset\.png$/)

    // Verify attachment file exists on disk
    const diskPath = join(tempDeskRoot, 'journal', img.relativePath)
    assert.ok(existsSync(diskPath))

    // Read attachment back via readAttachment
    const readRes = await store.readAttachment(img.relativePath)
    assert.equal(readRes.ok, true)
    if (!readRes.ok) return
    assert.equal(readRes.mimeType, 'image/png')
    assert.equal(readRes.dataUrl, dataUrl)

    // Security check: Path traversal MUST be strictly rejected!
    const traversalAttack1 = await store.readAttachment('../../../../../etc/passwd')
    assert.equal(traversalAttack1.ok, false)
    assert.match(traversalAttack1.error, /traversal/i)

    const traversalAttack2 = await store.readAttachment('attachments/../../secret.txt')
    assert.equal(traversalAttack2.ok, false)
    assert.match(traversalAttack2.error, /traversal/i)
  } finally {
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})

test('journal-store: listDays and getWeek aggregation', async () => {
  const { JournalStore, getWeekDates } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))

  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-agg-test-'))
  try {
    const store = new JournalStore({ deskRoot: tempDeskRoot })

    // Test getWeekDates for 2026-11-20 (Friday)
    // Week should be 2026-11-16 (Mon) to 2026-11-22 (Sun)
    const weekDays = getWeekDates('2026-11-20')
    assert.deepEqual(weekDays, [
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ])

    // Create entries on multiple dates
    await store.createEntry({ date: '2026-11-18', time: '09:00', body: '周三记录', category: '工作' })
    await store.createEntry({ date: '2026-11-20', time: '10:00', body: '周五记录 1', category: '学习', source: 'feishu' })
    await store.createEntry({ date: '2026-11-20', time: '18:00', body: '周五记录 2', category: '生活' })

    // listDays
    const listRes = await store.listDays('2026-11')
    assert.equal(listRes.length, 2)
    assert.equal(listRes[0].date, '2026-11-20')
    assert.equal(listRes[0].count, 2)
    assert.equal(listRes[0].hasFeishu, true)
    assert.equal(listRes[1].date, '2026-11-18')
    assert.equal(listRes[1].count, 1)

    // getWeek
    const weekRes = await store.getWeek('2026-11-20')
    assert.equal(weekRes.ok, true)
    if (!weekRes.ok) return
    assert.equal(weekRes.startDate, '2026-11-16')
    assert.equal(weekRes.endDate, '2026-11-22')
    assert.equal(weekRes.days.length, 7)
    // Day 2 (Wed 2026-11-18)
    assert.equal(weekRes.days[2].date, '2026-11-18')
    assert.equal(weekRes.days[2].entries.length, 1)
    // Day 4 (Fri 2026-11-20)
    assert.equal(weekRes.days[4].date, '2026-11-20')
    assert.equal(weekRes.days[4].entries.length, 2)
    // Other days empty
    assert.equal(weekRes.days[0].entries.length, 0)
  } finally {
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})

test('journal-store: watch emits JournalChangedEvent on external file modification', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))

  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-watch-test-'))
  let store = null
  try {
    const events = []
    let resolveExternal = null
    const externalPromise = new Promise((res) => { resolveExternal = res })
    store = new JournalStore({
      deskRoot: tempDeskRoot,
      onChange: (evt) => {
        events.push(evt)
        if (evt.reason === 'external-write') resolveExternal?.(evt)
      },
    })

    const watchRes = store.watch()
    assert.equal(watchRes.ok, true)

    // External write into journal/2026/11/2026-11-20.md
    const targetDir = join(tempDeskRoot, 'journal', '2026', '11')
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(targetDir, { recursive: true })

    const externalContent = `# 2026-11-20\n\n### 16:00 · 外部\n来自外部编辑的记录。\n\n---\n`
    writeFileSync(join(targetDir, '2026-11-20.md'), externalContent, 'utf8')

    // Wait for FSEvents + debounce with bounded timeout
    const externalEvt = await Promise.race([
      externalPromise,
      new Promise((res) => setTimeout(() => res(null), 2000)),
    ])

    assert.ok(events.length >= 1)
    assert.ok(externalEvt)
    assert.deepEqual(externalEvt.dates, ['2026-11-20'])
  } finally {
    store?.unwatch()
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})





test('journal-markdown: preserves markdown horizontal rules (---) inside entry prose', () => {
  const { serializeDayMarkdown, parseDayMarkdown } = loadTsModule(resolve(rootDir, 'electron/desk/journal-markdown.ts'))

  const entries = [
    {
      id: 'je_20261120_100000_hr1',
      date: '2026-11-20',
      time: '10:00',
      ts: '2026-11-20T10:00:00.000+08:00',
      kind: 'note',
      body: '上半段思考\n\n---\n\n下半段结论',
      category: '学习',
      tags: ['markdown'],
      projectRefs: [],
      source: 'local',
      provenance: 'human',
      externalId: null,
      images: [],
      relatedNote: null,
      momentTitle: null,
      momentSubtitle: null,
    },
    {
      id: 'je_20261120_110000_hr2',
      date: '2026-11-20',
      time: '11:00',
      ts: '2026-11-20T11:00:00.000+08:00',
      kind: 'thought',
      body: '第二条独立记录',
      category: '事务',
      tags: [],
      projectRefs: [],
      source: 'local',
      provenance: 'human',
      externalId: null,
      images: [],
      relatedNote: null,
      momentTitle: null,
      momentSubtitle: null,
    },
  ]

  const md = serializeDayMarkdown('2026-11-20', entries)
  const parsed = parseDayMarkdown('2026-11-20', md)

  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'je_20261120_100000_hr1')
  assert.equal(parsed[0].body, '上半段思考\n\n---\n\n下半段结论')
  assert.equal(parsed[1].id, 'je_20261120_110000_hr2')
  assert.equal(parsed[1].body, '第二条独立记录')
})


test('journal-store: defaults entry date and time to Asia/Shanghai regardless of host timezone', async () => {
  const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-tz-test-'))
  try {
    const store = new JournalStore({ deskRoot: tempDeskRoot })
    const res = await store.createEntry({
      ts: '2026-11-20T20:53:00.000Z',
      body: '对齐东八区时间测试',
      category: '学习',
    })
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal(res.entry.date, '2026-11-21')
    assert.equal(res.entry.time, '04:53')
  } finally {
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})
