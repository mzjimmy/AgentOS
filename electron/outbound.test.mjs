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

test('outbound-service: enforces hard privacy & secret scrubbing, separates Moments from Column Seeds, and writes anti-AI-slop WeChat drafts', async () => {
  const { OutboundService } = loadTsModule(resolve(rootDir, 'electron/desk/outbound-service.ts'))
  const { registerOutboundIpc } = loadTsModule(resolve(rootDir, 'electron/desk/outbound-ipc.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-ob-svc-'))

  try {
    const capturedPrompts = []
    const journalByDate = {
      '2026-11-23': {
        ok: true,
        entries: [
          {
            id: 'je_priv_01',
            createdAt: '2026-11-23T08:00:00+08:00',
            updatedAt: '2026-11-23T08:00:00+08:00',
            body: '#私密 家里门锁密码和私人行程绝对不能外发',
            private: true,
            tags: ['私密'],
          },
          {
            id: 'je_pub_01',
            createdAt: '2026-11-23T10:30:00+08:00',
            updatedAt: '2026-11-23T10:30:00+08:00',
            body: '为了给国外 eSIM 找测试机，拿闲置红米刷谷歌套件被社区 4 级门槛气笑了。另外测试 key sk-proj-1234567890abcdefghijklmnop 别漏。',
            private: false,
            category: '工程',
          },
        ],
      },
    }

    let callIndex = 0
    const fakeLlmCaller = async (_cfg, req) => {
      callIndex += 1
      const userText = req.messages[0].content
      capturedPrompts.push(userText)
      assert.doesNotMatch(userText, /家里门锁密码/)
      assert.doesNotMatch(userText, /sk-proj-1234567890/)

      if (callIndex === 1) {
        return {
          ok: true,
          model: 'claude-sonnet-4-20250514',
          text: JSON.stringify({
            moments: [
              {
                angle: '幕后吐槽',
                body: '本来想拿抽屉里的旧红米插海外 eSIM 当测试机，结果解锁还要社区账号升到 4 级，果断换二手 Pixel 省命。',
                mediaHint: '桌面旧手机与 eSIM 卡合照',
                anchorIds: ['je_pub_01', '716dab9'],
              },
            ],
            seeds: [
              {
                column: '折腾实录',
                title: '为了插一张海外 eSIM，我被国产手机的「社区 4 级」门槛劝退了',
                hook: '明明硬件就在手里，却卡在奇葩的社区等级审核上。',
                storyArc: [
                  '买好读卡器和海外 eSIM 准备复活闲置红米',
                  'GMS 被禁用后连撞实名、内测与社区 4 级三道墙',
                  '及时止损转向原生 GMS 二手机的真实账本',
                ],
                anchorIds: ['je_pub_01'],
              },
            ],
          }),
        }
      }

      return {
        ok: true,
        model: 'claude-sonnet-4-20250514',
        text: JSON.stringify({
          title: '为了插一张海外 eSIM，我被「社区 4 级」门槛整不会了',
          altTitles: ['别拿低端国行机折腾海外 eSIM 了，血泪教训'],
          bodyMarkdown:
            '昨晚吃完饭本来想干件小事，结果硬生生折腾到半夜。\n\n起因特别简单：手里多了张海外 eSIM，想塞进闲置红米里当测试机。\n\n## 第一道墙：消失的谷歌服务\n\n原以为装个 APK 就能赋能形成闭环，结果系统底层直接把套件锁死了。\n\n你们备用测试机现在都选哪款？欢迎评论区聊聊。',
        }),
      }
    }

    const svc = new OutboundService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: (d) => journalByDate[d] || { ok: true, entries: [] },
      },
      settingsStore: {
        resolve: () => ({
          apiKey: 'sk-ant-test',
          authToken: '',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-20250514',
          configSource: 'settings',
        }),
        getSnapshot: () => ({
          settings: { activeProviderId: 'p1', providers: [] },
        }),
      },
      commitCollector: () => [
        {
          repoName: 'AgentOS',
          sha: '716dab9',
          date: '2026-11-23',
          subject: 'feat(desk): add Language Push with MiniMax HD TTS',
        },
      ],
      now: () => new Date('2026-11-23T20:00:00+08:00'),
      llmCaller: fakeLlmCaller,
    })

    const extractRes = await svc.extract({ date: '2026-11-23', force: true })
    assert.equal(extractRes.ok, true)
    assert.equal(extractRes.dayPack.skippedPrivateEntries, 1)
    assert.equal(extractRes.dayPack.moments.length, 1)
    assert.equal(extractRes.dayPack.seeds.length, 1)
    assert.equal(extractRes.dayPack.moments[0].anchors.length, 2)

    const seedId = extractRes.dayPack.seeds[0].id
    const draftRes = await svc.generateDraft({ date: '2026-11-23', seedId })
    assert.equal(draftRes.ok, true)
    assert.doesNotMatch(draftRes.draft.markdown, /赋能|形成闭环/, 'AI buzzwords should be deterministically sanitized')
    assert.ok(existsSync(draftRes.draft.markdownPath))
    const diskMd = readFileSync(draftRes.draft.markdownPath, 'utf8')
    assert.match(diskMd, /privacyChecked: true/)

    const savedEdit = svc.saveDraft({
      draftId: draftRes.draft.id,
      title: '手动微调后的标题',
      markdown: '# 手动微调后的标题\n\n保留真性情的正文。',
    })
    assert.equal(savedEdit.ok, true)
    assert.equal(savedEdit.draft.title, '手动微调后的标题')

    const handlers = new Map()
    const unregister = registerOutboundIpc(
      {
        handle: (ch, fn) => handlers.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      svc,
    )
    assert.equal(handlers.size, 6)
    unregister()
    assert.equal(handlers.size, 0)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('pinned modules, locales, and UI minimalism redlines stay 1:1 consistent for morning-brief and outbound', () => {
  const { PINNED_MODULES } = loadTsModule(resolve(rootDir, 'src/components/pinned-modules.ts'))
  const { normalizeViewId } = loadTsModule(resolve(rootDir, 'src/components/app-shell-constants.ts'))
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(resolve(rootDir, 'src/locales/en.json'), 'utf8'))
  const mbJsx = readFileSync(resolve(rootDir, 'src/components/morning-brief/MorningBriefPage.tsx'), 'utf8')
  const obJsx = readFileSync(resolve(rootDir, 'src/components/outbound/OutboundPage.tsx'), 'utf8')

  const ids = PINNED_MODULES.map((m) => m.id)
  assert.ok(ids.includes('morning-brief'))
  assert.ok(ids.includes('outbound'))
  assert.equal(normalizeViewId('morning-brief'), 'morning-brief')
  assert.equal(normalizeViewId('outbound'), 'outbound')

  assert.deepEqual(Object.keys(zh.morningBrief).sort(), Object.keys(en.morningBrief).sort())
  assert.deepEqual(Object.keys(zh.outbound).sort(), Object.keys(en.outbound).sort())
  assert.ok(zh.outbound.privacyNote.length <= 18, 'privacy note must respect <=18 Chinese chars hard cap')

  // Main reading canvases must not expose raw <select> controls outside settings modal
  const mbMainCanvas = mbJsx.slice(0, mbJsx.indexOf('settingsOpen && draftConfig'))
  const obMainCanvas = obJsx.slice(0, obJsx.indexOf('settingsOpen && draftConfig'))
  assert.doesNotMatch(mbMainCanvas, /<select\b/)
  assert.doesNotMatch(obMainCanvas, /<select\b/)

  // Outbound UI must bind busy states to authoritative Main overview across page switches
  assert.match(obJsx, /overview\?\.runState === 'running'/)
  assert.match(obJsx, /overview\?\.runState === 'drafting'/)
  assert.match(obJsx, /overview\?\.runState === 'error' && overview\.lastError/)
})

