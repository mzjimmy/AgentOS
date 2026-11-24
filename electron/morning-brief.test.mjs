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

test('morning-brief-fetcher: parses RSS 2.0 + Atom feeds, strips HTML/CDATA, and deduplicates normalized URLs', () => {
  const { parseXmlFeedItems, deduplicateAndRankCandidates } = loadTsModule(
    resolve(rootDir, 'electron/desk/morning-brief-fetcher.ts'),
  )

  const rssXml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title><![CDATA[Claude Code 2.5 Launches Background Agent Worktrees]]></title>
        <link>https://example.com/claude-code-25?utm_source=rss&amp;ref=hn/</link>
        <description><![CDATA[<p>New autonomous agent sandbox &amp; MCP router.</p>]]></description>
        <pubDate>Mon, 23 Nov 2026 08:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Claude Code 2.5 Launches Background Agent Worktrees</title>
        <link>https://www.example.com/claude-code-25</link>
        <description>Duplicate link with tracking stripped.</description>
      </item>
    </channel></rss>`

  const atomXml = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Simon Willison on LLM CLI Plugins</title>
        <link rel="alternate" href="https://simonwillison.net/2026/Nov/23/llm-cli/"/>
        <summary type="html">&lt;b&gt;Practical&lt;/b&gt; patterns for terminal coding agents.</summary>
        <updated>2026-11-23T10:00:00Z</updated>
      </entry>
    </feed>`

  const rssItems = parseXmlFeedItems(rssXml, { id: 'openai', name: 'OpenAI' })
  const atomItems = parseXmlFeedItems(atomXml, { id: 'simon', name: 'Simon Willison' })

  assert.equal(rssItems.length, 2)
  assert.equal(atomItems.length, 1)
  assert.equal(rssItems[0].summary, 'New autonomous agent sandbox & MCP router.')
  assert.equal(atomItems[0].summary, 'Practical patterns for terminal coding agents.')

  const deduped = deduplicateAndRankCandidates([...rssItems, ...atomItems])
  assert.equal(deduped.length, 2, 'duplicate URL with utm_source and www should collapse to 1')
})

