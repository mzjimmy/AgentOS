import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeIpcMain, loadTsModule } from './helpers/load-ts.mjs'

const { DESKTOP_EVENT_CHANNELS, DESKTOP_INVOKE_CHANNELS } = loadTsModule('src/desktop-seam.ts')

const INLINE_CHANNELS = [
  'getFeishuJournalBridgeStatus',
  'saveFeishuJournalBridgeConfig',
  'reconnectFeishuJournalBridge',
  'getJournalAutoTagStatus',
  'runJournalAutoTag',
  'saveJournalAutoTagConfig',
  'getIntentTodoOverview',
  'listIntentTodoCalendar',
  'refreshIntentTodo',
  'decideIntentTodo',
  'dispatchIntentTodo',
  'getIntentTodoConfig',
  'saveIntentTodoConfig',
].map((key) => DESKTOP_INVOKE_CHANNELS[key])

function createWorld() {
  const instances = {}
  const calls = []
  const registrations = []

  function fakeService(name, methods) {
    return class {
      constructor(options) {
        this.options = options
        ;(instances[name] ??= []).push(this)
        for (const method of methods) {
          this[method] = (...args) => {
            calls.push([name, method, ...args])
            return method === 'startIfEnabled' || method === 'runAutoTag' ? Promise.resolve() : { name, method }
          }
        }
      }
    }
  }

  const lifecycle = { resume: [], focus: [], unsubscribed: 0 }
  const sent = []
  const broadcasts = []
  const settingsStore = { id: 'settings-store' }
  const broker = { id: 'broker' }
  let workspaceState = {
    projects: [
      { id: 'p1', name: 'AgentOS', path: '/repo/agentos', extra: 'dropped' },
      { id: 'p2', name: 'Docs', path: '   ' },
    ],
  }
  let snapshotThrows = false
  const ipcMain = createFakeIpcMain()

  const host = {
    paths: { userData: '/tmp/desk-user-data' },
    ipcMain,
    events: {
      sendToMainWindow: (channel, payload) => sent.push([channel, payload]),
      broadcast: (channel, payload) => broadcasts.push([channel, payload]),
    },
    settings: { get: () => settingsStore },
    workspace: {
      getState: () => workspaceState,
      readSnapshot: () => {
        if (snapshotThrows) throw new Error('disk gone')
        return workspaceState
      },
    },
    agent: { getBroker: () => broker },
    net: { isOnline: () => true },
    lifecycle: {
      onSystemResume: (fn) => {
        lifecycle.resume.push(fn)
        return () => {
          lifecycle.unsubscribed += 1
        }
      },
      onWindowFocus: (fn) => {
        lifecycle.focus.push(fn)
        return () => {
          lifecycle.unsubscribed += 1
        }
      },
    },
  }

  const recordRegistration = (name) => (ipc, getter) => {
    registrations.push({ name, ipc, getter })
    return () => undefined
  }

  const mocks = {
    '../../electron/desk/journal-store': { JournalStore: fakeService('JournalStore', ['dispose']) },
    '../../electron/desk/feishu-journal-bridge': {
      FeishuJournalBridgeService: fakeService('Feishu', ['startIfEnabled', 'getStatus', 'updateConfig', 'reconnect', 'dispose']),
    },
    '../../electron/desk/journal-auto-tag-service': {
      JournalAutoTagService: fakeService('AutoTag', ['runAutoTag', 'getStatus', 'saveConfig']),
    },
    '../../electron/desk/intent-todo-service': {
      IntentTodoService: fakeService('IntentTodo', [
        'start',
        'dispose',
        'notifySystemResumeOrFocus',
        'observeProjectChatEvent',
        'getOverview',
        'listCalendarDays',
        'refreshAnalysis',
        'decideItem',
        'dispatchItem',
        'getConfig',
        'saveConfig',
      ]),
    },
    '../../electron/desk/language-push-service': {
      LanguagePushService: fakeService('LanguagePush', ['start', 'dispose', 'notifySystemResumeOrFocus']),
    },
    '../../electron/desk/morning-brief-service': {
      MorningBriefService: fakeService('MorningBrief', ['start', 'dispose', 'notifySystemResumeOrFocus']),
    },
    '../../electron/desk/outbound-service': { OutboundService: fakeService('Outbound', ['dispose']) },
    '../../electron/desk/journal-ipc': { registerJournalIpc: recordRegistration('journal') },
    '../../electron/desk/language-push-ipc': { registerLanguagePushIpc: recordRegistration('languagePush') },
    '../../electron/desk/morning-brief-ipc': { registerMorningBriefIpc: recordRegistration('morningBrief') },
    '../../electron/desk/outbound-ipc': { registerOutboundIpc: recordRegistration('outbound') },
  }

  const { mountDesk } = loadTsModule('sentinel-desk/main/mount.ts', mocks)
  return {
    mountDesk,
    host,
    ipcMain,
    instances,
    calls,
    registrations,
    lifecycle,
    sent,
    broadcasts,
    settingsStore,
    broker,
    setWorkspaceState: (next) => {
      workspaceState = next
    },
    setSnapshotThrows: (value) => {
      snapshotThrows = value
    },
    count: (name) => (instances[name] ?? []).length,
    only: (name) => {
      assert.equal((instances[name] ?? []).length, 1, `${name} constructed exactly once`)
      return instances[name][0]
    },
    callsOf: (name, method) => calls.filter((c) => c[0] === name && c[1] === method).map((c) => c.slice(2)),
  }
}

