/**
 * SentinelDesk 主进程装配：所有 desk 服务单例、IPC 注册、调度启动与生命周期钩子集中于此。
 * Main-process composition root for SentinelDesk. The base only calls `mountDesk(host)`,
 * `handle.start()` after the main window exists, `handle.observeProjectChatEvent()` from the
 * broker broadcast, and `handle.dispose()` on quit.
 */

import { DESKTOP_EVENT_CHANNELS } from '../../src/desktop-seam'
import { JournalStore } from '../../electron/desk/journal-store'
import { FeishuJournalBridgeService } from '../../electron/desk/feishu-journal-bridge'
import { JournalAutoTagService } from '../../electron/desk/journal-auto-tag-service'
import { registerJournalIpc } from '../../electron/desk/journal-ipc'
import { IntentTodoService } from '../../electron/desk/intent-todo-service'
import { LanguagePushService, createMorningBriefCorpusProvider } from '../../electron/desk/language-push-service'
import { registerLanguagePushIpc } from '../../electron/desk/language-push-ipc'
import { MorningBriefService } from '../../electron/desk/morning-brief-service'
import { registerMorningBriefIpc } from '../../electron/desk/morning-brief-ipc'
import { OutboundService } from '../../electron/desk/outbound-service'
import { registerOutboundIpc } from '../../electron/desk/outbound-ipc'
import type { DeskMainHost } from '../host/main-host'
import { registerFeishuJournalBridgeIpc, registerIntentTodoIpc, registerJournalAutoTagIpc } from './ipc'

export type DeskProjectChatEvent = Parameters<IntentTodoService['observeProjectChatEvent']>[0]

export interface DeskMainHandle {
  /** 主窗口创建后启动后台调度 / Start schedulers once the main window exists. */
  start(): void
  /** 由宿主的 Project Chat 广播转发 / Forwarded from the host's project-chat broadcast. */
  observeProjectChatEvent(event: DeskProjectChatEvent): void
  dispose(): void
}

const JOURNAL_AUTO_TAG_DEBOUNCE_MS = 1_200
const JOURNAL_AUTO_TAG_BOOT_DELAY_MS = 5_000

