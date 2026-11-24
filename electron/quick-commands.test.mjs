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

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null
    },
    setItem(key, value) {
      data.set(key, String(value))
    },
  }
}

function loadQuickCommandsModule() {
  return loadTsModule(resolve(rootDir, 'src/components/quick-commands/quick-commands-store.ts'))
}

test('empty storage seeds starter commands and an empty save never resurrects them', () => {
  const { DEFAULT_STARTER_COMMANDS, QUICK_COMMANDS_STORAGE_KEY } = loadTsModule(
    resolve(rootDir, 'src/quick-commands-contract.ts'),
  )
  const { loadQuickCommands, saveQuickCommands } = loadQuickCommandsModule()
  const storage = memoryStorage()

  const seeded = loadQuickCommands(storage)
  assert.equal(seeded.length, DEFAULT_STARTER_COMMANDS.length)
  for (let index = 0; index < DEFAULT_STARTER_COMMANDS.length; index += 1) {
    assert.equal(seeded[index].title, DEFAULT_STARTER_COMMANDS[index].title)
    assert.equal(seeded[index].body, DEFAULT_STARTER_COMMANDS[index].body)
    assert.equal(seeded[index].category, DEFAULT_STARTER_COMMANDS[index].category)
    assert.equal(seeded[index].pinned, Boolean(DEFAULT_STARTER_COMMANDS[index].pinned))
    assert.equal(seeded[index].useCount, 0)
    assert.equal(seeded[index].lastUsedAt, null)
    assert.equal(typeof seeded[index].id, 'string')
    assert.ok(seeded[index].id.length > 0)
  }

  const persisted = JSON.parse(storage.getItem(QUICK_COMMANDS_STORAGE_KEY))
  assert.equal(persisted.version, 1)
  assert.equal(persisted.items.length, DEFAULT_STARTER_COMMANDS.length)

  saveQuickCommands(storage, [])
  assert.deepEqual(JSON.parse(storage.getItem(QUICK_COMMANDS_STORAGE_KEY)), {
    version: 1,
    items: [],
  })
  assert.deepEqual(loadQuickCommands(storage), [])
})

test('corrupt quick-command JSON recovers to an empty list without throwing, reseeding, or wiping raw value', () => {
  const { QUICK_COMMANDS_STORAGE_KEY } = loadTsModule(resolve(rootDir, 'src/quick-commands-contract.ts'))
  const { loadQuickCommands } = loadQuickCommandsModule()
  const storage = memoryStorage({
    [QUICK_COMMANDS_STORAGE_KEY]: '{not json',
  })

  const recovered = loadQuickCommands(storage)
  assert.deepEqual(recovered, [])
  assert.equal(storage.getItem(QUICK_COMMANDS_STORAGE_KEY), '{not json')

  for (const invalidPayload of ['null', '[]', '{"version":1,"items":"bad"}']) {
    const badStorage = memoryStorage({ [QUICK_COMMANDS_STORAGE_KEY]: invalidPayload })
    assert.deepEqual(loadQuickCommands(badStorage), [])
    assert.equal(badStorage.getItem(QUICK_COMMANDS_STORAGE_KEY), invalidPayload)
  }
})

test('loadQuickCommands deduplicates ids and sanitizes negative or NaN useCount', () => {
  const { QUICK_COMMANDS_STORAGE_KEY } = loadTsModule(resolve(rootDir, 'src/quick-commands-contract.ts'))
  const { loadQuickCommands } = loadQuickCommandsModule()
  const storage = memoryStorage({
    [QUICK_COMMANDS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      items: [
        { id: 'dup', title: 'First', body: 'body 1', useCount: -5 },
        { id: 'dup', title: 'Second', body: 'body 2', useCount: 9 },
        { id: 'nan-row', title: 'Third', body: 'body 3', useCount: 'NaN' },
      ],
    }),
  })
  const items = loadQuickCommands(storage)
  assert.deepEqual(items.map((x) => [x.id, x.title, x.useCount]), [
    ['dup', 'First', 0],
    ['nan-row', 'Third', 0],
  ])
})