test('mountDesk registers every desk IPC channel without constructing any service', () => {
  const w = createWorld()
  w.mountDesk(w.host)

  assert.deepEqual(w.instances, {}, 'no desk service may be constructed at mount time')
  assert.deepEqual(
    w.registrations.map((r) => r.name),
    ['journal', 'languagePush', 'morningBrief', 'outbound'],
  )
  for (const registration of w.registrations) {
    assert.equal(registration.ipc, w.ipcMain, `${registration.name} registers on the host ipcMain`)
    assert.equal(typeof registration.getter, 'function', `${registration.name} receives a lazy getter`)
  }
  assert.deepEqual([...w.ipcMain.handlers.keys()].sort(), [...INLINE_CHANNELS].sort())
  assert.deepEqual(w.instances, {}, 'registration alone stays lazy')
})

test('IPC handlers build services on first use with host-provided ports and coerce arguments', async () => {
  const w = createWorld()
  w.mountDesk(w.host)
  const invoke = (key, ...args) => w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS[key])({}, ...args)

  invoke('getIntentTodoOverview', '2026-11-23')
  invoke('getIntentTodoOverview', 42)
  invoke('decideIntentTodo', 7, 'accept', null)
  invoke('saveIntentTodoConfig', undefined)
  invoke('runJournalAutoTag', undefined)
  invoke('saveFeishuJournalBridgeConfig', { appId: 'x' })

  const intentTodo = w.only('IntentTodo')
  assert.equal(intentTodo.options.userDataPath, '/tmp/desk-user-data')
  assert.equal(intentTodo.options.settingsStore, w.settingsStore)
  assert.equal(intentTodo.options.journalStore, w.only('JournalStore'))
  assert.equal(intentTodo.options.getBroker(), w.broker)
  assert.equal(intentTodo.options.isOnline(), true)
  assert.deepEqual(w.callsOf('IntentTodo', 'getOverview'), [['2026-11-23'], [undefined]])
  assert.deepEqual(w.callsOf('IntentTodo', 'decideItem'), [['7', 'accept', undefined]])
  assert.deepEqual(w.callsOf('IntentTodo', 'saveConfig'), [[{}]])
  assert.deepEqual(w.callsOf('AutoTag', 'runAutoTag'), [[{}]])
  assert.deepEqual(w.callsOf('Feishu', 'updateConfig'), [[{ appId: 'x' }]])
  assert.equal(w.count('JournalStore'), 1, 'one shared JournalStore across services')

  const journalGetter = w.registrations.find((r) => r.name === 'journal').getter
  assert.equal(journalGetter(), w.only('JournalStore'))
  assert.equal(w.registrations.find((r) => r.name === 'outbound').getter(), w.only('Outbound'))
})