export function mountDesk(host: DeskMainHost): DeskMainHandle {
  let journalStore: JournalStore | null = null
  let feishuJournalBridge: FeishuJournalBridgeService | null = null
  let intentTodoService: IntentTodoService | null = null
  let languagePushService: LanguagePushService | null = null
  let morningBriefService: MorningBriefService | null = null
  let outboundService: OutboundService | null = null
  let journalAutoTagService: JournalAutoTagService | null = null
  let journalAutoTagDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let bootAutoTagTimer: ReturnType<typeof setTimeout> | null = null
  const journalAutoTagPendingDates = new Set<string>()
  const unsubscribers: Array<() => void> = []
  let started = false
  let disposed = false

  /** IPC handlers outlive dispose(); a late call must not build a service nobody will dispose. */
  function assertLive(): void {
    if (disposed) throw new Error('SentinelDesk has been disposed')
  }

  function getJournalStore(): JournalStore {
    assertLive()
    if (!journalStore) {
      journalStore = new JournalStore({
        onChange: (event) => {
          host.events.sendToMainWindow(DESKTOP_EVENT_CHANNELS.onJournalChanged, event)
          if (event.reason === 'created' || event.reason === 'updated') {
            scheduleJournalAutoTag(event.dates)
          }
        },
      })
    }
    return journalStore
  }

  function getJournalAutoTagService(): JournalAutoTagService {
    assertLive()
    if (!journalAutoTagService) {
      journalAutoTagService = new JournalAutoTagService({
        userDataPath: host.paths.userData,
        journalStore: getJournalStore(),
        getWorkspaceState: () => {
          const state = host.workspace.getState()
          return {
            projects: (state?.projects ?? []).map((project) => ({
              id: project.id,
              name: project.name,
              path: project.path,
            })),
          }
        },
        onChanged: (event) => host.events.broadcast(DESKTOP_EVENT_CHANNELS.onJournalAutoTagChanged, event),
      })
    }
    return journalAutoTagService
  }

  /**
   * Debounced auto-tagging trigger: journal writes are batched per affected date so a
   * burst of edits costs one local run instead of one run per keystroke.
   */
  function scheduleJournalAutoTag(dates: string[]): void {
    if (dates.length === 0) return
    for (const date of dates) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) journalAutoTagPendingDates.add(date)
    }
    if (journalAutoTagDebounceTimer) clearTimeout(journalAutoTagDebounceTimer)
    journalAutoTagDebounceTimer = setTimeout(() => {
      journalAutoTagDebounceTimer = null
      const pending = Array.from(journalAutoTagPendingDates)
      journalAutoTagPendingDates.clear()
      for (const date of pending) {
        void getJournalAutoTagService().runAutoTag({ date }).catch(() => undefined)
      }
    }, JOURNAL_AUTO_TAG_DEBOUNCE_MS)
  }

  function getFeishuJournalBridge(): FeishuJournalBridgeService {
    assertLive()
    if (!feishuJournalBridge) {
      feishuJournalBridge = new FeishuJournalBridgeService({
        userDataPath: host.paths.userData,
        journalStore: getJournalStore(),
        onStatusChange: (status) =>
          host.events.sendToMainWindow(DESKTOP_EVENT_CHANNELS.onFeishuJournalBridgeStatus, status),
      })
    }
    return feishuJournalBridge
  }

  function getIntentTodoService(): IntentTodoService {
    assertLive()
    if (!intentTodoService) {
      intentTodoService = new IntentTodoService({
        userDataPath: host.paths.userData,
        journalStore: getJournalStore(),
        settingsStore: host.settings.get(),
        getWorkspaceState: () => host.workspace.getState(),
        getBroker: () => host.agent.getBroker(),
        isOnline: () => host.net.isOnline(),
        beforeScheduledAnalysis: (logicalDate) => getJournalAutoTagService().runAutoTag({ date: logicalDate }),
        onChanged: (event) => host.events.broadcast(DESKTOP_EVENT_CHANNELS.onIntentTodoChanged, event),
      })
    }
    return intentTodoService
  }

  function getLanguagePushService(): LanguagePushService {
    assertLive()
    if (!languagePushService) {
      languagePushService = new LanguagePushService({
        journalStore: getJournalStore(),
        settingsStore: host.settings.get(),
        extraCorpusProviders: [createMorningBriefCorpusProvider(getMorningBriefService().store)],
        isOnline: () => host.net.isOnline(),
        onChanged: (event) => host.events.broadcast(DESKTOP_EVENT_CHANNELS.onLanguagePushChanged, event),
      })
    }
    return languagePushService
  }

  function getMorningBriefService(): MorningBriefService {
    assertLive()
    if (!morningBriefService) {
      morningBriefService = new MorningBriefService({
        journalStore: getJournalStore(),
        settingsStore: host.settings.get(),
        isOnline: () => host.net.isOnline(),
        onChanged: (event) => {
          host.events.broadcast(DESKTOP_EVENT_CHANNELS.onMorningBriefChanged, event)
          if (event.reason === 'generated') {
            languagePushService?.notifySystemResumeOrFocus()
          }
        },
      })
    }
    return morningBriefService
  }

  function getOutboundService(): OutboundService {
    assertLive()
    if (!outboundService) {
      outboundService = new OutboundService({
        journalStore: getJournalStore(),
        settingsStore: host.settings.get(),
        defaultRepoPaths: () => {
          try {
            const state = host.workspace.readSnapshot()
            if (!state) return []
            return state.projects
              .map((p) => p.path)
              .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          } catch {
            return []
          }
        },
        onChanged: (event) => host.events.broadcast(DESKTOP_EVENT_CHANNELS.onOutboundChanged, event),
      })
    }
    return outboundService
  }

  // IPC 在窗口创建前注册，与原 main.ts 时序一致 / Registered before the window exists, as before.
  registerJournalIpc(host.ipcMain, getJournalStore)
  registerLanguagePushIpc(host.ipcMain, getLanguagePushService)
  registerMorningBriefIpc(host.ipcMain, getMorningBriefService)
  registerOutboundIpc(host.ipcMain, getOutboundService)
  registerFeishuJournalBridgeIpc(host.ipcMain, getFeishuJournalBridge)
  registerJournalAutoTagIpc(host.ipcMain, getJournalAutoTagService)
  registerIntentTodoIpc(host.ipcMain, getIntentTodoService)

  return {
    start() {
      if (started || disposed) return
      started = true
      void getFeishuJournalBridge().startIfEnabled().catch(() => undefined)
      getIntentTodoService().start()
      getLanguagePushService().start()
      getMorningBriefService().start()
      // Catch up on today's journal a few seconds after boot.
      bootAutoTagTimer = setTimeout(() => {
        bootAutoTagTimer = null
        void getJournalAutoTagService().runAutoTag().catch(() => undefined)
      }, JOURNAL_AUTO_TAG_BOOT_DELAY_MS)
      unsubscribers.push(
        host.lifecycle.onSystemResume(() => {
          intentTodoService?.notifySystemResumeOrFocus()
          languagePushService?.notifySystemResumeOrFocus()
          morningBriefService?.notifySystemResumeOrFocus()
          void getJournalAutoTagService().runAutoTag().catch(() => undefined)
        }),
        host.lifecycle.onWindowFocus(() => {
          intentTodoService?.notifySystemResumeOrFocus()
          languagePushService?.notifySystemResumeOrFocus()
          morningBriefService?.notifySystemResumeOrFocus()
        }),
      )
    },
    observeProjectChatEvent(event) {
      intentTodoService?.observeProjectChatEvent(event)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
      if (bootAutoTagTimer) {
        clearTimeout(bootAutoTagTimer)
        bootAutoTagTimer = null
      }
      if (journalAutoTagDebounceTimer) {
        clearTimeout(journalAutoTagDebounceTimer)
        journalAutoTagDebounceTimer = null
      }
      journalStore?.dispose()
      feishuJournalBridge?.dispose()
      intentTodoService?.dispose()
      languagePushService?.dispose()
      morningBriefService?.dispose()
      outboundService?.dispose()
    },
  }
}