test('saveQuickCommands returns false on storage QuotaExceededError and recordCommandUsageInStorage preserves concurrent edits', () => {
  const { QUICK_COMMANDS_STORAGE_KEY } = loadTsModule(resolve(rootDir, 'src/quick-commands-contract.ts'))
  const {
    createQuickCommand,
    loadQuickCommands,
    recordCommandUsageInStorage,
    saveQuickCommands,
  } = loadQuickCommandsModule()

  const failingStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  assert.equal(saveQuickCommands(failingStorage, []), false)

  const storage = memoryStorage()
  const initial = loadQuickCommands(storage)
  assert.equal(saveQuickCommands(storage, initial), true)
  const sentId = initial[0].id

  // Simulate another mount adding a new command while sendAgentCommand is in flight
  const added = createQuickCommand(initial, { title: 'Added while sending', body: 'fresh body', category: 'dev' }, {
    now: () => '2026-11-23T12:00:00.000Z',
    createId: () => 'qc-mount-2',
  })
  assert.equal(added.ok, true)
  saveQuickCommands(storage, added.items)

  // Mount 1 finishes send and records usage directly against latest storage
  const afterSend = recordCommandUsageInStorage(storage, sentId, { now: () => '2026-11-23T12:05:00.000Z' })
  assert.equal(afterSend.saved, true)
  assert.ok(afterSend.items.some((x) => x.id === 'qc-mount-2'), 'Mount 2 command must survive Mount 1 send completion')
  assert.equal(afterSend.items.find((x) => x.id === sentId)?.useCount, 1)
  assert.equal(JSON.parse(storage.getItem(QUICK_COMMANDS_STORAGE_KEY)).items.length, initial.length + 1)
})

test('stored commands with an unknown category fall back to other', () => {
  const { QUICK_COMMANDS_STORAGE_KEY } = loadTsModule(resolve(rootDir, 'src/quick-commands-contract.ts'))
  const { loadQuickCommands } = loadQuickCommandsModule()
  const storage = memoryStorage({
    [QUICK_COMMANDS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      items: [
        {
          id: 'qc-kept',
          title: '  Kept title  ',
          body: '  Kept body  ',
          category: 'nope',
          pinned: 1,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
          lastUsedAt: '',
          useCount: 2,
        },
      ],
    }),
  })

  const [item] = loadQuickCommands(storage)
  assert.equal(item.id, 'qc-kept')
  assert.equal(item.title, 'Kept title')
  assert.equal(item.body, 'Kept body')
  assert.equal(item.category, 'other')
  assert.equal(item.pinned, false)
  assert.equal(item.lastUsedAt, null)
  assert.equal(item.useCount, 2)
})

test('createQuickCommand rejects blank title or body and trims accepted input', () => {
  const { createQuickCommand } = loadQuickCommandsModule()
  const now = '2026-11-23T01:02:03.000Z'
  const clock = { now: () => now, createId: () => 'qc-1' }

  const blankTitle = createQuickCommand([], { title: '   ', body: 'body' }, clock)
  assert.equal(blankTitle.ok, false)
  assert.equal(blankTitle.reason, 'blank_title')

  const blankBody = createQuickCommand([], { title: 'Title', body: ' \n ' }, clock)
  assert.equal(blankBody.ok, false)
  assert.equal(blankBody.reason, 'blank_body')

  const created = createQuickCommand([], {
    title: '  Hello  ',
    body: '  World  ',
    category: 'dev',
    pinned: true,
  }, clock)
  assert.equal(created.ok, true)
  assert.equal(created.item.id, 'qc-1')
  assert.equal(created.item.title, 'Hello')
  assert.equal(created.item.body, 'World')
  assert.equal(created.item.category, 'dev')
  assert.equal(created.item.pinned, true)
  assert.equal(created.item.createdAt, now)
  assert.equal(created.item.updatedAt, now)
  assert.equal(created.item.useCount, 0)
  assert.equal(created.item.lastUsedAt, null)
  assert.deepEqual(created.items.map((item) => item.id), ['qc-1'])
})