test('OutboundService.generateDraft coalesces concurrent calls without duplicate LLM invocations', async () => {
  const { OutboundService } = loadTsModule(resolve(rootDir, 'electron/desk/outbound-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'sentinel-outbound-concurrency-'))
  try {
    let callCount = 0
    let draftLlmCalls = 0
    const svc = new OutboundService({
      journalStore: {
        getConfig: () => ({ deskRoot: tempRoot }),
        getDay: (date) => ({
          ok: true,
          date,
          entries: [
            {
              id: 'je_pub_1',
              date,
              time: '10:00',
              category: '工程',
              body: '落地了边界护栏脚本并收敛了重复 IPC 副本。',
              tags: [],
              projects: ['AgentOS'],
              private: false,
            },
          ],
        }),
      },
      settingsStore: {
        resolve: () => ({ apiKey: 'test-key', authToken: '', baseUrl: 'https://api.example.com', model: 'claude-sonnet', configSource: 'settings' }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [{ id: 'p1', name: 'Test' }] } }),
      },
      commitCollector: () => [],
      llmCaller: async () => {
        callCount += 1
        if (callCount === 1) {
          return {
            ok: true,
            model: 'claude-sonnet',
            text: JSON.stringify({
              moments: [],
              seeds: [
                {
                  title: '边界护栏实践',
                  hook: '为什么写护栏',
                  storyArc: ['背景', '方案', '复盘'],
                  anchorIds: ['je_pub_1'],
                },
              ],
            }),
          }
        }
        draftLlmCalls += 1
        await new Promise((r) => setTimeout(r, 30))
        return {
          ok: true,
          model: 'claude-sonnet',
          text: JSON.stringify({
            title: '并发防重入测试文章',
            altTitles: ['备选标题'],
            bodyMarkdown: '并发防重入测试正文。\n\n保留真性情的第二段。',
          }),
        }
      },
    })

    const extracted = await svc.extract({ date: '2026-11-24', force: true })
    assert.equal(extracted.ok, true)
    const seedId = extracted.dayPack.seeds[0].id

    const [r1, r2] = await Promise.all([
      svc.generateDraft({ date: '2026-11-24', seedId }),
      svc.generateDraft({ date: '2026-11-24', seedId }),
    ])
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(draftLlmCalls, 1)
    assert.equal(svc.getOverview('2026-11-24').runState, 'idle')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
