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

test('S1 desk-audio-bar-contract: formats clocks & speeds without 1.x bug, cycles off-grid rates, clamps progress', () => {
  const {
    DESK_AUDIO_SPEED_STEPS,
    formatDeskAudioClock,
    formatDeskAudioSpeed,
    cycleDeskAudioSpeed,
    computeDeskAudioProgressPct,
  } = loadTsModule(resolve(rootDir, 'src/components/desk/desk-audio-bar-contract.ts'))

  assert.deepEqual([...DESK_AUDIO_SPEED_STEPS], [0.85, 1.0, 1.25, 1.5, 1.75, 2.0])

  // Speed formatting — MUST NEVER produce "1.x" or "2.x"
  assert.equal(formatDeskAudioSpeed(1), '1.0x')
  assert.equal(formatDeskAudioSpeed(1.0), '1.0x')
  assert.equal(formatDeskAudioSpeed(2), '2.0x')
  assert.equal(formatDeskAudioSpeed(1.5), '1.5x')
  assert.equal(formatDeskAudioSpeed(0.85), '0.85x')
  assert.equal(formatDeskAudioSpeed(1.25), '1.25x')
  assert.equal(formatDeskAudioSpeed(0.95), '0.95x')
  assert.equal(formatDeskAudioSpeed(1.75), '1.75x')
  assert.equal(formatDeskAudioSpeed(NaN), '1.0x')
  assert.equal(formatDeskAudioSpeed(0), '1.0x')
  assert.equal(formatDeskAudioSpeed(-1), '1.0x')

  // Clock formatting
  assert.equal(formatDeskAudioClock(0), '00:00')
  assert.equal(formatDeskAudioClock(5), '00:05')
  assert.equal(formatDeskAudioClock(65), '01:05')
  assert.equal(formatDeskAudioClock(59.9), '00:59')
  assert.equal(formatDeskAudioClock(3661), '61:01')
  assert.equal(formatDeskAudioClock(-12), '00:00')
  assert.equal(formatDeskAudioClock(NaN), '00:00')
  assert.equal(formatDeskAudioClock(Infinity), '00:00')

  // Speed cycling — on-grid & off-grid rates
  assert.equal(cycleDeskAudioSpeed(0.85), 1.0)
  assert.equal(cycleDeskAudioSpeed(1.0), 1.25)
  assert.equal(cycleDeskAudioSpeed(1.75), 2.0)
  assert.equal(cycleDeskAudioSpeed(2.0), 0.85)
  assert.equal(cycleDeskAudioSpeed(0.95), 1.0)
  assert.equal(cycleDeskAudioSpeed(1.1), 1.25)
  assert.equal(cycleDeskAudioSpeed(0.5), 0.85)
  assert.equal(cycleDeskAudioSpeed(2.5), 0.85)
  assert.equal(cycleDeskAudioSpeed(NaN), 1.0)

  // Progress percentage clamping
  assert.equal(computeDeskAudioProgressPct(0, 0), 0)
  assert.equal(computeDeskAudioProgressPct(0, -3), 0)
  assert.equal(computeDeskAudioProgressPct(0, 4), 25)
  assert.equal(computeDeskAudioProgressPct(1, 4), 50)
  assert.equal(computeDeskAudioProgressPct(3, 4), 100)
  assert.equal(computeDeskAudioProgressPct(9, 4), 100)
  assert.equal(computeDeskAudioProgressPct(-1, 4), 0)
  assert.equal(computeDeskAudioProgressPct(NaN, 4), 0)
})

