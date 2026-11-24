import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createFakeIpcMain, loadTsModule, repoRoot } from './helpers/load-ts.mjs'

function fakeWindow(destroyed = false) {
  const sent = []
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  }
}

function createElectronWorld() {
  const app = new EventEmitter()
  app.getPath = (name) => (name === 'userData' ? '/Users/me/Library/Application Support/AgentOS' : `/unexpected/${name}`)
  const powerMonitor = new EventEmitter()
  const windows = [fakeWindow(), fakeWindow(true), fakeWindow()]
  let online = true
  const electron = {
    app,
    powerMonitor,
    ipcMain: createFakeIpcMain(),
    net: { isOnline: () => online },
    BrowserWindow: { getAllWindows: () => windows },
  }
  return {
    electron,
    windows,
    setOnline: (value) => {
      online = value
    },
  }
}

function loadAdapter(electron) {
  return loadTsModule('sentinel-desk/adapters/agentos/main-host.ts', { electron })
}

test('createAgentOSMainHost maps AgentOS internals onto the desk host port', () => {
  const world = createElectronWorld()
  const { createAgentOSMainHost } = loadAdapter(world.electron)
  const settingsStore = { id: 'claude-settings' }
  const broker = { id: 'broker' }
  let mainWindow = fakeWindow()
  let workspaceStore = {
    current: () => null,
    read: () => ({ projects: [{ id: 'persisted' }] }),
  }
  let brokerEnabled = true

  const host = createAgentOSMainHost({
    getMainWindow: () => mainWindow,
    getSettingsStore: () => settingsStore,
    getWorkspaceStore: () => workspaceStore,
    getBroker: () => (brokerEnabled ? broker : null),
  })

  assert.equal(host.paths.userData, '/Users/me/Library/Application Support/AgentOS')
  assert.equal(host.ipcMain, world.electron.ipcMain)
  assert.equal(host.settings.get(), settingsStore)
  assert.equal(host.agent.getBroker(), broker)
  brokerEnabled = false
  assert.equal(host.agent.getBroker(), null)

  assert.deepEqual(host.workspace.getState(), { projects: [{ id: 'persisted' }] }, 'falls back to persisted state')
  workspaceStore = { current: () => ({ projects: [{ id: 'live' }] }), read: () => ({ projects: [] }) }
  assert.deepEqual(host.workspace.getState(), { projects: [{ id: 'live' }] }, 'prefers unsaved in-memory state')
  assert.deepEqual(host.workspace.readSnapshot(), { projects: [] }, 'snapshot always reads persisted state')
  workspaceStore = null
  assert.equal(host.workspace.getState(), null)
  assert.equal(host.workspace.readSnapshot(), null)

  assert.equal(host.net.isOnline(), true)
  world.setOnline(false)
  assert.equal(host.net.isOnline(), false)

  host.events.sendToMainWindow('desk:x', { n: 1 })
  assert.deepEqual(mainWindow.sent, [['desk:x', { n: 1 }]])
  mainWindow = fakeWindow(true)
  host.events.sendToMainWindow('desk:x', { n: 2 })
  assert.deepEqual(mainWindow.sent, [], 'destroyed main window is skipped')
  mainWindow = null
  assert.doesNotThrow(() => host.events.sendToMainWindow('desk:x', { n: 3 }))

  host.events.broadcast('desk:y', { n: 4 })
  assert.deepEqual(world.windows.map((w) => w.sent), [[['desk:y', { n: 4 }]], [], [['desk:y', { n: 4 }]]])
})

test('lifecycle hooks subscribe to powerMonitor resume / app focus and unsubscribe cleanly', () => {
  const world = createElectronWorld()
  const { createAgentOSMainHost } = loadAdapter(world.electron)
  const host = createAgentOSMainHost({
    getMainWindow: () => null,
    getSettingsStore: () => ({}),
    getWorkspaceStore: () => null,
    getBroker: () => null,
  })
  const hits = []
  const offResume = host.lifecycle.onSystemResume(() => hits.push('resume'))
  const offFocus = host.lifecycle.onWindowFocus(() => hits.push('focus'))

  world.electron.powerMonitor.emit('resume')
  world.electron.app.emit('browser-window-focus')
  assert.deepEqual(hits, ['resume', 'focus'])

  offResume()
  offFocus()
  world.electron.powerMonitor.emit('resume')
  world.electron.app.emit('browser-window-focus')
  assert.deepEqual(hits, ['resume', 'focus'])
  assert.equal(world.electron.powerMonitor.listenerCount('resume'), 0)
  assert.equal(world.electron.app.listenerCount('browser-window-focus'), 0)
})

test('mountAgentOSDesk composes the adapter with mountDesk', () => {
  const world = createElectronWorld()
  const { mountAgentOSDesk } = loadAdapter(world.electron)
  const handle = mountAgentOSDesk({
    getMainWindow: () => null,
    getSettingsStore: () => ({}),
    getWorkspaceStore: () => null,
    getBroker: () => null,
  })
  for (const method of ['start', 'observeProjectChatEvent', 'dispose']) {
    assert.equal(typeof handle[method], 'function', `handle.${method}`)
  }
  assert.ok(world.electron.ipcMain.handlers.size >= 13, 'desk IPC lands on the electron ipcMain')
})

test('electron/main.ts keeps only the single desk mount seam (P1 budget)', () => {
  const main = readFileSync(resolve(repoRoot, 'electron/main.ts'), 'utf8')
  const deskImports = [...main.matchAll(/from '((?:\.\/desk\/|\.\.\/sentinel-desk\/)[^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    deskImports.sort(),
    ['../sentinel-desk/adapters/agentos/main-host', './desk/main-window-bounds'],
    'main.ts may import desk code only through the AgentOS adapter (window bounds is a C-class fork patch)',
  )
  assert.doesNotMatch(main, /\b(JournalStore|IntentTodoService|LanguagePushService|MorningBriefService|OutboundService|JournalAutoTagService|FeishuJournalBridgeService)\b/)
  assert.doesNotMatch(main, /DESKTOP_(?:INVOKE|EVENT)_CHANNELS\.(?:\w*Journal\w*|\w*IntentTodo\w*|\w*LanguagePush\w*|\w*MorningBrief\w*|\w*Outbound\w*|\w*Feishu\w*)/)
  assert.doesNotMatch(main, /\bpowerMonitor\b/, 'desk lifecycle hooks live in the adapter')
  assert.match(main, /mountAgentOSDesk\(\{/)
  assert.match(main, /deskMain\?\.observeProjectChatEvent\(event\)/)
  assert.match(
    main,
    /deskMain = mountAgentOSDesk\(\{[\s\S]{0,400}?\}\)\s*\n\s*createWindow\(\)\s*\n\s*deskMain\.start\(\)\s*\n\s*initializeAgentOSExternalTasks\(\)/,
    'IPC is registered before the window exists; desk schedulers (Feishu first) start before external tasks, as before',
  )

  const quitStart = main.indexOf('async function prepareForAppQuit')
  const quit = main.slice(quitStart, main.indexOf('\n  return localAppQuitCleanup\n}', quitStart))
  const raceAt = quit.indexOf('await Promise.race(')
  const disposeAt = quit.indexOf('deskMain?.dispose()')
  assert.ok(raceAt > 0 && disposeAt > 0, 'prepareForAppQuit awaits the runtime shutdown race and disposes the desk')
  assert.ok(disposeAt > raceAt, 'desk services (e.g. an in-flight Feishu message) outlive the runtime shutdown wait')
})