test('update, pin, usage, and delete touch only the target command', () => {
  const {
    createQuickCommand,
    updateQuickCommand,
    togglePinQuickCommand,
    recordCommandUsage,
    deleteQuickCommand,
  } = loadQuickCommandsModule()
  const createdAt = '2026-11-23T00:00:00.000Z'
  const first = createQuickCommand([], { title: 'A', body: 'alpha' }, {
    now: () => createdAt,
    createId: () => 'qc-a',
  })
  const both = createQuickCommand(first.items, { title: 'B', body: 'beta', pinned: true }, {
    now: () => '2026-11-23T01:00:00.000Z',
    createId: () => 'qc-b',
  })

  const blankTitle = updateQuickCommand(both.items, 'qc-a', { title: '   ' }, {
    now: () => '2026-11-23T02:00:00.000Z',
  })
  assert.equal(blankTitle.ok, false)
  assert.equal(blankTitle.reason, 'blank_title')

  const blankBody = updateQuickCommand(both.items, 'qc-a', { body: '  ' }, {
    now: () => '2026-11-23T02:00:00.000Z',
  })
  assert.equal(blankBody.ok, false)
  assert.equal(blankBody.reason, 'blank_body')

  const missing = updateQuickCommand(both.items, 'missing', { title: 'Nope' }, {
    now: () => '2026-11-23T02:00:00.000Z',
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not_found')

  const updated = updateQuickCommand(both.items, 'qc-a', {
    title: '  A2  ',
    body: ' alpha2 ',
    category: 'review',
  }, { now: () => '2026-11-23T02:00:00.000Z' })
  assert.equal(updated.ok, true)
  assert.equal(updated.item.title, 'A2')
  assert.equal(updated.item.body, 'alpha2')
  assert.equal(updated.item.category, 'review')
  assert.equal(updated.item.createdAt, createdAt)
  assert.equal(updated.item.updatedAt, '2026-11-23T02:00:00.000Z')
  assert.equal(updated.item.useCount, 0)
  assert.equal(updated.items.find((item) => item.id === 'qc-b').title, 'B')
  assert.equal(updated.items.find((item) => item.id === 'qc-b').updatedAt, '2026-11-23T01:00:00.000Z')

  const pinned = togglePinQuickCommand(updated.items, 'qc-a', { now: () => '2026-11-23T03:00:00.000Z' })
  assert.equal(pinned.find((item) => item.id === 'qc-a').pinned, true)
  assert.equal(pinned.find((item) => item.id === 'qc-a').updatedAt, '2026-11-23T03:00:00.000Z')
  assert.equal(pinned.find((item) => item.id === 'qc-b').pinned, true)

  const unpinned = togglePinQuickCommand(pinned, 'qc-b', { now: () => '2026-11-23T04:00:00.000Z' })
  assert.equal(unpinned.find((item) => item.id === 'qc-b').pinned, false)
  assert.equal(unpinned.find((item) => item.id === 'qc-a').pinned, true)

  const used = recordCommandUsage(unpinned, 'qc-b', { now: () => '2026-11-23T05:00:00.000Z' })
  const usedB = used.find((item) => item.id === 'qc-b')
  assert.equal(usedB.useCount, 1)
  assert.equal(usedB.lastUsedAt, '2026-11-23T05:00:00.000Z')
  assert.equal(usedB.updatedAt, '2026-11-23T04:00:00.000Z')
  assert.equal(used.find((item) => item.id === 'qc-a').useCount, 0)
  assert.equal(used.find((item) => item.id === 'qc-a').lastUsedAt, null)

  const usedAgain = recordCommandUsage(used, 'qc-b', { now: () => '2026-11-23T06:00:00.000Z' })
  assert.equal(usedAgain.find((item) => item.id === 'qc-b').useCount, 2)
  assert.equal(usedAgain.find((item) => item.id === 'qc-b').lastUsedAt, '2026-11-23T06:00:00.000Z')

  const deleted = deleteQuickCommand(usedAgain, 'qc-a')
  assert.deepEqual(deleted.map((item) => item.id), ['qc-b'])
  assert.equal(deleteQuickCommand(deleted, 'missing').length, 1)
})

function sampleCommands() {
  return [
    {
      id: 'old-pin',
      title: 'Pinned old',
      body: 'alpha',
      category: 'dev',
      pinned: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastUsedAt: null,
      useCount: 0,
    },
    {
      id: 'new-pin',
      title: 'Pinned new',
      body: 'beta',
      category: 'review',
      pinned: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-06-01T00:00:00.000Z',
      useCount: 3,
    },
    {
      id: 'recent',
      title: 'Recent',
      body: 'ALPHA search',
      category: 'dev',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastUsedAt: null,
      useCount: 0,
    },
    {
      id: 'stale',
      title: 'Stale',
      body: 'gamma',
      category: 'content',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      lastUsedAt: '2026-02-01T00:00:00.000Z',
      useCount: 1,
    },
  ]
}

test('filterAndSortQuickCommands pins first, then most recently used or updated', () => {
  const { filterAndSortQuickCommands } = loadQuickCommandsModule()
  const items = sampleCommands()

  assert.deepEqual(
    filterAndSortQuickCommands(items, {}).map((item) => item.id),
    ['new-pin', 'old-pin', 'recent', 'stale'],
  )
  assert.deepEqual(
    filterAndSortQuickCommands(items, { category: 'dev' }).map((item) => item.id),
    ['old-pin', 'recent'],
  )
  assert.deepEqual(
    filterAndSortQuickCommands(items, { query: '  AlPhA  ' }).map((item) => item.id),
    ['old-pin', 'recent'],
  )
  assert.deepEqual(
    filterAndSortQuickCommands(items, { category: 'all', query: 'search' }).map((item) => item.id),
    ['recent'],
  )
  assert.deepEqual(
    filterAndSortQuickCommands(items, { category: 'dev', query: 'search' }).map((item) => item.id),
    ['recent'],
  )
  assert.deepEqual(filterAndSortQuickCommands(items, { category: 'triage' }), [])

  // Editing an older-used command (updatedAt > lastUsedAt) must bubble it ahead of less recent items
  const editedLater = [
    {
      ...items[2], // recent: updatedAt 2026-08-01, lastUsedAt null
      id: 'used-earlier-then-edited-later',
      pinned: false,
      lastUsedAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      ...items[2],
      id: 'used-middle',
      pinned: false,
      lastUsedAt: '2026-08-15T00:00:00+08:00', // 2026-08-14T16:00:00Z
      updatedAt: '2026-08-15T00:00:00+08:00',
    },
    {
      ...items[2],
      id: 'used-middle-utc-newer',
      pinned: false,
      lastUsedAt: '2026-08-14T20:00:00.000Z', // 4h newer than +08:00 above despite lexicographically smaller prefix
      updatedAt: '2026-08-14T20:00:00.000Z',
    },
  ]
  assert.deepEqual(
    filterAndSortQuickCommands(editedLater, {}).map((item) => item.id),
    ['used-earlier-then-edited-later', 'used-middle-utc-newer', 'used-middle'],
  )

  // Equal pinned + equal timestamp preserves original order
  const tied = [
    { ...items[0], id: 'tie-1', updatedAt: '2026-05-01T00:00:00.000Z', lastUsedAt: null },
    { ...items[0], id: 'tie-2', updatedAt: '2026-05-01T00:00:00.000Z', lastUsedAt: null },
  ]
  assert.deepEqual(filterAndSortQuickCommands(tied, {}).map((item) => item.id), ['tie-1', 'tie-2'])
})

test('resolveCommandSendState requires a non-blank active project id and falls back to id for blank name', () => {
  const { resolveCommandSendState } = loadQuickCommandsModule()
  assert.deepEqual(resolveCommandSendState(null), { canSend: false, reason: 'no_active_project' })
  assert.deepEqual(resolveCommandSendState(undefined), { canSend: false, reason: 'no_active_project' })
  assert.deepEqual(resolveCommandSendState({ id: '   ', name: 'X' }), {
    canSend: false,
    reason: 'no_active_project',
  })
  assert.deepEqual(resolveCommandSendState({ id: ' p1 ', name: '  AgentOS  ' }), {
    canSend: true,
    projectId: 'p1',
    projectName: 'AgentOS',
  })
  assert.deepEqual(resolveCommandSendState({ id: ' p2 ', name: '   ' }), {
    canSend: true,
    projectId: 'p2',
    projectName: 'p2',
  })
})

test('copyQuickCommandText prefers the clipboard and falls back when it rejects', async () => {
  const { copyQuickCommandText } = loadQuickCommandsModule()
  assert.deepEqual(await copyQuickCommandText('   '), { ok: false, reason: 'empty' })

  const writes = []
  assert.deepEqual(
    await copyQuickCommandText(' prompt ', { writeText: async (value) => { writes.push(value) } }),
    { ok: true, via: 'clipboard' },
  )
  assert.deepEqual(writes, [' prompt '])

  let fallback = ''
  assert.deepEqual(
    await copyQuickCommandText('prompt', {
      writeText: async () => { throw new Error('denied') },
      fallbackWrite: (value) => {
        fallback = value
        return true
      },
    }),
    { ok: true, via: 'fallback' },
  )
  assert.equal(fallback, 'prompt')

  assert.deepEqual(
    await copyQuickCommandText('prompt', {
      writeText: async () => { throw new Error('denied') },
      fallbackWrite: () => false,
    }),
    { ok: false, reason: 'copy_failed' },
  )
})

test('quick-commands is the third pinned desk module and a normalized view id', () => {
  const { PINNED_MODULES, resolvePinnedModuleByViewId } = loadTsModule(
    resolve(rootDir, 'src/components/pinned-modules.ts'),
  )
  const { normalizeViewId, VIEW_HEADING_KEYS } = loadTsModule(
    resolve(rootDir, 'src/components/app-shell-constants.ts'),
  )

  assert.equal(PINNED_MODULES[0].id, 'journal')
  assert.equal(PINNED_MODULES[1].id, 'intent-todo')
  assert.deepEqual(PINNED_MODULES[2], {
    id: 'quick-commands',
    labelKey: 'sidebar.pinnedQuickCommands',
    icon: 'code',
    hash: '#quick-commands',
  })
  assert.equal(resolvePinnedModuleByViewId('quick-commands')?.hash, '#quick-commands')
  assert.equal(normalizeViewId('quick-commands'), 'quick-commands')
  assert.equal(normalizeViewId('quick-commands/draft'), 'quick-commands')
  assert.equal(normalizeViewId('journal'), 'journal')
  assert.equal(normalizeViewId('intent-todo'), 'intent-todo')
  assert.equal(VIEW_HEADING_KEYS['quick-commands'], 'shell.viewQuickCommands')
})

test('quick command locale keys referenced by the page exist in both catalogs', () => {
  const page = readFileSync(resolve(rootDir, 'src/components/quick-commands/QuickCommandsPage.tsx'), 'utf8')
  const en = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/zh.json'), 'utf8'))
  const lookup = (catalog, path) => {
    let cursor = catalog
    for (const part of path.split('.')) {
      if (!cursor || typeof cursor !== 'object') return undefined
      cursor = cursor[part]
    }
    return cursor
  }
  const keys = [...page.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((match) => match[1])
  assert.ok(keys.includes('shell.viewQuickCommands'))
  assert.ok(keys.includes('sidebar.pinnedQuickCommands'))
  assert.ok(keys.includes('quickCommands.sentTo'))
  assert.ok(keys.includes('quickCommands.sendNeedsProject'))
  const missing = keys.filter((key) => typeof lookup(en, key) !== 'string' || typeof lookup(zh, key) !== 'string')
  assert.deepEqual(missing, [])
  const placeholders = (str) => [...str.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1]).sort()
  for (const key of keys) {
    assert.deepEqual(
      placeholders(lookup(en, key)),
      placeholders(lookup(zh, key)),
      `placeholder mismatch for ${key}`,
    )
  }
})

test('quick commands stylesheet stays on qc- classes and is imported by the page', () => {
  const page = readFileSync(resolve(rootDir, 'src/components/quick-commands/QuickCommandsPage.tsx'), 'utf8')
  const css = readFileSync(resolve(rootDir, 'src/styles/quick-commands-page.css'), 'utf8')
  const styleEntry = readFileSync(resolve(rootDir, 'src/style.css'), 'utf8')
  assert.match(page, /import '\.\.\/\.\.\/styles\/quick-commands-page\.css'/)
  assert.doesNotMatch(styleEntry, /quick-commands-page\.css/)
  assert.match(css, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(css, /max-width:\s*860px/)
  assert.match(css, /align-items:\s*start/)
  assert.doesNotMatch(css, /(^|[\s,{])\.(desk-surface|btn|icon-xs|app-nav-item)\b/)
})

test('AppShellWorkspace lazy-renders quick commands as a desk view', () => {
  const source = readFileSync(resolve(rootDir, 'src/components/AppShellWorkspace.tsx'), 'utf8')
  assert.match(source, /const QuickCommandsPage = lazy\(/)
  assert.match(source, /quick-commands\/QuickCommandsPage/)
  assert.match(
    source,
    /const isDeskView = activeViewId === 'journal' \|\| activeViewId === 'intent-todo' \|\| activeViewId === 'quick-commands'/,
  )
  assert.match(source, /activeViewId === 'quick-commands'/)
  assert.match(source, /<QuickCommandsPage/)
})

test('quick command target options, header persistence, and priority resolution work end-to-end', () => {
  const {
    buildQuickCommandTargetOptions,
    createQuickCommand,
    loadQuickCommands,
    loadQuickCommandsHeaderTarget,
    parseQuickCommandTargetKey,
    resolveEffectiveQuickCommandTarget,
    saveQuickCommands,
    saveQuickCommandsHeaderTarget,
    serializeQuickCommandTargetKey,
    updateQuickCommand,
  } = loadQuickCommandsModule()

  const projects = [
    { id: 'p_desk', name: 'SentinelDesk', path: '/Users/demo/VibeCoding/SentinelDesk/' },
    { id: 'p_macosui', name: 'macosui', path: '/Users/demo/macosui' },
    { id: 'p_agentos', name: 'AgentOS', path: '/Users/demo/AgentOS' },
    { id: 'p_gone', name: 'GoneRepo', path: '/Users/demo/gone', pathMissing: true },
  ]

  const options = buildQuickCommandTargetOptions(projects, {
    deskRoot: '/Users/demo/VibeCoding/SentinelDesk',
    deskLabel: 'SentinelDesk（工作台）',
  })
  assert.deepEqual(
    options.map((o) => [o.key, o.label]),
    [
      ['desk', 'SentinelDesk（工作台）'],
      ['project:p_macosui', 'macosui'],
      ['project:p_agentos', 'AgentOS'],
    ],
  )

  // Command defaultTarget > headerTarget > activeProject > desk
  const resolvedCommandDesk = resolveEffectiveQuickCommandTarget({
    itemTarget: { kind: 'desk' },
    headerTarget: { kind: 'project', projectId: 'p_macosui' },
    activeProject: projects[1],
    projects,
    deskRoot: '/Users/demo/VibeCoding/SentinelDesk',
  })
  assert.equal(resolvedCommandDesk.source, 'command')
  assert.deepEqual(resolvedCommandDesk.target, { kind: 'desk' })

  const resolvedHeader = resolveEffectiveQuickCommandTarget({
    itemTarget: null,
    headerTarget: { kind: 'project', projectId: 'p_agentos' },
    activeProject: projects[1],
    projects,
    deskRoot: '/Users/demo/VibeCoding/SentinelDesk',
  })
  assert.equal(resolvedHeader.source, 'header')
  assert.deepEqual(resolvedHeader.target, { kind: 'project', projectId: 'p_agentos' })

  // Stale/missing project defaultTarget falls back to headerTarget
  const resolvedStaleFallback = resolveEffectiveQuickCommandTarget({
    itemTarget: { kind: 'project', projectId: 'p_gone' },
    headerTarget: { kind: 'project', projectId: 'p_agentos' },
    activeProject: projects[1],
    projects,
    deskRoot: '/Users/demo/VibeCoding/SentinelDesk',
  })
  assert.equal(resolvedStaleFallback.source, 'header')
  assert.deepEqual(resolvedStaleFallback.target, { kind: 'project', projectId: 'p_agentos' })

  // Header target storage roundtrip
  const storage = memoryStorage()
  assert.equal(loadQuickCommandsHeaderTarget(storage), null)
  assert.equal(saveQuickCommandsHeaderTarget(storage, { kind: 'project', projectId: 'p_agentos' }), true)
  assert.deepEqual(loadQuickCommandsHeaderTarget(storage), { kind: 'project', projectId: 'p_agentos' })
  assert.equal(serializeQuickCommandTargetKey({ kind: 'desk' }), 'desk')
  assert.deepEqual(parseQuickCommandTargetKey('project:p_agentos'), { kind: 'project', projectId: 'p_agentos' })

  // Item defaultTarget persists on create and can be cleared on update
  const created = createQuickCommand([], {
    title: 'Triage',
    body: 'run triage',
    defaultTarget: { kind: 'desk' },
  }, { now: () => '2026-11-23T00:00:00.000Z', createId: () => 'qc-t1' })
  assert.equal(created.ok, true)
  assert.deepEqual(created.item.defaultTarget, { kind: 'desk' })
  saveQuickCommands(storage, created.items)
  assert.deepEqual(loadQuickCommands(storage)[0].defaultTarget, { kind: 'desk' })

  const cleared = updateQuickCommand(created.items, 'qc-t1', { defaultTarget: null }, {
    now: () => '2026-11-23T01:00:00.000Z',
  })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.item.defaultTarget, undefined)
})