test('S2 desk-audio-bar-contract: Schmitt-trigger sticky hysteresis eliminates half-covered boundary flicker', () => {
  const {
    DESK_AUDIO_STICKY_ENTER_PX,
    DESK_AUDIO_STICKY_EXIT_PX,
    computeDeskAudioStickyVisible,
  } = loadTsModule(resolve(rootDir, 'src/components/desk/desk-audio-bar-contract.ts'))

  assert.equal(DESK_AUDIO_STICKY_ENTER_PX, 0)
  assert.equal(DESK_AUDIO_STICKY_EXIT_PX, 28)

  // Inactive or missing geometry -> always false
  assert.equal(
    computeDeskAudioStickyVisible({ prevVisible: true, active: false, anchorBottomOffsetPx: -50 }),
    false,
  )
  assert.equal(
    computeDeskAudioStickyVisible({ prevVisible: true, active: true, anchorBottomOffsetPx: null }),
    false,
  )
  assert.equal(
    computeDeskAudioStickyVisible({ prevVisible: true, active: true, anchorBottomOffsetPx: NaN }),
    false,
  )

  // Scrolling down while hidden: half-covered bar (bottom > 0) must stay false
  let visible = false
  for (const offset of [60, 28, 20, 10, 1, 0.1]) {
    visible = computeDeskAudioStickyVisible({
      prevVisible: visible,
      active: true,
      anchorBottomOffsetPx: offset,
    })
    assert.equal(visible, false, `must stay false while hidden at anchorBottom=${offset}`)
  }

  // Crosses <= 0 -> enters true
  visible = computeDeskAudioStickyVisible({ prevVisible: visible, active: true, anchorBottomOffsetPx: 0 })
  assert.equal(visible, true, 'must enter sticky at anchorBottom === 0')
  visible = computeDeskAudioStickyVisible({ prevVisible: visible, active: true, anchorBottomOffsetPx: -40 })
  assert.equal(visible, true)

  // Scrolling back up inside deadband (0, 28) -> MUST hold true (zero oscillation/flicker)
  for (const offset of [0, 1, 5, 15, 27, 27.9]) {
    visible = computeDeskAudioStickyVisible({
      prevVisible: visible,
      active: true,
      anchorBottomOffsetPx: offset,
    })
    assert.equal(visible, true, `must hold true inside deadband at anchorBottom=${offset}`)
  }

  // Reaches >= 28 -> exits cleanly to false
  visible = computeDeskAudioStickyVisible({ prevVisible: visible, active: true, anchorBottomOffsetPx: 28 })
  assert.equal(visible, false, 'must exit sticky at anchorBottom === 28')

  // Immediately dropping back to 27 while hidden stays false (deadband holds previous false too)
  visible = computeDeskAudioStickyVisible({ prevVisible: visible, active: true, anchorBottomOffsetPx: 27 })
  assert.equal(visible, false, 'must hold false inside deadband after exiting')
})

test('S3 desk-audio-bar-contract: DeskAudioSessionBus enforces single-active exclusivity and survives re-entrant release', () => {
  const { DeskAudioSessionBus } = loadTsModule(
    resolve(rootDir, 'src/components/desk/desk-audio-bar-contract.ts'),
  )

  const bus = new DeskAudioSessionBus()
  assert.equal(bus.getSnapshot(), null)

  let notifications = 0
  const unsub = bus.subscribe(() => {
    notifications += 1
  })

  const events = []
  bus.claim({
    sourceId: 'morning-brief',
    viewId: 'morning-brief',
    title: '每日AI早报 · 11月25日',
    subtitle: '00:00 · 1/5',
    currentIndex: 0,
    total: 5,
    elapsedSec: 0,
    playbackRate: 1.0,
    isPlaying: true,
    isBusy: false,
    onStop: () => {
      events.push('stop:morning-brief')
      // Re-entrant release inside onStop MUST NOT wipe the newly claimed session!
      bus.release('morning-brief')
    },
  })

  assert.equal(bus.getSnapshot()?.sourceId, 'morning-brief')
  assert.equal(notifications, 1)

  // Non-owner update is ignored
  bus.update('language-push', { elapsedSec: 99 })
  assert.equal(bus.getSnapshot()?.elapsedSec, 0)
  assert.equal(notifications, 1)

  // Owner update applies & notifies
  bus.update('morning-brief', { elapsedSec: 12, currentIndex: 1 })
  assert.equal(bus.getSnapshot()?.elapsedSec, 12)
  assert.equal(bus.getSnapshot()?.currentIndex, 1)
  assert.equal(notifications, 2)

  // Claiming same sourceId updates without triggering old onStop
  bus.claim({
    sourceId: 'morning-brief',
    viewId: 'morning-brief',
    title: '每日AI早报 · 11月25日',
    subtitle: '00:12 · 2/5',
    currentIndex: 1,
    total: 5,
    elapsedSec: 12,
    playbackRate: 1.25,
    isPlaying: true,
    isBusy: false,
    onStop: () => {
      events.push('stop:morning-brief-2')
      bus.release('morning-brief')
    },
  })
  assert.deepEqual(events, [])
  assert.equal(bus.getSnapshot()?.playbackRate, 1.25)

  // Claiming a different source calls previous onStop and survives re-entrant release
  bus.claim({
    sourceId: 'language-push',
    viewId: 'language-push',
    title: 'resilient',
    subtitle: '00:00 · 1/8',
    currentIndex: 0,
    total: 8,
    elapsedSec: 0,
    playbackRate: 1.0,
    isPlaying: true,
    isBusy: false,
    onStop: () => {
      events.push('stop:language-push')
    },
  })

  assert.deepEqual(events, ['stop:morning-brief-2'])
  assert.equal(bus.getSnapshot()?.sourceId, 'language-push', 're-entrant release must not clobber new owner')
  assert.equal(bus.getSnapshot()?.title, 'resilient')

  // Non-owner release is ignored
  bus.release('morning-brief')
  assert.equal(bus.getSnapshot()?.sourceId, 'language-push')

  // Owner release clears session
  bus.release('language-push')
  assert.equal(bus.getSnapshot(), null)

  // Unsubscribe stops notifications
  const beforeUnsub = notifications
  unsub()
  bus.claim({
    sourceId: 'morning-brief',
    viewId: 'morning-brief',
    title: 'test',
    subtitle: '',
    currentIndex: 0,
    total: 1,
    elapsedSec: 0,
    playbackRate: 1.0,
    isPlaying: true,
    isBusy: false,
    onStop: () => {},
  })
  assert.equal(notifications, beforeUnsub)
})

