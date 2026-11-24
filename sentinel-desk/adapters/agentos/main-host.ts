/**
 * AgentOS 主进程适配器：把底座的窗口、设置、工作区、broker 与系统事件映射到 DeskMainHost。
 * AgentOS main-process adapter — the only desk file that knows how the AgentOS base is wired.
 * electron/main.ts 只调用 `mountAgentOSDesk(...)`；底座内部改动时只需修改本文件。
 */

import { app, BrowserWindow, ipcMain, net, powerMonitor } from 'electron'
import type {
  DeskAgentBrokerPort,
  DeskMainHost,
  DeskSettingsPort,
  DeskWorkspaceState,
} from '../../host/main-host'
import { mountDesk, type DeskMainHandle } from '../../main/mount'

export type { DeskMainHandle }

interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

interface WorkspaceStoreLike {
  current(): DeskWorkspaceState | null | undefined
  read(): DeskWorkspaceState
}

export interface AgentOSMainHostDeps {
  getMainWindow(): WindowLike | null | undefined
  getSettingsStore(): DeskSettingsPort
  /** 工作区存储尚未就绪时返回 null / Null until the workspace store is ready. */
  getWorkspaceStore(): WorkspaceStoreLike | null | undefined
  /** Broker V2 关闭时返回 null / Null when Project Chat Broker V2 is disabled. */
  getBroker(): DeskAgentBrokerPort | null
}

export function createAgentOSMainHost(deps: AgentOSMainHostDeps): DeskMainHost {
  return {
    paths: { userData: app.getPath('userData') },
    ipcMain,
    events: {
      sendToMainWindow(channel, payload) {
        const win = deps.getMainWindow()
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
      },
      broadcast(channel, payload) {
        for (const windowItem of BrowserWindow.getAllWindows()) {
          if (!windowItem.isDestroyed()) windowItem.webContents.send(channel, payload)
        }
      },
    },
    settings: { get: () => deps.getSettingsStore() },
    workspace: {
      getState() {
        const store = deps.getWorkspaceStore()
        return store?.current() ?? store?.read() ?? null
      },
      readSnapshot: () => deps.getWorkspaceStore()?.read() ?? null,
    },
    agent: { getBroker: () => deps.getBroker() },
    net: { isOnline: () => net.isOnline() },
    lifecycle: {
      onSystemResume(listener) {
        powerMonitor.on('resume', listener)
        return () => {
          powerMonitor.removeListener('resume', listener)
        }
      },
      onWindowFocus(listener) {
        app.on('browser-window-focus', listener)
        return () => {
          app.removeListener('browser-window-focus', listener)
        }
      },
    },
  }
}

export function mountAgentOSDesk(deps: AgentOSMainHostDeps): DeskMainHandle {
  return mountDesk(createAgentOSMainHost(deps))
}
