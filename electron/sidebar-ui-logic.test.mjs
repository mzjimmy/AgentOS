import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const testDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(testDir, '..')

const read = (relPath) => readFileSync(resolve(rootDir, relPath), 'utf8')

function loadIconsModule() {
  const modulePath = resolve(rootDir, 'src/icons.ts')
  const source = readFileSync(modulePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: modulePath,
  })
  const module = { exports: {} }
  Function('exports', 'module', 'require', outputText)(module.exports, module, require)
  return module.exports.Icons
}

test('icons catalog provides crisp 1.8px monochrome linear SVGs without emoji', () => {
  const icons = loadIconsModule()
  for (const name of ['folderOpen', 'compose', 'brandMark', 'monitor', 'archive']) {
    const svg = icons[name]
    assert.equal(typeof svg, 'string', `missing Icons.${name}`)
    assert.match(svg, /^<svg\b[^>]*stroke="currentColor"[^>]*stroke-width="1\.8"/)
    assert.doesNotMatch(svg, /\p{Extended_Pictographic}/u)
  }
})

test('chrome toolbar widens to 144px, places search button at far right, and stays clickable above journal topbar', () => {
  const tokens = read('src/theme/tokens.css')
  const baseCss = read('src/styles/base.css')
  const appShellCss = read('src/styles/app-shell.css')
  assert.match(tokens, /--width-chrome-toolbar:\s*144px;/)
  assert.match(baseCss, /--z-layer-chrome:\s*60;/)
  assert.match(appShellCss, /\.app-chrome-toolbar,\s*\.app-chrome-toolbar\.draggable\s*\{[^}]*-webkit-app-region:\s*no-drag;/s)
  assert.match(appShellCss, /\.app-sidebar,\s*\.app-sidebar\.draggable\s*\{[^}]*-webkit-app-region:\s*no-drag;/s)
  assert.match(appShellCss, /\.app-sidebar-top-drag\s*\{[^}]*-webkit-app-region:\s*drag;/s)
  assert.match(appShellCss, /\.app-chrome-toolbar button > span\s*\{[^}]*pointer-events:\s*none;/s)

  const sidebar = read('src/components/AppShellSidebar.tsx')
  assert.ok(
    sidebar.indexOf('</aside>') < sidebar.indexOf('<div className="app-chrome-toolbar draggable"'),
    'expected .app-chrome-toolbar after </aside> so macOS drag regions never cover toolbar buttons',
  )
  const toolbarMatch = sidebar.match(/<div className="app-chrome-toolbar draggable"[\s\S]*?<\/div>/)
  assert.ok(toolbarMatch, 'expected .app-chrome-toolbar.draggable block')
  const toolbar = toolbarMatch[0]
  assert.match(toolbar, /id="btn-forward"[\s\S]*id="btn-sidebar-search"/)
  assert.match(toolbar, /className="btn btn-toolbar"\s+id="btn-sidebar-search"/)
  assert.match(toolbar, /id="btn-sidebar-search"[\s\S]*<IconInline name="search" \/>/)
  assert.match(toolbar, /id="btn-sidebar-search"[\s\S]*onClick=\{onOpenSearch\}/)
})

test('sidebar renders SentinelDesk brand slot, pinned SVG nav, and removes clutter sections', () => {
  const sidebar = read('src/components/AppShellSidebar.tsx')
  const brandIndex = sidebar.indexOf('className="app-sidebar-brand"')
  const pinnedIndex = sidebar.indexOf('PINNED_MODULES.map')
  assert.ok(brandIndex >= 0, 'expected .app-sidebar-brand header')
  assert.ok(pinnedIndex > brandIndex, 'expected PINNED_MODULES nav directly below brand header')
  assert.match(sidebar, /className="app-sidebar-brand"[\s\S]*<IconInline name="brandMark"/)
  assert.match(sidebar, /className="app-sidebar-brand"[\s\S]*t\('sidebar\.brandName'\)/)

  assert.doesNotMatch(sidebar, /runtime-tabs-section/)
  assert.doesNotMatch(sidebar, /id="btn-sidebar-new-thread"/)
  assert.doesNotMatch(sidebar, /className="app-sidebar-search"/)
  assert.doesNotMatch(sidebar, /\p{Extended_Pictographic}/u)
})

