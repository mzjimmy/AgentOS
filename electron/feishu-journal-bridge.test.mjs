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
  const { outputText } = ts.transpileModule(readFileSync(resolvedPath, 'utf8'), {
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

const VALID_APP_ID = 'cli_a1b2c3d4e5f60718'
const PNG_1X1_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const JPEG_MAGIC_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

test('parseFeishuMessageContent: handles plain text, legacy /记 prefix, image, post rich text, and dedupes image keys', () => {
  const mod = loadTsModule(resolve(rootDir, 'electron/desk/feishu-journal-bridge.ts'))

  assert.deepEqual(
    mod.parseFeishuMessageContent('text', JSON.stringify({ text: '午后散步 20 分钟' })),
    { text: '午后散步 20 分钟', imageKeys: [] },
  )

  assert.deepEqual(
    mod.parseFeishuMessageContent('text', JSON.stringify({ text: '@_user_1 /记 回笼觉醒了' })),
    { text: '回笼觉醒了', imageKeys: [] },
  )

  assert.deepEqual(
    mod.parseFeishuMessageContent('image', JSON.stringify({ image_key: 'img_v3_001' })),
    { text: '', imageKeys: ['img_v3_001'] },
  )

  const postContent = JSON.stringify({
    zh_cn: {
      title: '咖啡馆随拍',
      content: [
        [{ tag: 'text', text: '今天天气不错 ' }, { tag: 'at', user_name: 'Alice' }],
        [
          { tag: 'img', image_key: 'img_post_1' },
          { tag: 'img', image_key: 'img_post_1' },
          { tag: 'img', image_key: 'img_post_2' },
        ],
      ],
    },
  })
  assert.deepEqual(mod.parseFeishuMessageContent('post', postContent), {
    text: '咖啡馆随拍\n今天天气不错 @Alice',
    imageKeys: ['img_post_1', 'img_post_2'],
  })

  // detectImageMimeAndExt rejects empty & JSON error responses
  assert.equal(mod.detectImageMimeAndExt(Buffer.alloc(0), 'image/png'), null)
  assert.equal(
    mod.detectImageMimeAndExt(Buffer.from('{"code":234001,"msg":"error"}'), 'application/json'),
    null,
  )
  assert.equal(
    mod.detectImageMimeAndExt(Buffer.from('{"code":234001}'), 'application/octet-stream'),
    null,
  )

  // parseFeishuCreateTime handles seconds, ms, and out-of-range
  assert.equal(mod.parseFeishuCreateTime('1700000000'), new Date(1700000000 * 1000).toISOString())
  assert.equal(mod.parseFeishuCreateTime('1700000000000'), new Date(1700000000000).toISOString())
  assert.equal(mod.parseFeishuCreateTime('99999999999999999'), undefined)
})

test('FeishuJournalBridgeService: ingests text, image, and post into JournalStore and replies with emoji reaction', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'feishu-journal-bridge-test-'))
  const userDataPath = join(tempRoot, 'userData')
  const deskRoot = join(tempRoot, 'SentinelDesk')

  try {
    const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
    const { FeishuJournalBridgeService } = loadTsModule(
      resolve(rootDir, 'electron/desk/feishu-journal-bridge.ts'),
    )

    const store = new JournalStore({ deskRoot })
    let onMessageHandler = null
    const reactions = []
    const downloads = []

    const bridge = new FeishuJournalBridgeService({
      userDataPath,
      journalStore: store,
      clientFactory: () => ({
        async downloadImage(messageId, imageKey) {
          downloads.push({ messageId, imageKey })
          if (imageKey === 'img_jpg_1') {
            return { buffer: JPEG_MAGIC_BYTES, contentType: 'application/octet-stream' }
          }
          return { buffer: PNG_1X1_BYTES, contentType: 'image/png' }
        },
        async addReaction(messageId, emojiType) {
          reactions.push({ messageId, emojiType })
        },
        async start(onMessage) {
          onMessageHandler = onMessage
        },
        close() {
          onMessageHandler = null
        },
      }),
    })

    // Invalid appId format fails cleanly
    const badStatus = await bridge.updateConfig({
      enabled: true,
      appId: 'not_a_valid_id',
      appSecret: 'super_secret_1234',
    })
    assert.equal(badStatus.state, 'error')
    assert.match(badStatus.lastError || '', /App ID/)

    // Valid config connects & CHECKMARK normalizes to CheckMark
    const statusAfterSave = await bridge.updateConfig({
      enabled: true,
      appId: VALID_APP_ID,
      appSecret: 'super_secret_1234',
      reactionEmoji: 'CHECKMARK',
    })
    assert.equal(statusAfterSave.state, 'connected')
    assert.equal(statusAfterSave.config.hasAppSecret, true)
    assert.equal(statusAfterSave.config.appSecretMasked, '••••1234')
    assert.equal(statusAfterSave.config.reactionEmoji, 'CheckMark')
    assert.ok(typeof onMessageHandler === 'function')

    // Update with non-string appSecret (null) does not throw and keeps secret
    const statusAfterKeepSecret = await bridge.updateConfig({
      appSecret: null,
      reactionEmoji: 'OK',
    })
    assert.equal(statusAfterKeepSecret.state, 'connected')
    assert.equal(statusAfterKeepSecret.config.hasAppSecret, true)
    assert.equal(statusAfterKeepSecret.config.reactionEmoji, 'OK')

    const fixedCreateTimeMs = String(Date.parse('2026-11-20T08:30:00.000Z'))

    // 1. Plain text (no /记 prefix)
    await onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_me' } },
      message: {
        message_id: 'om_text_1',
        chat_id: 'oc_chat_1',
        message_type: 'text',
        content: JSON.stringify({ text: '不用斜杠记也能直接进日记' }),
        create_time: fixedCreateTimeMs,
      },
    })

    // 2. Duplicate message_id ignored idempotently
    await onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_me' } },
      message: {
        message_id: 'om_text_1',
        chat_id: 'oc_chat_1',
        message_type: 'text',
        content: JSON.stringify({ text: '重复推送' }),
        create_time: fixedCreateTimeMs,
      },
    })

    // 3. Pure image message
    await onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_me' } },
      message: {
        message_id: 'om_img_1',
        chat_id: 'oc_chat_1',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_png_1' }),
        create_time: fixedCreateTimeMs,
      },
    })

    // 4. Rich text (post) with text + jpeg image
    await onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_me' } },
      message: {
        message_id: 'om_post_1',
        chat_id: 'oc_chat_1',
        message_type: 'post',
        content: JSON.stringify({
          title: '',
          content: [
            [{ tag: 'text', text: '随手拍了一张图' }],
            [{ tag: 'img', image_key: 'img_jpg_1' }],
          ],
        }),
        create_time: fixedCreateTimeMs,
      },
    })

    const dayRes = await store.getDay('2026-11-20')
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return

    assert.equal(dayRes.entries.length, 3)
    assert.equal(dayRes.entries[0].body, '不用斜杠记也能直接进日记')
    assert.equal(dayRes.entries[0].kind, 'note')
    assert.equal(dayRes.entries[1].kind, 'photo')
    assert.equal(dayRes.entries[1].images.length, 1)
    assert.ok(existsSync(join(deskRoot, 'journal', dayRes.entries[1].images[0].relativePath)))
    assert.equal(dayRes.entries[2].body, '随手拍了一张图')
    assert.equal(dayRes.entries[2].images[0].mimeType, 'image/jpeg')

    assert.deepEqual(reactions, [
      { messageId: 'om_text_1', emojiType: 'OK' },
      { messageId: 'om_img_1', emojiType: 'OK' },
      { messageId: 'om_post_1', emojiType: 'OK' },
    ])
    assert.equal(downloads.length, 2)
    assert.equal(bridge.getStatus().receivedCount, 3)

    bridge.dispose()
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('FeishuJournalBridgeService: concurrent burst messages are serialized without losing entries', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'feishu-journal-bridge-burst-'))
  const userDataPath = join(tempRoot, 'userData')
  const deskRoot = join(tempRoot, 'SentinelDesk')

  try {
    const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
    const { FeishuJournalBridgeService } = loadTsModule(
      resolve(rootDir, 'electron/desk/feishu-journal-bridge.ts'),
    )

    const store = new JournalStore({ deskRoot })
    let onMessageHandler = null

    const bridge = new FeishuJournalBridgeService({
      userDataPath,
      journalStore: store,
      clientFactory: () => ({
        async downloadImage() {
          return { buffer: PNG_1X1_BYTES, contentType: 'image/png' }
        },
        async addReaction() {},
        async start(onMessage) {
          onMessageHandler = onMessage
        },
        close() {},
      }),
    })

    await bridge.updateConfig({
      enabled: true,
      appId: VALID_APP_ID,
      appSecret: 'secret_burst',
    })

    const fixedCreateTimeMs = String(Date.parse('2026-11-20T10:00:00.000Z'))
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        onMessageHandler({
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_me' } },
          message: {
            message_id: `om_burst_${n}`,
            chat_id: 'oc_chat_1',
            message_type: 'text',
            content: JSON.stringify({ text: `并发消息 ${n}` }),
            create_time: fixedCreateTimeMs,
          },
        }),
      ),
    )

    const dayRes = await store.getDay('2026-11-20')
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return
    assert.equal(dayRes.entries.length, 5)
    assert.equal(bridge.getStatus().receivedCount, 5)

    bridge.dispose()
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('FeishuJournalBridgeService: dispose mid-flight aborts persistence and reaction cleanly', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'feishu-journal-bridge-race-'))
  const userDataPath = join(tempRoot, 'userData')
  const deskRoot = join(tempRoot, 'SentinelDesk')

  try {
    const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
    const { FeishuJournalBridgeService } = loadTsModule(
      resolve(rootDir, 'electron/desk/feishu-journal-bridge.ts'),
    )

    const store = new JournalStore({ deskRoot })
    let onMessageHandler = null
    let resolveDownload = null
    let reacted = false

    const bridge = new FeishuJournalBridgeService({
      userDataPath,
      journalStore: store,
      clientFactory: () => ({
        downloadImage() {
          return new Promise((resolve) => {
            resolveDownload = () => resolve({ buffer: PNG_1X1_BYTES, contentType: 'image/png' })
          })
        },
        async addReaction() {
          reacted = true
        },
        async start(onMessage) {
          onMessageHandler = onMessage
        },
        close() {},
      }),
    })

    await bridge.updateConfig({
      enabled: true,
      appId: VALID_APP_ID,
      appSecret: 'secret_race',
    })

    const pending = onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_me' } },
      message: {
        message_id: 'om_race_1',
        chat_id: 'oc_chat_1',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_slow' }),
        create_time: String(Date.parse('2026-11-20T11:00:00.000Z')),
      },
    })

    // Dispose while image download is still in flight
    bridge.dispose()
    resolveDownload()
    await pending

    const dayRes = await store.getDay('2026-11-20')
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return
    assert.equal(dayRes.entries.length, 0)
    assert.equal(reacted, false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('FeishuJournalBridgeService: allowlist filters and reaction errors do not block saving', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'feishu-journal-bridge-warn-'))
  const userDataPath = join(tempRoot, 'userData')
  const deskRoot = join(tempRoot, 'SentinelDesk')

  try {
    const { JournalStore } = loadTsModule(resolve(rootDir, 'electron/desk/journal-store.ts'))
    const { FeishuJournalBridgeService } = loadTsModule(
      resolve(rootDir, 'electron/desk/feishu-journal-bridge.ts'),
    )

    const store = new JournalStore({ deskRoot })
    let onMessageHandler = null

    const bridge = new FeishuJournalBridgeService({
      userDataPath,
      journalStore: store,
      clientFactory: () => ({
        async downloadImage() {
          return { buffer: PNG_1X1_BYTES, contentType: 'image/png' }
        },
        async addReaction() {
          throw new Error('no permission im:message.reactions:write')
        },
        async start(onMessage) {
          onMessageHandler = onMessage
        },
        close() {},
      }),
    })

    await bridge.updateConfig({
      enabled: true,
      appId: VALID_APP_ID,
      appSecret: 'secret_test',
      allowedOpenId: 'ou_allowed',
    })

    // Filtered out sender
    await onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_stranger' } },
      message: {
        message_id: 'om_filtered_1',
        chat_id: 'oc_chat_1',
        message_type: 'text',
        content: JSON.stringify({ text: '不应被记入' }),
        create_time: String(Date.parse('2026-11-20T09:00:00.000Z')),
      },
    })

    // Allowed sender, reaction fails
    await onMessageHandler({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_allowed' } },
      message: {
        message_id: 'om_warn_1',
        chat_id: 'oc_chat_1',
        message_type: 'text',
        content: JSON.stringify({ text: '即使表情失败日记也必须落盘' }),
        create_time: String(Date.parse('2026-11-20T09:00:00.000Z')),
      },
    })

    const dayRes = await store.getDay('2026-11-20')
    assert.equal(dayRes.ok, true)
    if (!dayRes.ok) return
    assert.equal(dayRes.entries.length, 1)
    assert.equal(dayRes.entries[0].body, '即使表情失败日记也必须落盘')
    assert.match(bridge.getStatus().reactionWarning || '', /im:message\.reactions:write/)

    bridge.dispose()
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