test('service events reach the renderer through the host event port', () => {
  const w = createWorld()
  w.mountDesk(w.host)
  w.registrations.find((r) => r.name === 'languagePush').getter()
  w.registrations.find((r) => r.name === 'morningBrief').getter()
  w.registrations.find((r) => r.name === 'outbound').getter()
  w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getIntentTodoConfig)({})
  w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getFeishuJournalBridgeStatus)({})
  w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getJournalAutoTagStatus)({})

  w.only('IntentTodo').options.onChanged({ k: 'todo' })
  w.only('LanguagePush').options.onChanged({ k: 'lang' })
  w.only('MorningBrief').options.onChanged({ k: 'brief' })
  w.only('Outbound').options.onChanged({ k: 'out' })
  w.only('AutoTag').options.onChanged({ k: 'tag' })
  w.only('Feishu').options.onStatusChange({ k: 'feishu' })

  assert.deepEqual(w.broadcasts, [
    [DESKTOP_EVENT_CHANNELS.onIntentTodoChanged, { k: 'todo' }],
    [DESKTOP_EVENT_CHANNELS.onLanguagePushChanged, { k: 'lang' }],
    [DESKTOP_EVENT_CHANNELS.onMorningBriefChanged, { k: 'brief' }],
    [DESKTOP_EVENT_CHANNELS.onOutboundChanged, { k: 'out' }],
    [DESKTOP_EVENT_CHANNELS.onJournalAutoTagChanged, { k: 'tag' }],
  ])
  assert.deepEqual(w.sent, [[DESKTOP_EVENT_CHANNELS.onFeishuJournalBridgeStatus, { k: 'feishu' }]])
})

test('workspace adapters: auto-tag sees id/name/path only, outbound skips blank paths and survives read errors', () => {
  const w = createWorld()
  w.mountDesk(w.host)
  w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getJournalAutoTagStatus)({})
  w.registrations.find((r) => r.name === 'outbound').getter()
  const autoTag = w.only('AutoTag')
  const outbound = w.only('Outbound')

  assert.deepEqual(autoTag.options.getWorkspaceState(), {
    projects: [
      { id: 'p1', name: 'AgentOS', path: '/repo/agentos' },
      { id: 'p2', name: 'Docs', path: '   ' },
    ],
  })
  w.setWorkspaceState(null)
  assert.deepEqual(autoTag.options.getWorkspaceState(), { projects: [] })

  w.setWorkspaceState({ projects: [{ path: '/a' }, { path: '' }, { path: undefined }, { path: '/b' }] })
  assert.deepEqual(outbound.options.defaultRepoPaths(), ['/a', '/b'])
  w.setWorkspaceState(null)
  assert.deepEqual(outbound.options.defaultRepoPaths(), [])
  w.setSnapshotThrows(true)
  assert.deepEqual(outbound.options.defaultRepoPaths(), [])
})

test('journal writes are debounced into one auto-tag run per valid date', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = createWorld()
  w.mountDesk(w.host)
  w.registrations.find((r) => r.name === 'journal').getter()
  const onChange = w.only('JournalStore').options.onChange

  onChange({ reason: 'created', dates: ['2026-11-22', 'not-a-date'] })
  t.mock.timers.tick(1_000)
  onChange({ reason: 'updated', dates: ['2026-11-23', '2026-11-22'] })
  onChange({ reason: 'deleted', dates: ['2026-11-20'] })
  t.mock.timers.tick(1_199)
  assert.deepEqual(w.callsOf('AutoTag', 'runAutoTag'), [], 'still inside the debounce window')
  t.mock.timers.tick(1)

  assert.deepEqual(w.callsOf('AutoTag', 'runAutoTag'), [[{ date: '2026-11-22' }], [{ date: '2026-11-23' }]])
  assert.deepEqual(
    w.sent.map(([channel, payload]) => [channel, payload.reason]),
    [
      [DESKTOP_EVENT_CHANNELS.onJournalChanged, 'created'],
      [DESKTOP_EVENT_CHANNELS.onJournalChanged, 'updated'],
      [DESKTOP_EVENT_CHANNELS.onJournalChanged, 'deleted'],
    ],
  )
})