test('project rows toggle collapse on click, show hover actions, and use icon-led context menu', () => {
  const sidebar = read('src/components/AppShellSidebar.tsx')
  const css = read('src/styles/app-shell.css')

  assert.match(css, /\.app-project-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto;/s)
  assert.match(css, /\.app-project-actions\b/)
  assert.match(css, /\.app-project-action-btn\b/)
  assert.match(css, /\.app-sidebar-brand\b/)
  assert.match(css, /\.app-sidebar-context-menu__separator\b/)
  assert.match(css, /\.app-project-row:hover\s+\.app-project-actions/)
  assert.match(css, /\.app-project-row:focus-within\s+\.app-project-actions/)
  assert.match(css, /\.app-project-row\.is-menu-open\s+\.app-project-actions/)

  assert.doesNotMatch(sidebar, /app-project-toggle/)
  assert.match(sidebar, /className="app-project-select"[\s\S]*?onToggleSidebarProjectCollapsed\(project\.id\)/)
  assert.match(sidebar, /<IconInline name=\{projectExpanded \? 'folderOpen' : 'folder'\} \/>/)
  assert.match(
    sidebar,
    /className="app-project-actions"[\s\S]*?<IconInline name="moreHorizontal" \/>[\s\S]*?onNewProjectThread\(project\.id\)[\s\S]*?<IconInline name="compose" \/>/,
  )

  assert.match(sidebar, /type ContextMenuItem = \{[\s\S]*?icon\?: IconName/)
  assert.match(sidebar, /item\.icon \? \(\s*<IconInline name=\{item\.icon\}/)

  const menuStart = sidebar.indexOf('const openProjectMenu =')
  const menuEnd = sidebar.indexOf('const openSkillMenu =', menuStart)
  assert.ok(menuStart >= 0 && menuEnd > menuStart)
  const menuBlock = sidebar.slice(menuStart, menuEnd)
  assert.match(menuBlock, /id: 'open-project-runtime'[\s\S]*?t\('sidebar\.menuOpenGraphicalUi'\)[\s\S]*?icon: 'monitor'[\s\S]*?onOpenProjectRuntime\(project\.id\)/)
  assert.match(menuBlock, /id: 'pin-project'[\s\S]*?icon: 'pin'/)
  assert.match(menuBlock, /id: 'reveal'[\s\S]*?icon: 'folder'[\s\S]*?separatorBefore: true/)
  assert.match(menuBlock, /id: 'relocate-project'[\s\S]*?icon: 'settings'/)
  assert.match(menuBlock, /id: 'remove-project'[\s\S]*?icon: 'x'[\s\S]*?danger: true[\s\S]*?separatorBefore: true/)
})

test('AppShell wires project thread/runtime callbacks and lazily restores only active workspace tab', () => {
  const appShell = read('src/components/AppShell.tsx')

  assert.match(appShell, /const startNewProjectChat = useCallback/)
  assert.match(appShell, /const openProjectRuntime = useCallback/)
  assert.match(appShell, /onNewProjectThread=\{startNewProjectChat\}/)
  assert.match(appShell, /onOpenProjectRuntime=\{openProjectRuntime\}/)

  const restoreIdx = appShell.indexOf('restoredLocalAppsRef.current.has')
  assert.ok(restoreIdx >= 0)
  const restoreBlock = appShell.slice(Math.max(0, restoreIdx - 320), restoreIdx + 500)
  assert.match(restoreBlock, /activeWorkspaceTabId/)
  assert.doesNotMatch(restoreBlock, /warm the rest sequentially|pending\.sort/)
})

test('zh and en locale catalogs define new sidebar keys with 1:1 parity', () => {
  const zh = JSON.parse(read('src/locales/zh.json'))
  const en = JSON.parse(read('src/locales/en.json'))

  for (const key of ['brandName', 'menuOpenGraphicalUi', 'projectMoreActions', 'newProjectThread']) {
    assert.equal(typeof zh.sidebar[key], 'string', `zh sidebar.${key}`)
    assert.equal(typeof en.sidebar[key], 'string', `en sidebar.${key}`)
    assert.ok(zh.sidebar[key].length > 0)
    assert.ok(en.sidebar[key].length > 0)
  }
  assert.equal(zh.sidebar.brandName, 'SentinelDesk')
  assert.equal(en.sidebar.brandName, 'SentinelDesk')
})
