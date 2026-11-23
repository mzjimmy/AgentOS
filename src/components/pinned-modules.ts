/**
 * 侧栏顶部固定功能模块注册表（插槽式可扩展设计）。
 * Extensible registry for pinned top-level workspace modules in the sidebar.
 */

import type { IconName } from '../icons'
import type { AppViewId } from './types'

export type PinnedModuleDefinition = {
  id: Exclude<AppViewId, 'settings'>
  labelKey: string
  icon: IconName
  hash: string
}

export const PINNED_MODULES: readonly PinnedModuleDefinition[] = [
  {
    id: 'journal',
    labelKey: 'sidebar.pinnedJournal',
    icon: 'journal',
    hash: '#journal',
  },
  {
    id: 'intent-todo',
    labelKey: 'sidebar.pinnedIntentTodo',
    icon: 'checklist',
    hash: '#intent-todo',
  },
  {
    id: 'quick-commands',
    labelKey: 'sidebar.pinnedQuickCommands',
    icon: 'code',
    hash: '#quick-commands',
  },
] as const

export function resolvePinnedModuleByViewId(viewId: string): PinnedModuleDefinition | undefined {
  return PINNED_MODULES.find((item) => item.id === viewId)
}
