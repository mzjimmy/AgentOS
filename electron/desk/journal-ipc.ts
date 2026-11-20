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
  store: JournalStore,
  _getMainWindow?: () => BrowserWindow | null
): () => void {
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalConfig, () => store.getConfig())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.setJournalDeskRoot, (_event, deskRoot: string) => store.setDeskRoot(deskRoot))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.listJournalDays, (_event, month?: string) => store.listDays(month))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalDay, (_event, date: string) => store.getDay(date))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.getJournalWeek, (_event, anchorDate: string) => store.getWeek(anchorDate))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.createJournalEntry, (_event, input: CreateJournalEntryInput) => store.createEntry(input))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.updateJournalEntry, (_event, date: string, entryId: string, patch: UpdateJournalEntryInput) => store.updateEntry(date, entryId, patch))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.deleteJournalEntry, (_event, date: string, entryId: string) => store.deleteEntry(date, entryId))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.readJournalAttachment, (_event, relativePath: string) => store.readAttachment(relativePath))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.syncLegacySentinelLabJournal, (_event, options?: LegacyJournalSyncOptions) => syncLegacySentinelLabJournal(store, options))
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.watchJournal, () => store.watch())
  ipcMain.handle(DESKTOP_INVOKE_CHANNELS.unwatchJournal, () => store.unwatch())

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
