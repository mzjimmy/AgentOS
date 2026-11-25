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
  {
    id: 'language-push',
    labelKey: 'sidebar.pinnedLanguagePush',
    icon: 'languages',
    hash: '#language-push',
  },
  {
    id: 'morning-brief',
    labelKey: 'sidebar.pinnedMorningBrief',
    icon: 'newspaper',
    hash: '#morning-brief',
  },
  {
    id: 'outbound',
    labelKey: 'sidebar.pinnedOutbound',
    icon: 'megaphone',
    hash: '#outbound',
  },
] as const

export function resolvePinnedModuleByViewId(viewId: string): PinnedModuleDefinition | undefined {
  return PINNED_MODULES.find((item) => item.id === viewId)
}

export type PinnedModuleNavState = {
  prev: PinnedModuleDefinition | null
  next: PinnedModuleDefinition | null
}

/**
 * Deterministic sequential navigation over `PINNED_MODULES` for the top-left `<` / `>` buttons.
 * - On any pinned module: steps strictly to `idx - 1` / `idx + 1`, disabling at first / last module.
 * - Outside pinned modules (e.g. project chat `home` / `docs`): `<` enters the bottom module (`outbound`),
 *   `>` enters the top module (`journal`), so both arrows are never simultaneously disabled.
 */
export function resolvePinnedModuleNavigation(activeViewId: AppViewId): PinnedModuleNavState {
  const idx = PINNED_MODULES.findIndex((item) => item.id === activeViewId)
  if (idx < 0) {
    return {
      prev: PINNED_MODULES[PINNED_MODULES.length - 1] ?? null,
      next: PINNED_MODULES[0] ?? null,
    }
  }
  return {
    prev: idx > 0 ? PINNED_MODULES[idx - 1] : null,
    next: idx < PINNED_MODULES.length - 1 ? PINNED_MODULES[idx + 1] : null,
  }
}
