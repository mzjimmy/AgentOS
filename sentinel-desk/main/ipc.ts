/**
 * 尚未拥有独立 `*-ipc.ts` 的 desk 模块的 IPC 注册（自 main.ts 平移，行为不变）。
 * IPC registration for desk capabilities that previously lived inline in electron/main.ts.
 */

import type { IpcMain } from 'electron'
import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'
import type { FeishuJournalBridgeService } from '../../electron/desk/feishu-journal-bridge'
import type { JournalAutoTagService } from '../../electron/desk/journal-auto-tag-service'
import type { IntentTodoService } from '../../electron/desk/intent-todo-service'

type Getter<T> = () => T

function removeAll(ipcMain: IpcMain, channels: string[]): () => void {
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}

export function registerFeishuJournalBridgeIpc(ipcMain: IpcMain, getBridge: Getter<FeishuJournalBridgeService>): () => void {
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getFeishuJournalBridgeStatus, () => getBridge().getStatus())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveFeishuJournalBridgeConfig, (_event, update: unknown) =>
    getBridge().updateConfig((update ?? {}) as Parameters<FeishuJournalBridgeService['updateConfig']>[0]),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.reconnectFeishuJournalBridge, () => getBridge().reconnect())
  return removeAll(ipcMain, [
    DESKTOP_INVOKE_CHANNELS.getFeishuJournalBridgeStatus,
    DESKTOP_INVOKE_CHANNELS.saveFeishuJournalBridgeConfig,
    DESKTOP_INVOKE_CHANNELS.reconnectFeishuJournalBridge,
  ])
}

export function registerJournalAutoTagIpc(ipcMain: IpcMain, getService: Getter<JournalAutoTagService>): () => void {
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalAutoTagStatus, () => getService().getStatus())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.runJournalAutoTag, (_event, options?: unknown) =>
    getService().runAutoTag((options ?? {}) as { date?: string; force?: boolean }),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveJournalAutoTagConfig, (_event, patch: unknown) =>
    getService().saveConfig((patch ?? {}) as Parameters<JournalAutoTagService['saveConfig']>[0]),
  )
  return removeAll(ipcMain, [
    DESKTOP_INVOKE_CHANNELS.getJournalAutoTagStatus,
    DESKTOP_INVOKE_CHANNELS.runJournalAutoTag,
    DESKTOP_INVOKE_CHANNELS.saveJournalAutoTagConfig,
  ])
}

export function registerIntentTodoIpc(ipcMain: IpcMain, getService: Getter<IntentTodoService>): () => void {
  const optionalDate = (value: unknown) => (typeof value === 'string' ? value : undefined)
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getIntentTodoOverview, (_event, selectedDate?: unknown) =>
    getService().getOverview(optionalDate(selectedDate)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.listIntentTodoCalendar, () => getService().listCalendarDays())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.refreshIntentTodo, (_event, selectedDate?: unknown) =>
    getService().refreshAnalysis(optionalDate(selectedDate)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.decideIntentTodo, (_event, itemId: unknown, decision: unknown, selectedDate?: unknown) =>
    getService().decideItem(
      String(itemId),
      decision as Parameters<IntentTodoService['decideItem']>[1],
      optionalDate(selectedDate),
    ),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.dispatchIntentTodo, (_event, params: unknown) =>
    getService().dispatchItem((params ?? {}) as Parameters<IntentTodoService['dispatchItem']>[0]),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.polishIntentTodoPrompt, (_event, params: unknown) =>
    getService().polishDispatchPrompt((params ?? {}) as Parameters<IntentTodoService['polishDispatchPrompt']>[0]),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getIntentTodoConfig, () => getService().getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveIntentTodoConfig, (_event, patch: unknown) =>
    getService().saveConfig((patch ?? {}) as Parameters<IntentTodoService['saveConfig']>[0]),
  )
  return removeAll(ipcMain, [
    DESKTOP_INVOKE_CHANNELS.getIntentTodoOverview,
    DESKTOP_INVOKE_CHANNELS.listIntentTodoCalendar,
    DESKTOP_INVOKE_CHANNELS.refreshIntentTodo,
    DESKTOP_INVOKE_CHANNELS.decideIntentTodo,
    DESKTOP_INVOKE_CHANNELS.dispatchIntentTodo,
    DESKTOP_INVOKE_CHANNELS.polishIntentTodoPrompt,
    DESKTOP_INVOKE_CHANNELS.getIntentTodoConfig,
    DESKTOP_INVOKE_CHANNELS.saveIntentTodoConfig,
  ])
}
