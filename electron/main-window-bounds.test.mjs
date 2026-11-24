import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const testDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(testDir, '..')

function loadTsModule(modulePath) {
  const resolvedPath = resolve(modulePath)
  const source = readFileSync(resolvedPath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: resolvedPath,
  })
  const mod = { exports: {} }
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)
  fn(mod.exports, require, mod, resolvedPath, dirname(resolvedPath))
  return mod.exports
}

const {
  attachMainWindowBoundsPersistence,
  DEFAULT_MAIN_WINDOW_HEIGHT,
  DEFAULT_MAIN_WINDOW_WIDTH,
  MAIN_WINDOW_BOUNDS_FILE,
  MainWindowBoundsStore,
  resolveInitialMainWindowBounds,
} = loadTsModule(resolve(rootDir, 'electron/desk/main-window-bounds.ts'))

test('MainWindowBoundsStore round-trips valid bounds and ignores corrupt or undersized files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-win-bounds-'))
  try {
    const store = new MainWindowBoundsStore(dir)
    assert.equal(store.read(), null)

    const saved = store.save({ x: 180, y: 90, width: 1680, height: 1020 })
    assert.deepEqual(saved, { x: 180, y: 90, width: 1680, height: 1020 })
    assert.deepEqual(store.read(), { x: 180, y: 90, width: 1680, height: 1020 })

    // Corrupt JSON recovers safely to null
    writeFileSync(join(dir, MAIN_WINDOW_BOUNDS_FILE), '{not-valid-json', 'utf8')
    assert.equal(store.read(), null)

    // Undersized bounds are rejected
    assert.equal(store.save({ width: 320, height: 240 }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveInitialMainWindowBounds restores on-screen bounds, falls back safely when monitor disconnected, and clamps to display', () => {
  const primary = { workArea: { x: 0, y: 25, width: 3440, height: 1415 } }
  const secondary = { workArea: { x: 3440, y: 0, width: 1920, height: 1080 } }

  // First launch defaults to 1280x820 (wide enough for multi-column SentinelDesk layouts)
  const fresh = resolveInitialMainWindowBounds(null, [primary], primary)
  assert.deepEqual(fresh, {
    width: DEFAULT_MAIN_WINDOW_WIDTH,
    height: DEFAULT_MAIN_WINDOW_HEIGHT,
    isMaximized: false,
  })

  // Saved ultrawide bounds stay exact
  const restored = resolveInitialMainWindowBounds(
    { x: 240, y: 80, width: 1920, height: 1120 },
    [primary, secondary],
    primary,
  )
  assert.deepEqual(restored, { x: 240, y: 80, width: 1920, height: 1120, isMaximized: false })

  // Disconnected secondary monitor -> preserves size (clamped to primary) and omits off-screen x/y so OS centers
  const smallLaptop = { workArea: { x: 0, y: 25, width: 1440, height: 875 } }
  const detached = resolveInitialMainWindowBounds(
    { x: 3600, y: 120, width: 1800, height: 1000, isMaximized: true },
    [smallLaptop],
    smallLaptop,
  )
  assert.deepEqual(detached, {
    width: 1440,
    height: 875,
    isMaximized: true,
  })
})

test('attachMainWindowBoundsPersistence persists resize/move/maximize and preserves normal bounds when maximized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-win-track-'))
  try {
    const store = new MainWindowBoundsStore(dir)
    const listeners = new Map()
    let currentBounds = { x: 200, y: 100, width: 1560, height: 960 }
    let normalBounds = { ...currentBounds }
    let maximized = false
    let minimized = false
    let maximizeCalls = 0

    const fakeWin = {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      isMaximized: () => maximized,
      isFullScreen: () => false,
      getBounds: () => ({ ...currentBounds }),
      getNormalBounds: () => ({ ...normalBounds }),
      maximize: () => {
        maximizeCalls += 1
        maximized = true
      },
      on: (event, fn) => {
        const arr = listeners.get(event) ?? []
        arr.push(fn)
        listeners.set(event, arr)
      },
    }
    const emit = (event) => {
      for (const fn of listeners.get(event) ?? []) fn()
    }

    const initial = { x: 200, y: 100, width: 1560, height: 960, isMaximized: false }
    const tracker = attachMainWindowBoundsPersistence(fakeWin, store, initial, 10)
    assert.equal(maximizeCalls, 0)

    // User widens window and closes -> flushes immediately
    currentBounds = { x: 140, y: 60, width: 1840, height: 1080 }
    normalBounds = { ...currentBounds }
    emit('close')
    assert.deepEqual(store.read(), { x: 140, y: 60, width: 1840, height: 1080 })

    // User maximizes -> keeps normalBounds and marks isMaximized: true
    maximized = true
    currentBounds = { x: 0, y: 25, width: 3440, height: 1415 }
    tracker.flushNow()
    assert.deepEqual(store.read(), { x: 140, y: 60, width: 1840, height: 1080, isMaximized: true })

    // Minimized window must not overwrite saved bounds
    minimized = true
    currentBounds = { x: -32000, y: -32000, width: 160, height: 28 }
    tracker.flushNow()
    assert.deepEqual(store.read(), { x: 140, y: 60, width: 1840, height: 1080, isMaximized: true })

    tracker.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
