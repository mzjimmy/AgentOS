/**
 * Standalone Electron Main IPC registrar for SentinelDesk Outbound Studio.
 * Obeys AGENTS.md decoupling guardrail: electron/main.ts invokes this in a single line.
 */

import type { IpcMain } from 'electron'
import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'
import type {
  OutboundConfig,
  OutboundDraftInput,
  OutboundSaveDraftInput,
} from '../../src/outbound-contract'
import type { OutboundService } from './outbound-service'

export function registerOutboundIpc(
  ipcMain: IpcMain,
  serviceOrGetter: OutboundService | (() => OutboundService),
): () => void {
  const resolveService = typeof serviceOrGetter === 'function' ? serviceOrGetter : () => serviceOrGetter

  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getOutboundOverview, (_event, selectedDate?: unknown) =>
    resolveService().getOverview(typeof selectedDate === 'string' ? selectedDate : undefined),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.extractOutboundPack, (_event, options?: unknown) => {
    const safe = options && typeof options === 'object' ? (options as { date?: unknown; force?: unknown }) : {}
    return resolveService().extract({
      date: typeof safe.date === 'string' ? safe.date : undefined,
      force: safe.force === true,
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.generateOutboundDraft, (_event, input: unknown) => {
    const safe = input && typeof input === 'object' ? (input as Partial<OutboundDraftInput>) : {}
    return resolveService().generateDraft({
      date: typeof safe.date === 'string' ? safe.date : '',
      seedId: typeof safe.seedId === 'string' ? safe.seedId : '',
      customAngle: typeof safe.customAngle === 'string' ? safe.customAngle : undefined,
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveOutboundDraft, (_event, input: unknown) => {
    const safe = input && typeof input === 'object' ? (input as Partial<OutboundSaveDraftInput>) : {}
    return resolveService().saveDraft({
      draftId: typeof safe.draftId === 'string' ? safe.draftId : '',
      title: typeof safe.title === 'string' ? safe.title : undefined,
      markdown: typeof safe.markdown === 'string' ? safe.markdown : '',
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getOutboundConfig, () => resolveService().getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveOutboundConfig, (_event, patch: unknown) =>
    resolveService().saveConfig((patch && typeof patch === 'object' ? patch : {}) as Partial<OutboundConfig>),
  )

  return () => {
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getOutboundOverview)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.extractOutboundPack)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.generateOutboundDraft)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.saveOutboundDraft)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getOutboundConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.saveOutboundConfig)
  }
}
