/**
 * Standalone Electron Main IPC registrar for SentinelDesk Language Push.
 * Obeys AGENTS.md decoupling guardrail: electron/main.ts invokes this in a single line.
 */

import type { IpcMain } from 'electron'
import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'
import type {
  LanguagePushConfig,
  LanguagePushDecisionAction,
  LanguagePushSpeakInput,
} from '../../src/language-push-contract'
import type { LanguagePushService } from './language-push-service'

const VALID_ACTIONS = new Set<LanguagePushDecisionAction>(['master', 'pin', 'unpin', 'later', 'restore'])

export function registerLanguagePushIpc(
  ipcMain: IpcMain,
  serviceOrGetter: LanguagePushService | (() => LanguagePushService),
): () => void {
  const resolveService = typeof serviceOrGetter === 'function' ? serviceOrGetter : () => serviceOrGetter

  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getLanguagePushOverview, () => resolveService().getOverview())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.runLanguagePush, (_event, options?: unknown) => {
    const safe = options && typeof options === 'object' ? (options as { date?: unknown; force?: unknown }) : {}
    return resolveService().runExtraction({
      date: typeof safe.date === 'string' ? safe.date : undefined,
      force: safe.force === true,
    })
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.decideLanguagePushCard, (_event, cardId: unknown, action: unknown) => {
    const normalizedAction = VALID_ACTIONS.has(action as LanguagePushDecisionAction)
      ? (action as LanguagePushDecisionAction)
      : 'later'
    return resolveService().decideCard(String(cardId), normalizedAction)
  })
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getLanguagePushConfig, () => resolveService().getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.saveLanguagePushConfig, (_event, patch: unknown) =>
    resolveService().saveConfig((patch && typeof patch === 'object' ? patch : {}) as Partial<LanguagePushConfig>),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.speakLanguagePush, (_event, input: unknown) => {
    const safe = input && typeof input === 'object' ? (input as Partial<LanguagePushSpeakInput>) : {}
    return resolveService().speak({
      text: typeof safe.text === 'string' ? safe.text : '',
      lang: safe.lang === 'ja' ? 'ja' : 'en',
      speed: typeof safe.speed === 'number' ? safe.speed : undefined,
      voiceId: typeof safe.voiceId === 'string' ? safe.voiceId : undefined,
      pronunciations: Array.isArray(safe.pronunciations) ? safe.pronunciations : undefined,
    })
  })

  return () => {
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getLanguagePushOverview)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.runLanguagePush)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.decideLanguagePushCard)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getLanguagePushConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.saveLanguagePushConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.speakLanguagePush)
  }
}
