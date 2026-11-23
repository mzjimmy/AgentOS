/**
 * Electron Main IPC bridge for SentinelDesk Timeline Journal.
 */

import type { BrowserWindow, IpcMain } from 'electron'
import { DESKTOP_INVOKE_CHANNELS } from '../../src/desktop-seam'
import type {
  CreateJournalEntryInput,
  LegacyJournalSyncOptions,
  UpdateJournalEntryInput,
} from '../../src/journal-contract'
import { syncLegacySentinelLabJournal } from './legacy-sync'
import type { JournalStore } from './journal-store'

export function registerJournalIpc(
  ipcMain: IpcMain,
  storeOrGetter: JournalStore | (() => JournalStore),
  _getMainWindow?: () => BrowserWindow | null
): () => void {
  const resolveStore = typeof storeOrGetter === 'function' ? storeOrGetter : () => storeOrGetter

  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalConfig, () => resolveStore().getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.setJournalDeskRoot, (_event, deskRoot: unknown) =>
    resolveStore().setDeskRoot(String(deskRoot)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.listJournalDays, (_event, month?: unknown) =>
    resolveStore().listDays(typeof month === 'string' ? month : undefined),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalDay, (_event, date: unknown) =>
    resolveStore().getDay(String(date)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalWeek, (_event, anchorDate: unknown) =>
    resolveStore().getWeek(String(anchorDate)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.createJournalEntry, (_event, input: unknown) =>
    resolveStore().createEntry(input as CreateJournalEntryInput),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.updateJournalEntry, (_event, date: unknown, entryId: unknown, patch: unknown) =>
    resolveStore().updateEntry(String(date), String(entryId), patch as UpdateJournalEntryInput),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.deleteJournalEntry, (_event, date: unknown, entryId: unknown) =>
    resolveStore().deleteEntry(String(date), String(entryId)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.readJournalAttachment, (_event, relativePath: unknown) =>
    resolveStore().readAttachment(String(relativePath)),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.syncLegacySentinelLabJournal, (_event, options?: unknown) =>
    syncLegacySentinelLabJournal(resolveStore(), options as LegacyJournalSyncOptions),
  )
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.watchJournal, () => resolveStore().watch())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.unwatchJournal, () => resolveStore().unwatch())

  return () => {
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getJournalConfig)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.setJournalDeskRoot)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.listJournalDays)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getJournalDay)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.getJournalWeek)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.createJournalEntry)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.updateJournalEntry)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.deleteJournalEntry)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.readJournalAttachment)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.syncLegacySentinelLabJournal)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.watchJournal)
    ipcMain.removeHandler(DESKTOP_INVOKE_CHANNELS.unwatchJournal)
  }
}
