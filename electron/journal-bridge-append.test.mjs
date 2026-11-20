import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
const appendScript = resolve(rootDir, 'scripts/sentinel-desk-append.mjs')

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

test('sentinel-desk-append: appends entry via CLI args with atomic write and dedup', async () => {
  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-append-test-'))

  try {
    // 1. Initial append
    const out1 = execFileSync(
      'node',
      [
        appendScript,
        '--source', 'feishu',
        '--text', '来自飞书的第一条同步记录',
        '--external-id', 'feishu:msg_1001',
        '--desk-root', tempDeskRoot,
        '--date', '2026-11-20',
        '--time', '16:20',
        '--category', '工作',
      ],
      { encoding: 'utf8' }
    )

    const json1 = JSON.parse(out1.trim())
    assert.equal(json1.ok, true)
    assert.equal(json1.deduplicated, false)

    const targetFile = join(tempDeskRoot, 'journal', '2026', '11', '2026-11-20.md')
    assert.ok(existsSync(targetFile))

    // 2. Duplicate append with same externalId
    const out2 = execFileSync(
      'node',
      [
        appendScript,
        '--source', 'feishu',
        '--text', '重复内容',
        '--external-id', 'feishu:msg_1001',
        '--desk-root', tempDeskRoot,
        '--date', '2026-11-20',
      ],
      { encoding: 'utf8' }
    )

    const json2 = JSON.parse(out2.trim())
    assert.equal(json2.ok, true)
    assert.equal(json2.deduplicated, true)

    // 3. Verify with JournalStore to guarantee 100% interoperability
    const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
    const store = new JournalStore({ deskRoot: tempDeskRoot })
    const dayRes = await store.getDay('2026-11-20')
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return
    assert.equal(dayRes.entries.length, 1)
    assert.equal(dayRes.entries[0].body, '来自飞书的第一条同步记录')
    assert.equal(dayRes.entries[0].source, 'feishu')
    assert.equal(dayRes.entries[0].category, '工作')
    assert.equal(dayRes.entries[0].externalId, 'feishu:msg_1001')
  } finally {
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})


test('sentinel-desk-append: supports json on stdin and exits non-zero on invalid args', () => {
  const tempDeskRoot = mkdtempSync(join(tmpdir(), 'sentinel-desk-append-stdin-'))

  try {
    const inputPayload = JSON.stringify({
      source: 'feishu',
      text: '通过 stdin 传入的消息',
      externalId: 'feishu:msg_stdin_1',
      deskRoot: tempDeskRoot,
      date: '2026-11-20',
      time: '17:00',
      category: '学习',
      tags: ['stdin-test'],
    })

    const out = execFileSync('node', [appendScript, '--stdin'], {
      input: inputPayload,
      encoding: 'utf8',
    })

    const json = JSON.parse(out.trim())
    assert.equal(json.ok, true)
    assert.equal(json.deduplicated, false)

    // Invalid arguments (no text) must exit non-zero
    assert.throws(() => {
      execFileSync('node', [appendScript, '--source', 'feishu'], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    })
  } finally {
    rmSync(tempDeskRoot, { recursive: true, force: true })
  }
})


test('sentinellab-bridge.sh side-tee dual-writes to SentinelDesk without disturbing primary SentinelLab reply', async (t) => {
  const bridgeScript = '/Users/sentinellab/AgentOS/SentinelLab/scripts/sentinellab-bridge.sh'
  if (!existsSync(bridgeScript)) {
    t.skip('sentinellab-bridge.sh not present on this machine')
    return
  }

  const http = require('node:http')
  const { execFile } = require('node:child_process')
  const { promisify } = require('node:util')
  const execFileAsync = promisify(execFile)

  const tempDir = mkdtempSync(join(tmpdir(), 'sentinel-bridge-dual-test-'))
  const tempDeskRoot = join(tempDir, 'SentinelDesk')
  const tempSpoolDir = join(tempDir, 'spool')
  const receivedBodies = []

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      receivedBodies.push(JSON.parse(raw))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, replyText: '✓ 已记入今日时间日记' }))
    })
  })

  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const { port } = server.address()

  try {
    const env = {
      ...process.env,
      SL_API_URL: `http://127.0.0.1:${port}`,
      SL_BRIDGE_TOKEN: 'test-token-only',
      SL_BRIDGE_SPOOL_DIR: tempSpoolDir,
      SENTINEL_DESK_ROOT: tempDeskRoot,
      SENTINEL_DESK_APPEND_SCRIPT: appendScript,
    }

    // Run 1: must hit primary mock server AND mirror to SentinelDesk with exact --reply-only stdout
    const run1 = await execFileAsync(
      'bash',
      [bridgeScript, 'record', 'feishu', '飞书群双写测试闪念', 'om_dual_test_001', '--reply-only'],
      { env, encoding: 'utf8' }
    )
    assert.equal(run1.stdout.trim(), '✓ 已记入今日时间日记')
    assert.equal(receivedBodies.length, 1)
    assert.equal(receivedBodies[0].text, '飞书群双写测试闪念')

    // Run 2: replay same message id must stay idempotent in SentinelDesk
    const run2 = await execFileAsync(
      'bash',
      [bridgeScript, 'record', 'feishu', '飞书群双写测试闪念', 'om_dual_test_001', '--reply-only'],
      { env, encoding: 'utf8' }
    )
    assert.equal(run2.stdout.trim(), '✓ 已记入今日时间日记')

    const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
    const store = new JournalStore({ deskRoot: tempDeskRoot })
    const days = await store.listDays()
    assert.equal(days.length, 1)
    assert.equal(days[0].count, 1)
    const dayRes = await store.getDay(days[0].date)
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return
    assert.equal(dayRes.entries.length, 1)
    assert.equal(dayRes.entries[0].body, '飞书群双写测试闪念')
    assert.equal(dayRes.entries[0].source, 'feishu')
    assert.equal(dayRes.entries[0].externalId, 'feishu:om_dual_test_001')
  } finally {
    await new Promise((res) => server.close(res))
    rmSync(tempDir, { recursive: true, force: true })
  }
})