test('morning-brief-service: generates 字节笔记本-style issue, swaps backup stories instantly, and stitches MiniMax Mandarin audio', async () => {
  const { MorningBriefService } = loadTsModule(resolve(rootDir, 'electron/desk/morning-brief-service.ts'))
  const { registerMorningBriefIpc } = loadTsModule(resolve(rootDir, 'electron/desk/morning-brief-ipc.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-mb-svc-'))

  try {
    const fakeFeedFetch = async (url) => {
      if (url.includes('daily_papers')) {
        return new Response(
          JSON.stringify([
            {
              publishedAt: '2026-11-23T06:00:00Z',
              paper: {
                id: '2611.12345',
                title: 'SWE-Bench Verified 92% with Lightweight Agent Harness',
                summary: 'Minimal tool harness beats heavy multi-agent frameworks.',
                upvotes: 85,
              },
            },
            {
              publishedAt: '2026-11-23T05:00:00Z',
              paper: {
                id: '2611.67890',
                title: 'Zero-Latency Local Speech Tokenization for Coding Assistants',
                summary: 'Streaming voice codec for terminal workflows.',
                upvotes: 42,
              },
            },
          ]),
          { status: 200 },
        )
      }
      return new Response(
        `<rss version="2.0"><channel>
          <item>
            <title>Anthropic Releases MCP 2.0 Transport Specification</title>
            <link>https://openai.com/news/mcp-2</link>
            <description>Streamable HTTP and zero-config local discovery.</description>
          </item>
        </channel></rss>`,
        { status: 200 },
      )
    }

    const fakeLlmCaller = async (_cfg, req) => {
      const userMsg = req.messages[0].content
      const ids = [...userMsg.matchAll(/"id":\s*"(mbc_[a-f0-9]+)"/g)].map((m) => m[1])
      assert.ok(ids.length >= 2, 'expected fetched candidate IDs in prompt')

      return {
        ok: true,
        model: 'claude-sonnet-4-20250514',
        text: JSON.stringify({
          leadSummary: 'SWE-Bench 轻量智能体创 92% 新高，MCP 2.0 传输规范正式发布。',
          themes: ['智能体', '协议', '语音'],
          introParagraph:
            '11 月 23 日的 AI 圈，主题是智能体、协议与语音：轻量级 Harness 刷新编程基准，MCP 2.0 敲定流式传输。以下是当天值得知道的 AI 大事，另有语音版可听。',
          selected: [
            {
              candidateId: ids[0],
              title: '轻量级 Agent Harness 刷新 SWE-Bench 至 92%',
              body: '新研究证明极简工具循环在真实代码修复上优于复杂多智能体编排。',
              spokenText: '轻量级智能体架构把代码修复准确率推到了百分之九十二。',
              category: 'Coding Agent',
            },
          ],
          backups: [
            {
              candidateId: ids[1],
              title: '低延迟本地语音分词器面向终端编程开源',
              body: '专为命令行语音交互打造的流式编解码模型正式开源。',
              spokenText: '面向命令行编程的低延迟语音分词模型今天正式开源。',
              category: '开源与工具',
            },
          ],
        }),
      }
    }

    const fakeAudioHex = Buffer.from('ID3-FAKE-MP3-FRAME').toString('hex')
    let ttsCalls = 0
    const fakeTtsFetch = async () => {
      ttsCalls += 1
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: 'success' },
          data: { audio: fakeAudioHex },
        }),
        { status: 200 },
      )
    }

    const svc = new MorningBriefService({
      journalStore: { getConfig: () => ({ deskRoot: tempRoot }) },
      settingsStore: {
        resolve: () => ({
          apiKey: 'sk-ant-test',
          authToken: '',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-20250514',
          configSource: 'settings',
        }),
        getSnapshot: () => ({
          settings: {
            activeProviderId: 'p1',
            providers: [
              {
                id: 'p1',
                name: 'MiniMax',
                apiKey: 'mm-test-key',
                baseUrl: 'https://api.minimaxi.com/anthropic',
                model: 'MiniMax-M2.5',
              },
            ],
          },
        }),
      },
      now: () => new Date('2026-11-23T09:00:00+08:00'),
      feedFetchFn: fakeFeedFetch,
      llmCaller: fakeLlmCaller,
      ttsFetchFn: fakeTtsFetch,
    })

    svc.saveConfig({
      sources: [
        {
          id: 'hf',
          name: 'Hugging Face Papers',
          kind: 'huggingface_papers',
          url: 'https://huggingface.co/api/daily_papers',
          enabled: true,
          builtin: true,
        },
        {
          id: 'oa',
          name: 'OpenAI News',
          kind: 'rss',
          url: 'https://openai.com/news/rss.xml',
          enabled: true,
          builtin: true,
        },
      ],
    })

    const runRes = await svc.runBrief({ date: '2026-11-23', force: true })
    assert.equal(runRes.ok, true)
    assert.equal(runRes.issue.items.length, 1)
    assert.equal(runRes.issue.backupItems.length, 1)
    assert.ok(existsSync(runRes.issue.markdownPath), 'WeChat Markdown archive should be written')
    const mdText = readFileSync(runRes.issue.markdownPath, 'utf8')
    assert.match(mdText, /# 每日AI早报 · 11 月 23 日/)
    assert.match(mdText, /> SWE-Bench 轻量智能体创 92% 新高/)

    // Audio synthesis + MP3 stitching
    const speakRes = await svc.speak({ date: '2026-11-23', stitchFullIssue: true })
    assert.equal(speakRes.ok, true)
    assert.equal(speakRes.segments.length, 2)
    assert.equal(ttsCalls, 2)
    assert.ok(speakRes.stitchedAudioPath && existsSync(speakRes.stitchedAudioPath))

    // Instant swap with backup story
    const originalId = runRes.issue.items[0].id
    const swapRes = svc.swapItem('2026-11-23', originalId)
    assert.equal(swapRes.ok, true)
    assert.notEqual(swapRes.issue.items[0].id, originalId)
    assert.equal(swapRes.issue.backupItems[0].id, originalId)

    // Verify standalone IPC registrar
    const handlers = new Map()
    const unregister = registerMorningBriefIpc(
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

test('morning-brief: exposes authoritative runningDate during background run and UI binds to overview.runState across page switches', async () => {
  const { MorningBriefService } = loadTsModule(resolve(rootDir, 'electron/desk/morning-brief-service.ts'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-mb-bg-'))

  try {
    let releaseLlm
    const llmGate = new Promise((resolvePromise) => {
      releaseLlm = resolvePromise
    })

    const svc = new MorningBriefService({
      journalStore: { getConfig: () => ({ deskRoot: tempRoot }) },
      settingsStore: {
        resolve: () => ({
          apiKey: 'sk-ant-test',
          authToken: '',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-20250514',
          configSource: 'settings',
        }),
        getSnapshot: () => ({ settings: { activeProviderId: 'p1', providers: [] } }),
      },
      now: () => new Date('2026-11-23T09:00:00+08:00'),
      feedFetchFn: async () =>
        new Response(
          `<rss version="2.0"><channel><item><title>AI Agent Launch</title><link>https://example.com/a1</link><description>Test</description></item></channel></rss>`,
          { status: 200 },
        ),
      llmCaller: async (_cfg, req) => {
        await llmGate
        const ids = [...req.messages[0].content.matchAll(/"id":\s*"(mbc_[a-f0-9]+)"/g)].map((m) => m[1])
        return {
          ok: true,
          model: 'claude-sonnet-4-20250514',
          text: JSON.stringify({
            leadSummary: 'AI Agent 正式发布。',
            themes: ['智能体'],
            introParagraph: '今日早报综述。',
            selected: [
              {
                candidateId: ids[0],
                title: 'AI Agent 正式发布',
                body: '背景生成完成。',
                spokenText: '背景生成完成。',
                category: 'Coding Agent',
              },
            ],
            backups: [],
          }),
        }
      },
    })

    const inflight = svc.runBrief({ date: '2026-11-23', force: true })
    await new Promise((r) => setTimeout(r, 20))

    // Simulate switching back to the page while Main is still generating
    const midOverview = svc.getOverview('2026-11-23')
    assert.equal(midOverview.runState, 'running')
    assert.equal(midOverview.runningDate, '2026-11-23')

    releaseLlm()
    const doneRes = await inflight
    assert.equal(doneRes.ok, true)

    const finalOverview = svc.getOverview('2026-11-23')
    assert.equal(finalOverview.runState, 'idle')
    assert.equal(finalOverview.runningDate, null)
    assert.ok(finalOverview.issue)

    const pageSrc = readFileSync(resolve(rootDir, 'src/components/morning-brief/MorningBriefPage.tsx'), 'utf8')
    const storeSrc = readFileSync(
      resolve(rootDir, 'src/components/morning-brief/morning-brief-audio-store.ts'),
      'utf8',
    )
    assert.match(pageSrc, /overview\?\.runState === 'running'/)
    assert.match(pageSrc, /overview\?\.runState === 'error' && overview\.lastError/)
    assert.match(pageSrc, /morningBriefAudioStore/)
    assert.doesNotMatch(pageSrc, /if\s*\(hidden\)\s*stopPlayback/)
    assert.match(storeSrc, /cyclePlaybackRate/)
    assert.match(storeSrc, /audio\.playbackRate = this\.snapshot\.playbackRate/)

    // Verify TTS segments strip "第1条 / 第一条 / 1." numbering prefixes
    const { buildMorningBriefSpeakSegments } = loadTsModule(
      resolve(rootDir, 'electron/desk/morning-brief-tts.ts'),
    )
    const segs = buildMorningBriefSpeakSegments({
      ...finalOverview.issue,
      items: [
        {
          ...finalOverview.issue.items[0],
          spokenText: '第一条，OpenAI 发布新版编程智能体。',
        },
      ],
    })
    assert.equal(segs[1].text, 'OpenAI 发布新版编程智能体。')
    assert.doesNotMatch(segs[1].text, /^第\s*[0-9一二三四五六七八九十]+\s*条/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