test('S4 audio stores integration: MorningBriefAudioStore & LanguagePushPlayerController coordinate via DeskAudioSessionBus, track speed & elapsedSec', async () => {
  const cache = new Map()
  const { DeskAudioSessionBus } = loadTsModule(
    resolve(rootDir, 'src/components/desk/desk-audio-bar-contract.ts'),
    cache,
  )
  const { MorningBriefAudioStore } = loadTsModule(
    resolve(rootDir, 'src/components/morning-brief/morning-brief-audio-store.ts'),
    cache,
  )
  const {
    LanguagePushPlayerController,
    LANGUAGE_PUSH_SPEED_STORAGE_KEY,
    languagePushPlayer,
  } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/language-push-player.ts'),
    cache,
  )

  assert.ok(languagePushPlayer instanceof LanguagePushPlayerController, 'must export singleton languagePushPlayer')
  assert.equal(LANGUAGE_PUSH_SPEED_STORAGE_KEY, 'agentos:language-push:playback-rate:v1')

  const bus = new DeskAudioSessionBus()
  const prevWindow = globalThis.window
  const prevAudio = globalThis.Audio
  const storage = new Map()
  let mbRelease = null

  class GatedAudio {
    constructor(src) {
      this.src = src
      this.playbackRate = 1
      this.onended = null
      this.onerror = null
    }
    pause() {}
    play() {
      return new Promise((r) => {
        mbRelease = () => {
          if (this.src) this.onended?.()
          r()
        }
      })
    }
  }

  globalThis.Audio = GatedAudio
  globalThis.window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => {
        storage.set(k, String(v))
      },
    },
    desktop: {
      speakMorningBrief: async () => ({
        ok: true,
        segments: [
          { sectionIndex: 0, text: '导语', audioBase64: 'AAA', mime: 'audio/mpeg' },
          { sectionIndex: 1, text: '第一条', audioBase64: 'BBB', mime: 'audio/mpeg' },
        ],
      }),
    },
  }

  const makeCard = (id, surface) => ({
    id,
    lang: 'en',
    kind: 'vocab',
    wordKey: id,
    readingKey: '',
    surface,
    reading: '',
    meaning: '含义',
    grammarNote: null,
    levelTag: 'B2',
    example: { sentence: `Example for ${surface}`, translation: '译文', sourceDate: '2026-11-25', sourceEntryId: 'je_1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-25',
    lastSeenDate: '2026-11-25',
    dueAt: '2026-11-25',
    lastShownAt: null,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  })

  try {
    const mbStore = new MorningBriefAudioStore({ sessionBus: bus })

    const lpStorage = new Map()
    const lpSpokenSpeeds = []
    let lpGateResolve = null
    let lpStopped = 0
    const lpController = new LanguagePushPlayerController({
      sessionBus: bus,
      defaultSpeed: 0.95,
      storage: {
        getItem: (k) => (lpStorage.has(k) ? lpStorage.get(k) : null),
        setItem: (k, v) => {
          lpStorage.set(k, String(v))
        },
      },
      speak: async ({ speed, isCancelled }) => {
        lpSpokenSpeeds.push(speed)
        await new Promise((r) => {
          lpGateResolve = r
        })
        return { outcome: isCancelled() ? 'cancelled' : 'ok', provider: 'minimax' }
      },
      sleep: async () => true,
      stopSpeech: () => {
        lpStopped += 1
        lpGateResolve?.()
      },
    })

    // Initial playbackRate reflects defaultSpeed (0.95) and elapsedSec is 0
    assert.equal(lpController.getSnapshot().playbackRate, 0.95)
    assert.equal(lpController.getSnapshot().elapsedSec, 0)

    // Cycling speed persists to storage and moves off-grid 0.95 -> 1.0 -> 1.25
    assert.equal(lpController.cycleSpeed(), 1.0)
    assert.equal(lpStorage.get(LANGUAGE_PUSH_SPEED_STORAGE_KEY), '1')
    assert.equal(lpController.cycleSpeed(), 1.25)
    assert.equal(lpStorage.get(LANGUAGE_PUSH_SPEED_STORAGE_KEY), '1.25')

    // 1) Start Morning Brief -> claims bus
    const mbPromise = mbStore.play({
      date: '2026-11-25',
      headlineDateLabel: '11月25日',
      totalSections: 2,
      startSection: 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(mbStore.getSnapshot().isPlaying, true)
    assert.equal(bus.getSnapshot()?.sourceId, 'morning-brief')
    assert.equal(bus.getSnapshot()?.viewId, 'morning-brief')

    // 2) Start Language Push -> claims bus, automatically stops Morning Brief, speaks at cycled rate 1.25
    const lpPromise = lpController.playQueue([makeCard('c1', 'resilient')], {
      speed: 0.95,
      resolveVoiceId: () => undefined,
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(mbStore.getSnapshot().isPlaying, false, 'claiming bus from Language Push must stop Morning Brief')
    assert.equal(bus.getSnapshot()?.sourceId, 'language-push')
    assert.equal(bus.getSnapshot()?.viewId, 'language-push')
    assert.equal(bus.getSnapshot()?.title, 'resilient')
    assert.equal(bus.getSnapshot()?.playbackRate, 1.25)
    assert.equal(lpSpokenSpeeds[0], 1.25, 'stored/cycled speed must override default cfg speed')

    // Cycling speed mid-playback updates bus and takes effect on next utterance (example sentence)
    assert.equal(lpController.cycleSpeed(), 1.5)
    assert.equal(bus.getSnapshot()?.playbackRate, 1.5)
    lpGateResolve?.()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(lpSpokenSpeeds[1], 1.5, 'next utterance must pick up live cycled speed')

    // 3) Starting Morning Brief again stops active Language Push & takes over bus
    const mbPromise2 = mbStore.play({
      date: '2026-11-25',
      headlineDateLabel: '11月25日',
      totalSections: 2,
      startSection: 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(lpStopped >= 1, 'claiming bus from Morning Brief must stop Language Push')
    assert.equal(lpController.getSnapshot().activeCardId, null)
    assert.equal(bus.getSnapshot()?.sourceId, 'morning-brief')

    // Stop Morning Brief -> bus releases cleanly
    mbStore.stop()
    mbRelease?.()
    await Promise.all([mbPromise, lpPromise, mbPromise2])
    assert.equal(bus.getSnapshot(), null, 'stopping active source must release the bus')
  } finally {
    globalThis.window = prevWindow
    globalThis.Audio = prevAudio
  }
})

test('S5 UI & guardrail contracts: zero-flicker overlay sticky, unified DeskAudioBar, MorningBrief & LanguagePush migrations, zero dead CSS & zero base imports', () => {
  const shellTsx = readFileSync(resolve(rootDir, 'src/components/desk/DeskDatePageShell.tsx'), 'utf8')
  const shellCss = readFileSync(resolve(rootDir, 'src/styles/desk-date-shell.css'), 'utf8')
  const contractTs = readFileSync(resolve(rootDir, 'src/components/desk/desk-audio-bar-contract.ts'), 'utf8')

  const audioBarPath = resolve(rootDir, 'src/components/desk/DeskAudioBar.tsx')
  const audioCssPath = resolve(rootDir, 'src/styles/desk-audio-bar.css')
  assert.equal(existsSync(audioBarPath), true, 'DeskAudioBar.tsx must exist')
  assert.equal(existsSync(audioCssPath), true, 'desk-audio-bar.css must exist')

  const audioBarTsx = readFileSync(audioBarPath, 'utf8')
  const audioCss = readFileSync(audioCssPath, 'utf8')
  const mbTsx = readFileSync(resolve(rootDir, 'src/components/morning-brief/MorningBriefPage.tsx'), 'utf8')
  const mbCss = readFileSync(resolve(rootDir, 'src/styles/morning-brief-page.css'), 'utf8')
  const mbMiniTsx = readFileSync(resolve(rootDir, 'src/components/morning-brief/MorningBriefMiniPlayer.tsx'), 'utf8')
  const lpTsx = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')
  const lpCss = readFileSync(resolve(rootDir, 'src/styles/language-push-page.css'), 'utf8')
  const deskPaths = readFileSync(resolve(rootDir, 'sentinel-desk/scripts/desk-paths.mjs'), 'utf8')
  const allowlist = readFileSync(resolve(rootDir, 'sentinel-desk/boundary-allowlist.json'), 'utf8')

  // 1) DeskDatePageShell zero-layout-shift overlay architecture
  assert.match(shellTsx, /stickyOverlay\?:\s*ReactNode/, 'DeskDatePageShell must expose stickyOverlay prop')
  assert.match(shellTsx, /className="desk-shell-body"/, 'DeskDatePageShell must wrap scroll in .desk-shell-body')
  assert.match(shellCss, /\.desk-shell-body\s*\{[\s\S]*?position:\s*relative;[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/)

  // 2) DeskAudioBar exports, zero base imports, overlay absolute sticky, passive scroll + rAF + ResizeObserver
  assert.match(audioBarTsx, /export function DeskAudioBar\b/)
  assert.match(audioBarTsx, /export function DeskAudioStickyStrip\b/)
  assert.match(audioBarTsx, /export function DeskAudioMiniPlayer\b/)
  assert.match(audioBarTsx, /export function useDeskAudioSticky\b/)
  assert.match(audioBarTsx, /attachDeskAudioStickyObserver/)
  assert.match(audioBarTsx, /requestAnimationFrame/)
  assert.match(audioBarTsx, /ResizeObserver/)
  assert.match(contractTs, /passive:\s*true/)
  assert.match(audioBarTsx, /aria-pressed=\{loop\}/)

  for (const forbidden of ['icon-inline', 'i18n/i18n', 'components/types', '../types']) {
    assert.equal(audioBarTsx.includes(forbidden), false, `DeskAudioBar.tsx must have 0 base imports (found ${forbidden})`)
    assert.equal(contractTs.includes(forbidden), false, `desk-audio-bar-contract.ts must have 0 base imports (found ${forbidden})`)
  }

  assert.match(audioCss, /\.desk-audio-sticky\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*0;/)
  assert.match(audioCss, /\.desk-audio-bar\b/)
  assert.match(audioCss, /\.desk-audio-mini\b/)

  // 3) MorningBriefPage migrated to DeskAudioBar + stickyOverlay; dead CSS & IntersectionObserver removed
  assert.match(mbTsx, /<DeskAudioBar\b/)
  assert.match(mbTsx, /<DeskAudioStickyStrip\b/)
  assert.match(mbTsx, /stickyOverlay=/)
  assert.match(mbTsx, /useDeskAudioSticky/)
  assert.match(mbTsx, /morning-brief-player/)
  assert.match(mbTsx, /morning-brief-sticky-strip/)
  assert.match(mbTsx, /morning-brief-loop-toggle/)
  assert.match(mbTsx, /extraActions/)
  assert.doesNotMatch(mbTsx, /IntersectionObserver/, 'MorningBriefPage must replace IntersectionObserver with useDeskAudioSticky')
  assert.doesNotMatch(mbTsx, /\.replace\(\/0\$\/,\s*''\)/, 'MorningBriefPage must remove buggy 1.x speed formatter')

  for (const dead of ['.mb-inline-player', '.mb-player-play', '.mb-player-controls', '.mb-sticky-strip']) {
    assert.equal(mbCss.includes(dead), false, `dead CSS ${dead} must be deleted from morning-brief-page.css`)
  }

  // 4) MorningBriefMiniPlayer delegates to DeskAudioMiniPlayer; old CSS retired
  assert.match(mbMiniTsx, /DeskAudioMiniPlayer/)
  assert.equal(mbMiniTsx.includes('icon-inline'), false, 'MorningBriefMiniPlayer must drop icon-inline import')
  assert.equal(existsSync(resolve(rootDir, 'src/styles/morning-brief-mini-player.css')), false, 'morning-brief-mini-player.css must be deleted')

  // 5) LanguagePushPage migrated to DeskAudioBar + stickyOverlay + singleton; clean Hero right; dead CSS deleted
  assert.match(lpTsx, /<DeskAudioBar\b/)
  assert.match(lpTsx, /<DeskAudioStickyStrip\b/)
  assert.match(lpTsx, /stickyOverlay=/)
  assert.match(lpTsx, /useDeskAudioSticky/)
  assert.match(lpTsx, /languagePushPlayer/)
  assert.doesNotMatch(lpTsx, /lp-nowplaying/, 'LanguagePushPage must remove legacy .lp-nowplaying strip')
  assert.doesNotMatch(lpTsx, /lp-btn-playing/, 'LanguagePushPage must remove legacy hero play button class')
  assert.doesNotMatch(lpTsx, /lp-loop-btn/, 'LanguagePushPage must remove legacy hero loop button')
  assert.doesNotMatch(lpTsx, /if\s*\(hidden\)\s*cancelPlayback/, 'LanguagePushPage must allow background audio playback across views')
  const lpLoopToggles = lpTsx.match(/toggleLoop/g) ?? []
  assert.equal(lpLoopToggles.length, 1, 'LanguagePushPage must keep single toggleLoop entry point')

  for (const dead of ['.lp-nowplaying', '.lp-btn-playing', '.lp-loop-active', '.lp-eq']) {
    assert.equal(lpCss.includes(dead), false, `dead CSS ${dead} must be deleted from language-push-page.css`)
  }

  // 6) Guardrail registrations
  assert.ok(deskPaths.includes("'src/styles/desk-audio-bar.css'"), 'desk-paths.mjs must register desk-audio-bar.css')
  assert.equal(deskPaths.includes('morning-brief-mini-player.css'), false, 'desk-paths.mjs must remove retired morning-brief-mini-player.css')
  assert.equal(
    allowlist.includes('"from": "src/components/morning-brief/MorningBriefMiniPlayer.tsx",\n      "to": "src/icon-inline.tsx"'),
    false,
    'boundary-allowlist.json must drop stale MorningBriefMiniPlayer -> icon-inline edge',
  )
})

test('R1–R5 adversarial review regressions: LanguageCard EQ, queue scope guard, sticky observer lifecycle, preview speed sync, and rapid speech-helper replacement', async () => {
  const cache = new Map()
  const contract = loadTsModule(
    resolve(rootDir, 'src/components/desk/desk-audio-bar-contract.ts'),
    cache,
  )
  const { LanguagePushPlayerController } = loadTsModule(
    resolve(rootDir, 'src/components/language-push/language-push-player.ts'),
    cache,
  )

  // R1: LanguageCard must use shared .desk-audio-eq, never the deleted .lp-eq class
  const cardTsx = readFileSync(resolve(rootDir, 'src/components/language-push/LanguageCard.tsx'), 'utf8')
  assert.doesNotMatch(cardTsx, /className="lp-eq"/, 'LanguageCard must not reference deleted .lp-eq class')
  assert.match(cardTsx, /className="desk-audio-eq"/, 'LanguageCard must reuse shared .desk-audio-eq')

  // R2: syncQueue with mismatched scopeKey must NOT clobber an active playlist, and LanguagePushPage guards !shown
  const lpPageTsx = readFileSync(resolve(rootDir, 'src/components/language-push/LanguagePushPage.tsx'), 'utf8')
  assert.match(lpPageTsx, /if\s*\(\s*!shown\s*\)\s*return[\s\S]{0,80}syncQueue/, 'LanguagePushPage must skip syncQueue while overview is loading')

  const bus = new contract.DeskAudioSessionBus()
  let gateResolve = null
  const lp = new LanguagePushPlayerController({
    sessionBus: bus,
    speak: async ({ isCancelled }) => {
      await new Promise((r) => {
        gateResolve = r
      })
      return { outcome: isCancelled() ? 'cancelled' : 'ok', provider: 'minimax' }
    },
    sleep: async () => true,
    stopSpeech: () => gateResolve?.(),
  })
  const card = (id, surface) => ({
    id,
    lang: 'en',
    kind: 'vocab',
    wordKey: id,
    readingKey: '',
    surface,
    reading: '',
    meaning: 'm',
    grammarNote: null,
    levelTag: 'B2',
    example: { sentence: '', translation: '', sourceDate: '2026-11-25', sourceEntryId: 'e1' },
    status: 'active',
    familiarity: null,
    exposures: 0,
    seenDays: 1,
    firstSeenDate: '2026-11-25',
    lastSeenDate: '2026-11-25',
    dueAt: '2026-11-25',
    lastShownAt: null,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  })
  const qPromise = lp.playQueue([card('c1', 'alpha'), card('c2', 'beta')], {
    resolveVoiceId: () => undefined,
    queueScopeKey: '2026-11-25:today:all',
  })
  await new Promise((r) => setTimeout(r, 5))
  // Mismatched scope (e.g. another date/tab) must NOT wipe the playing queue
  lp.syncQueue([], '2026-11-24:today:all')
  assert.equal(lp.getSnapshot().total, 2, 'mismatched scopeKey must not clobber active playlist queue')
  lp.stop()
  await qPromise

  // R4: preview() live speed cycling must update the session bus snapshot immediately
  const prevPromise = lp.preview({ text: 'resilience', lang: 'en', speed: 1.0 })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(bus.getSnapshot()?.sourceId, 'language-push')
  const cycled = lp.cycleSpeed()
  assert.equal(bus.getSnapshot()?.playbackRate, cycled, 'cycleSpeed during preview must update bus playbackRate')
  lp.stop()
  await prevPromise

  // R3: attachDeskAudioStickyObserver tracks inner-content ResizeObserver shifts & cleans up listeners/rAF
  assert.equal(typeof contract.attachDeskAudioStickyObserver, 'function', 'must export attachDeskAudioStickyObserver')
  const observedEls = []
  let disconnected = false
  let scrollListener = null
  let scrollRemoved = false
  let pendingRaf = null
  let cancelledRafId = null
  let anchorBottom = 40
  const scrollTop = 0
  const innerEl = { tag: 'inner' }
  const scrollEl = {
    firstElementChild: innerEl,
    getBoundingClientRect: () => ({ top: scrollTop }),
    addEventListener: (ev, fn) => {
      if (ev === 'scroll') scrollListener = fn
    },
    removeEventListener: (ev, fn) => {
      if (ev === 'scroll' && fn === scrollListener) scrollRemoved = true
    },
  }
  const anchorEl = {
    getBoundingClientRect: () => ({ bottom: anchorBottom }),
  }
  let roCallback = null
  class FakeRO {
    constructor(cb) {
      roCallback = cb
    }
    observe(el) {
      observedEls.push(el)
    }
    disconnect() {
      disconnected = true
    }
  }
  const visibleHistory = []
  const detach = contract.attachDeskAudioStickyObserver({
    scrollEl,
    anchorEl,
    ResizeObserverCtor: FakeRO,
    requestAnimationFrameFn: (cb) => {
      pendingRaf = cb
      return 77
    },
    cancelAnimationFrameFn: (id) => {
      cancelledRafId = id
      pendingRaf = null
    },
    onChange: (v) => visibleHistory.push(v),
  })
  assert.ok(observedEls.includes(innerEl), 'ResizeObserver must observe scrollEl.firstElementChild for banner/content shifts')
  assert.deepEqual(visibleHistory, [false])
  // Simulate banner disappearing above bar without scroll event -> anchor shifts above top
  anchorBottom = -4
  roCallback?.()
  pendingRaf?.()
  assert.equal(visibleHistory.at(-1), true, 'content shift moving anchor <= 0 must show sticky strip')
  // Simulate shift into deadband (16px) -> must hold true (zero flicker)
  anchorBottom = 16
  scrollListener?.()
  pendingRaf?.()
  assert.equal(visibleHistory.at(-1), true, 'deadband scroll must hold sticky visible')
  // Schedule another rAF then detach before it fires -> must clean up rAF, listener, observer
  anchorBottom = 32
  scrollListener?.()
  detach()
  assert.equal(scrollRemoved, true, 'detach must remove scroll listener')
  assert.equal(disconnected, true, 'detach must disconnect ResizeObserver')
  assert.equal(cancelledRafId, 77, 'detach must cancel pending rAF')

  // R5: speech-helper rapid replacement must not let old audio rejection clear new activeCancelResolver
  const prevWin = globalThis.window
  const prevAudio = globalThis.Audio
  const prevURL = globalThis.URL
  const prevBlob = globalThis.Blob
  try {
    let rejectFirstPlay = null
    let audioCount = 0
    class MockAudio {
      constructor(url) {
        this.url = url
        this.id = ++audioCount
        this.onended = null
        this.onerror = null
      }
      pause() {}
      play() {
        if (this.id === 1) {
          return new Promise((_, reject) => {
            rejectFirstPlay = reject
          })
        }
        return new Promise(() => {})
      }
    }
    globalThis.Audio = MockAudio
    globalThis.URL = { createObjectURL: () => `blob:mock-${audioCount}`, revokeObjectURL: () => {} }
    globalThis.Blob = class MockBlob {
      constructor(parts, opts) {
        this.parts = parts
        this.type = opts?.type
      }
    }
    globalThis.window = {
      atob: (s) => s,
      desktop: {
        speakLanguagePush: async () => ({ ok: true, audioBase64: 'AA', mime: 'audio/mpeg' }),
      },
    }
    const speech = loadTsModule(resolve(rootDir, 'src/components/language-push/speech-helper.ts'))
    const p1 = speech.playLanguagePushSpeech({ text: 'one', lang: 'en', speed: 1, isCancelled: () => false })
    await new Promise((r) => setTimeout(r, 5))
    const p2 = speech.playLanguagePushSpeech({ text: 'two', lang: 'en', speed: 1, isCancelled: () => false })
    await new Promise((r) => setTimeout(r, 5))
    // Now old audio #1's play() rejects asynchronously AFTER audio #2 installed its cancel resolver
    rejectFirstPlay?.(new Error('interrupted'))
    await new Promise((r) => setTimeout(r, 5))
    // Calling stopAllSpeech MUST still settle p2 as cancelled (not orphaned!)
    speech.stopAllSpeech()
    const [r1, r2] = await Promise.all([
      p1,
      Promise.race([
        p2,
        new Promise((_, reject) => setTimeout(() => reject(new Error('p2 orphaned after rapid replacement')), 80)),
      ]),
    ])
    assert.equal(r1.outcome, 'cancelled')
    assert.equal(r2.outcome, 'cancelled', 'second utterance must settle as cancelled even after first rejects late')
  } finally {
    globalThis.window = prevWin
    globalThis.Audio = prevAudio
    globalThis.URL = prevURL
    globalThis.Blob = prevBlob
  }
})
