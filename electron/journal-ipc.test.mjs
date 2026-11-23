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

function loadTsModule(modulePath, mocks = {}, cache = new Map()) {
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
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
      return mocks[specifier]
    }
    if (specifier.startsWith('.')) {
      const candidateTs = resolve(dirname(resolvedPath), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`)
      if (existsSync(candidateTs)) return loadTsModule(candidateTs, mocks, cache)
      const candidate = resolve(dirname(resolvedPath), specifier)
      if (existsSync(candidate)) return loadTsModule(candidate, mocks, cache)
    }
    return require(specifier)
  }
  Function('exports', 'module', 'require', outputText)(module.exports, module, localRequire)
  return module.exports
}

function createFakeIpcMain() {
  const handlers = new Map()
  const removed = []
  return {
    handlers,
    removed,
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    removeHandler(channel) {
      removed.push(channel)
      handlers.delete(channel)
    },
  }
}

test('registerJournalIpc: supports lazy store getter, coerces runtime args, and cleans up all 12 channels', async () => {
  const syncCalls = []
  const { DESKTOP_INVOKE_CHANNELS } = loadTsModule(resolve(rootDir, 'src/desktop-seam.ts'))
  const { registerJournalIpc } = loadTsModule(resolve(rootDir, 'electron/desk/journal-ipc.ts'), {
    './legacy-sync': {
      syncLegacySentinelLabJournal: (store, options) => {
        syncCalls.push({ store, options })
        return { synced: 3 }
      },
    },
  })

  const storeCalls = []
  let getterInvocations = 0
  const fakeStore = {
    getConfig: () => ({ deskRoot: '/tmp/desk' }),
    setDeskRoot: (deskRoot) => {
      storeCalls.push(['setDeskRoot', deskRoot])
      return { deskRoot }
    },
    listDays: (month) => {
      storeCalls.push(['listDays', month])
      return []
    },
    getDay: (date) => {
      storeCalls.push(['getDay', date])
      return { date, entries: [] }
    },
    getWeek: (anchorDate) => {
      storeCalls.push(['getWeek', anchorDate])
      return { anchorDate, days: [] }
    },
    createEntry: (input) => {
      storeCalls.push(['createEntry', input])
      return { id: 'je_1' }
    },
    updateEntry: (date, entryId, patch) => {
      storeCalls.push(['updateEntry', date, entryId, patch])
      return { id: entryId }
    },
    deleteEntry: (date, entryId) => {
      storeCalls.push(['deleteEntry', date, entryId])
      return true
    },
    readAttachment: (relativePath) => {
      storeCalls.push(['readAttachment', relativePath])
      return { dataUrl: 'data:image/png;base64,' }
    },
    watch: () => {
      storeCalls.push(['watch'])
      return true
    },
    unwatch: () => {
      storeCalls.push(['unwatch'])
      return true
    },
  }

  const ipcMain = createFakeIpcMain()
  const dispose = registerJournalIpc(ipcMain, () => {
    getterInvocations += 1
    return fakeStore
  })

  assert.equal(getterInvocations, 0, 'lazy store getter must not run at registration time')

  const expectedChannels = [
    DESKTOP_INVOKE_CHANNELS.getJournalConfig,
    DESKTOP_INVOKE_CHANNELS.setJournalDeskRoot,
    DESKTOP_INVOKE_CHANNELS.listJournalDays,
    DESKTOP_INVOKE_CHANNELS.getJournalDay,
    DESKTOP_INVOKE_CHANNELS.getJournalWeek,
    DESKTOP_INVOKE_CHANNELS.createJournalEntry,
    DESKTOP_INVOKE_CHANNELS.updateJournalEntry,
    DESKTOP_INVOKE_CHANNELS.deleteJournalEntry,
    DESKTOP_INVOKE_CHANNELS.readJournalAttachment,
    DESKTOP_INVOKE_CHANNELS.syncLegacySentinelLabJournal,
    DESKTOP_INVOKE_CHANNELS.watchJournal,
    DESKTOP_INVOKE_CHANNELS.unwatchJournal,
  ]
  assert.deepEqual([...ipcMain.handlers.keys()], expectedChannels)

  assert.deepEqual(ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getJournalConfig)({}), { deskRoot: '/tmp/desk' })
  assert.equal(getterInvocations, 1)

  ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.setJournalDeskRoot)({}, 12345)
  ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.listJournalDays)({}, 999)
  ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.listJournalDays)({}, '2026-11')
  ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getJournalDay)({}, 20261123)
  ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.updateJournalEntry)({}, 20261123, 42, { body: 'hi' })
  ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.syncLegacySentinelLabJournal)({}, { dryRun: true })

  assert.deepEqual(storeCalls, [
    ['setDeskRoot', '12345'],
    ['listDays', undefined],
    ['listDays', '2026-11'],
    ['getDay', '20261123'],
    ['updateEntry', '20261123', '42', { body: 'hi' }],
  ])
  assert.equal(syncCalls.length, 1)
  assert.equal(syncCalls[0].store, fakeStore)
  assert.deepEqual(syncCalls[0].options, { dryRun: true })

  dispose()
  assert.equal(ipcMain.handlers.size, 0)
  assert.deepEqual(ipcMain.removed, expectedChannels)
})

test('registerJournalIpc: remains backwards compatible with a direct JournalStore instance', () => {
  const { DESKTOP_INVOKE_CHANNELS } = loadTsModule(resolve(rootDir, 'src/desktop-seam.ts'))
  const { registerJournalIpc } = loadTsModule(resolve(rootDir, 'electron/desk/journal-ipc.ts'), {
    './legacy-sync': { syncLegacySentinelLabJournal: () => ({}) },
  })
  const ipcMain = createFakeIpcMain()
  const dispose = registerJournalIpc(ipcMain, { getConfig: () => ({ ok: true }) })
  assert.deepEqual(ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getJournalConfig)({}), { ok: true })
  dispose()
})

test('electron/main.ts delegates journal IPC to registerJournalIpc instead of duplicating handlers inline', () => {
  const mainSource = readFileSync(resolve(rootDir, 'electron/main.ts'), 'utf8')
  assert.match(mainSource, /import\s+\{\s*registerJournalIpc\s*\}\s+from\s+['"]\.\/desk\/journal-ipc['"]/)
  assert.match(mainSource, /registerJournalIpc\(\s*ipcMain\s*,\s*getJournalStore\s*\)/)
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(\s*DESKTOP_INVOKE_CHANNELS\.getJournalConfig\b/)
})
