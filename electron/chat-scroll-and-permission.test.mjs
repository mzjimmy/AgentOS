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

function loadTsModule(modulePath) {
  const source = readFileSync(modulePath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: modulePath,
  })
  const module = { exports: {} }
  Function('exports', 'module', 'require', outputText)(module.exports, module, require)
  return module.exports
}

test('resolveAutoPermissionDecision auto-allows non-AskUserQuestion tools under bypassPermissions only', () => {
  const { resolveAutoPermissionDecision } = loadTsModule(
    resolve(testDir, 'claude-agent-runner/permission.ts'),
  )

  const bashInput = { command: 'npm run typecheck' }
  assert.deepEqual(
    resolveAutoPermissionDecision('bypassPermissions', 'Bash', bashInput, 'tu-1'),
    {
      behavior: 'allow',
      updatedInput: bashInput,
      toolUseID: 'tu-1',
    },
  )

  assert.deepEqual(
    resolveAutoPermissionDecision('bypassPermissions', 'Edit', { file_path: 'a.ts' }, 'tu-2'),
    {
      behavior: 'allow',
      updatedInput: { file_path: 'a.ts' },
      toolUseID: 'tu-2',
    },
  )

  // AskUserQuestion must still surface interactive questions even under bypassPermissions
  assert.equal(
    resolveAutoPermissionDecision('bypassPermissions', 'AskUserQuestion', { questions: [] }, 'tu-3'),
    null,
  )

  // Non-bypass permission modes must continue to defer to interactive permission prompts
  for (const mode of ['auto', 'default', 'acceptEdits', 'plan']) {
    assert.equal(
      resolveAutoPermissionDecision(mode, 'Bash', bashInput, 'tu-4'),
      null,
      `mode=${mode} must not auto-allow via bypass guard`,
    )
  }

  // Verify ClaudeAgentRunner calls runtimeMutationTargetAllowed BEFORE resolveAutoPermissionDecision inside handleCanUseTool
  const runnerSrc = readFileSync(resolve(testDir, 'claude-agent-runner.ts'), 'utf8')
  const methodStart = runnerSrc.indexOf('private async handleCanUseTool(')
  const methodEnd = runnerSrc.indexOf('private resolvePendingPermission(', methodStart)
  assert.ok(methodStart > 0 && methodEnd > methodStart, 'handleCanUseTool method body must be found')
  const methodBody = runnerSrc.slice(methodStart, methodEnd)
  const fenceIdx = methodBody.indexOf('runtimeMutationTargetAllowed(')
  const autoIdx = methodBody.indexOf('resolveAutoPermissionDecision(')
  assert.ok(fenceIdx > 0, 'runtimeMutationTargetAllowed guard must exist inside handleCanUseTool')
  assert.ok(autoIdx > fenceIdx, 'resolveAutoPermissionDecision must run AFTER runtimeMutationTargetAllowed inside handleCanUseTool')
})

test('chat streaming scroll stability: disables browser scroll anchoring, tracks pinnedToBottomRef on scroll, preserves Mermaid SVG during re-render, attaches ProcessTraceBlock scroll on hasProcessBody, and stops FileDiffRow mid-stream auto-expand', () => {
  const agentSettingsCss = readFileSync(resolve(rootDir, 'src/styles/agent-settings.css'), 'utf8')
  const scrollRegionBlock = agentSettingsCss.match(/\.chat-scroll-region\s*\{[\s\S]*?\}/)?.[0] ?? ''
  const transcriptBlock = agentSettingsCss.match(/\.chat-transcript\s*\{[\s\S]*?\}/)?.[0] ?? ''
  assert.match(scrollRegionBlock, /overflow-anchor:\s*none/, '.chat-scroll-region must disable scroll anchoring')
  assert.match(transcriptBlock, /overflow-anchor:\s*none/, '.chat-transcript must disable scroll anchoring')

  const chatPageSrc = readFileSync(resolve(rootDir, 'src/components/chat/ChatPage.tsx'), 'utf8')
  const thresholdMatch = chatPageSrc.match(/const\s+SCROLL_STICK_THRESHOLD_PX\s*=\s*(\d+)/)
  assert.ok(thresholdMatch, 'SCROLL_STICK_THRESHOLD_PX must be defined')
  assert.ok(
    Number(thresholdMatch[1]) <= 48,
    `SCROLL_STICK_THRESHOLD_PX (${thresholdMatch[1]}) must be <= 48px so small upward scrolls detach cleanly`,
  )
  assert.match(
    chatPageSrc,
    /scrollIntentRef\.current\s*===\s*'force-bottom'\s*\|\|\s*pinnedToBottomRef\.current/,
    'ResizeObserver must rely on scroll-tracked pinnedToBottomRef so large streaming frames never falsely detach',
  )

  const transcriptSrc = readFileSync(resolve(rootDir, 'src/components/chat/Transcript.tsx'), 'utf8')
  // ProcessTraceBlock must keep an internal scroll ref on .chat-process-group__body and re-attach when hasProcessBody mounts
  assert.match(
    transcriptSrc,
    /className="chat-process-group__body"\s+ref=/,
    'ProcessTraceBlock must attach a ref to .chat-process-group__body for contained internal scrolling',
  )
  assert.match(
    transcriptSrc,
    /const\s+hasProcessBody\s*=\s*isOpen\s*&&\s*processItems\.length\s*>\s*0/,
    'ProcessTraceBlock must key its scroll listener on hasProcessBody so expanding before first item still attaches',
  )
  // FileDiffRow must NOT re-open unexpectedly via useEffect on status === 'captured'
  assert.doesNotMatch(
    transcriptSrc,
    /if\s*\(item\.status\s*===\s*'captured'\)\s*setIsOpen\(true\)/,
    'FileDiffRow must not auto-expand mid-stream via useEffect',
  )

  const richCodeSrc = readFileSync(resolve(rootDir, 'src/components/chat/RichCodeBlock.tsx'), 'utf8')
  // MermaidDiagram must not wipe previous SVG back to empty string on every streaming re-render
  assert.doesNotMatch(
    richCodeSrc,
    /setRenderState\('rendering'\)\s*\n\s*setSvg\(''\)/,
    'MermaidDiagram must preserve existing SVG during streaming re-renders to avoid 180px height bounce',
  )
})
