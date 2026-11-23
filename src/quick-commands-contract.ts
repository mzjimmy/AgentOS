/**
 * Frozen contract for SentinelDesk Quick Commands (常用命令) MVP.
 *
 * Renderer-only persistence via localStorage (`QUICK_COMMANDS_STORAGE_KEY`) with
 * explicit envelope versioning so deleting all items never resurrects defaults.
 * Sending to Agent reuses the existing renderer `sendAgentCommand` channel
 * (bound to the active project) and never touches `electron/main.ts` or `dispatchIntentTodo`.
 */

export const QUICK_COMMANDS_STORAGE_KEY = 'agentos:quick-commands:v1'
export const QUICK_COMMANDS_SCHEMA_VERSION = 1

export type QuickCommandCategory = 'triage' | 'dev' | 'review' | 'content' | 'other'

export const QUICK_COMMAND_CATEGORIES: readonly QuickCommandCategory[] = [
  'triage',
  'dev',
  'review',
  'content',
  'other',
] as const

export type QuickCommandItem = {
  id: string
  title: string
  body: string
  category: QuickCommandCategory
  pinned: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  useCount: number
}

export type QuickCommandsEnvelope = {
  version: typeof QUICK_COMMANDS_SCHEMA_VERSION
  items: QuickCommandItem[]
}

export type QuickCommandDraftInput = {
  title: string
  body: string
  category?: QuickCommandCategory
  pinned?: boolean
}

export type QuickCommandFilter = {
  category?: QuickCommandCategory | 'all'
  query?: string
}

export type QuickCommandSendReadiness =
  | { canSend: true; projectId: string; projectName: string }
  | { canSend: false; reason: 'no_active_project' }

export interface QuickCommandStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_STARTER_COMMANDS: readonly QuickCommandDraftInput[] = [
  {
    title: '二轮意图研判与存量扫雷',
    body: '请使用 intent-todo-triage 帮我分析今天的意图待办，结合近 7 天非私密日记和近期代码提交做存量扫雷，落盘完整报告并输出 30 秒 6 桶决策卡。',
    category: 'triage',
    pinned: true,
  },
  {
    title: 'Outside-Agent + TDD 落地',
    body: '请按 outside-agent + TDD 流程推进当前选定需求：先建立基线与测试接缝、垂直切片 Red→Green 实现、完成后独立复核并给出验证证据。',
    category: 'dev',
    pinned: true,
  },
  {
    title: '已闭环待办真伪复核',
    body: '请核查最近 3 天已标记 done 的工程待办和近期提交，检查是否有漏测边界、死代码或安全配置隐患，只汇报 1-3 条高信噪比问题。',
    category: 'review',
    pinned: false,
  },
] as const
