/**
 * Standalone Electron Main IPC registrar for SentinelDesk Morning Brief.
 * Obeys AGENTS.md decoupling guardrail: electron/main.ts invokes this in a single line.
 */

import type { IpcMain } from 'electron'
import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'
import type { MorningBriefConfig, MorningBriefSpeakInput } from '../../src/morning-brief-contract'
import type { MorningBriefService } from './morning-brief-service'

export function registerMorningBriefIpc(
  ipcMain: IpcMain,
  serviceOrGetter: MorningBriefService | (() => MorningBriefService),
): () => void {
  const resolveService = typeof serviceOrGetter === 'function' ? serviceOrGetter : () => serviceOrGetter

  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getMorningBriefOverview, (_event, selectedDate?: unknown) =>
    resolveService().getOverview(typeof selectedDate === 'string' ? selectedDate : undefined),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.runMorningBrief, (_event, options?: unknown) => {
    const safe = options && typeof options === 'object' ? (options as { date?: unknown; force?: unknown }) : {}
    return resolveService().runBrief({
      date: typeof safe.date === 'string' ? safe.date : undefined,
      force: safe.force === true,
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.swapMorningBriefItem, (_event, date: unknown, itemId: unknown) =>
    resolveService().swapItem(String(date || ''), String(itemId || '')),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getMorningBriefConfig, () => resolveService().getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveMorningBriefConfig, (_event, patch: unknown) =>
    resolveService().saveConfig((patch && typeof patch === 'object' ? patch : {}) as Partial<MorningBriefConfig>),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.speakMorningBrief, (_event, input: unknown) => {
    const safe = input && typeof input === 'object' ? (input as Partial<MorningBriefSpeakInput>) : {}
    return resolveService().speak({
      date: typeof safe.date === 'string' ? safe.date : '',
      sectionIndex: typeof safe.sectionIndex === 'number' ? safe.sectionIndex : undefined,
      stitchFullIssue: safe.stitchFullIssue === true,
    })
  })

  return () => {
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getMorningBriefOverview)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.runMorningBrief)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.swapMorningBriefItem)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getMorningBriefConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.saveMorningBriefConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.speakMorningBrief)
  }
}