test('start() launches schedulers once, catches up auto-tag after boot, and wires resume/focus', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = createWorld()
  const desk = w.mountDesk(w.host)

  desk.start()
  desk.start()

  assert.equal(w.callsOf('Feishu', 'startIfEnabled').length, 1)
  assert.equal(w.callsOf('IntentTodo', 'start').length, 1)
  assert.equal(w.callsOf('LanguagePush', 'start').length, 1)
  assert.equal(w.callsOf('MorningBrief', 'start').length, 1)
  assert.equal(w.lifecycle.resume.length, 1)
  assert.equal(w.lifecycle.focus.length, 1)

  t.mock.timers.tick(4_999)
  assert.equal(w.callsOf('AutoTag', 'runAutoTag').length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(w.callsOf('AutoTag', 'runAutoTag'), [[]], 'boot catch-up runs with no date')

  w.lifecycle.focus[0]()
  assert.equal(w.callsOf('IntentTodo', 'notifySystemResumeOrFocus').length, 1)
  assert.equal(w.callsOf('LanguagePush', 'notifySystemResumeOrFocus').length, 1)
  assert.equal(w.callsOf('MorningBrief', 'notifySystemResumeOrFocus').length, 1)
  assert.equal(w.callsOf('AutoTag', 'runAutoTag').length, 1, 'focus does not re-run auto-tag')

  w.lifecycle.resume[0]()
  assert.equal(w.callsOf('IntentTodo', 'notifySystemResumeOrFocus').length, 2)
  assert.equal(w.callsOf('LanguagePush', 'notifySystemResumeOrFocus').length, 2)
  assert.equal(w.callsOf('MorningBrief', 'notifySystemResumeOrFocus').length, 2)
  assert.equal(w.callsOf('AutoTag', 'runAutoTag').length, 2, 'resume re-runs auto-tag')

  w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getIntentTodoConfig)({})
  assert.equal(w.only('IntentTodo').options.beforeScheduledAnalysis('2026-11-23') instanceof Promise, true)
  assert.deepEqual(w.callsOf('AutoTag', 'runAutoTag').at(-1), [{ date: '2026-11-23' }])
})

test('observeProjectChatEvent forwards only once Intent Todo exists, without constructing it', () => {
  const w = createWorld()
  const desk = w.mountDesk(w.host)

  desk.observeProjectChatEvent({ type: 'run-finished' })
  assert.equal(w.count('IntentTodo'), 0, 'observing must not instantiate the service')

  w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getIntentTodoConfig)({})
  desk.observeProjectChatEvent({ type: 'run-finished', threadId: 't1' })
  assert.deepEqual(w.callsOf('IntentTodo', 'observeProjectChatEvent'), [[{ type: 'run-finished', threadId: 't1' }]])
})

test('dispose() cancels pending timers, unsubscribes lifecycle, disposes built services, and is idempotent', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = createWorld()
  const desk = w.mountDesk(w.host)
  desk.start()
  w.only('JournalStore').options.onChange({ reason: 'created', dates: ['2026-11-23'] })

  desk.dispose()
  desk.dispose()
  t.mock.timers.tick(10_000)

  assert.equal(w.callsOf('AutoTag', 'runAutoTag').length, 0, 'boot and debounce timers are cancelled')
  assert.equal(w.lifecycle.unsubscribed, 2)
  for (const name of ['JournalStore', 'Feishu', 'IntentTodo', 'LanguagePush', 'MorningBrief']) {
    assert.equal(w.callsOf(name, 'dispose').length, 1, `${name} disposed exactly once`)
  }
  assert.equal(w.count('Outbound'), 0, 'dispose does not construct services that were never used')

  desk.start()
  assert.equal(w.callsOf('IntentTodo', 'start').length, 1, 'start after dispose is a no-op')
})

test('after dispose(), late IPC calls cannot resurrect an undisposed service', () => {
  const w = createWorld()
  const desk = w.mountDesk(w.host)
  desk.dispose()

  assert.throws(() => w.ipcMain.handlers.get(DESKTOP_INVOKE_CHANNELS.getIntentTodoConfig)({}), /disposed/)
  assert.throws(() => w.registrations.find((r) => r.name === 'outbound').getter(), /disposed/)
  assert.throws(() => w.registrations.find((r) => r.name === 'journal').getter(), /disposed/)
  assert.deepEqual(w.instances, {}, 'nothing is constructed after dispose')
})
