/**
 * SentinelDesk 主进程宿主端口：desk 对任何底座（AgentOS 或其他框架）的全部依赖都在这里声明。
 * Main-process host port — the complete contract SentinelDesk needs from whatever base hosts it.
 *
 * 规则 / Rules:
 * - 本文件只能依赖 desk 自有类型（electron/desk/* 在 P4 前为 desk 自有的过渡位置）与 `electron` 类型。
 * - 禁止 import AgentOS 底座内部模块；底座实现放在 `sentinel-desk/adapters/<host>/`。
 */

import type { IpcMain } from 'electron'
import type { IntentTodoServiceOptions } from '../../electron/desk/intent-todo-service'
import type { LanguagePushServiceOptions } from '../../electron/desk/language-push-service'
import type { MorningBriefServiceOptions } from '../../electron/desk/morning-brief-service'
import type { OutboundServiceOptions } from '../../electron/desk/outbound-service'

/** desk 各服务对模型配置的最小需求之交集 / Intersection of every desk service's settings port. */
export type DeskSettingsPort = IntentTodoServiceOptions['settingsStore'] &
  LanguagePushServiceOptions['settingsStore'] &
  MorningBriefServiceOptions['settingsStore'] &
  OutboundServiceOptions['settingsStore']

export type DeskWorkspaceState = ReturnType<IntentTodoServiceOptions['getWorkspaceState']>

export type DeskAgentBrokerPort = NonNullable<ReturnType<IntentTodoServiceOptions['getBroker']>>

export type Unsubscribe = () => void

export interface DeskMainHost {
  paths: { userData: string }
  /** 主进程 IPC 注册器（P2 收口为单通道前沿用 IpcMain 形态）/ IPC registrar. */
  ipcMain: IpcMain
  events: {
    /** 仅发往主窗口 / Send to the main window only. */
    sendToMainWindow(channel: string, payload: unknown): void
    /** 广播到所有窗口 / Broadcast to every window. */
    broadcast(channel: string, payload: unknown): void
  }
  settings: { get(): DeskSettingsPort }
  workspace: {
    /** 最新内存态（含未落盘）/ Latest in-memory state, falling back to persisted. */
    getState(): DeskWorkspaceState
    /** 已持久化快照 / Persisted snapshot. */
    readSnapshot(): DeskWorkspaceState
  }
  agent: { getBroker(): DeskAgentBrokerPort | null }
  net: { isOnline(): boolean }
  lifecycle: {
    onSystemResume(listener: () => void): Unsubscribe
    onWindowFocus(listener: () => void): Unsubscribe
  }
}
