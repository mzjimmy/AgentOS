# Technical Design: `chg-20261120-sentinel-desk-journal`

## 1. Architecture Overview（插槽式固定页 + 文件即真相）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Renderer (`src/`)                                                        │
│  ├── `src/components/pinned-modules.ts`  (Extensible Pinned Page Slot)   │
│  ├── `AppShellSidebar.tsx`               (Renders pinned modules on top) │
│  ├── `AppShellWorkspace.tsx`             (Lazy-mounts `JournalPage`)     │
│  └── `src/components/journal/`           (Hydrogen-designed Editorial UI)│
│       ├── JournalPage.tsx                (imports `journal-page.css`)    │
│       ├── JournalCard.tsx                (6 deterministic card species)  │
│       ├── JournalWeekView.tsx            (7-column week overview)        │
│       ├── JournalComposer.tsx            (text/paste/drag/voice/@/#)     │
│       └── JournalLightbox.tsx            (full-res modal w/ Esc/arrows)  │
├──────────────────────────────────────────────────────────────────────────┤
│ Shared Wire Contract: `src/journal-contract.ts` (FROZEN)                 │
│ Desktop Seam: `src/desktop-api.ts` + `src/desktop-seam.ts` + `preload.ts`│
├──────────────────────────────────────────────────────────────────────────┤
│ Electron Main (`electron/desk/`)                                         │
│  ├── journal-markdown.ts   (Pure parser/serializer for daily `.md`)      │
│  ├── journal-store.ts      (CRUD, attachments, dedup, fs.watch)          │
│  ├── legacy-sync.ts        (Read-only `sqlite3 -readonly` importer)      │
│  └── journal-ipc.ts        (Registers IPC handlers cleanly from main.ts) │
├──────────────────────────────────────────────────────────────────────────┤
│ Plain Files on Disk (`/Users/sentinellab/VibeCoding/SentinelDesk/`)      │
│  ├── journal/YYYY/MM/YYYY-MM-DD.md                                       │
│  └── journal/attachments/YYYY/MM/<id>.<ext>                              │
├──────────────────────────────────────────────────────────────────────────┤
│ External Feishu Bridge Dual-Write (Zero-Disruption Side Tee)             │
│  `sentinellab-bridge.sh` ──► Primary: `127.0.0.1:3001/api/bridge/inbound`│
│                          └── Side Tee (`|| true`):                       │
│                              `scripts/sentinel-desk-append.mjs`          │
│                              ──► appends directly to `SentinelDesk/`     │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. Plaintext Markdown Storage Format

Daily file path: `<deskRoot>/journal/<YYYY>/<MM>/<YYYY-MM-DD>.md`

Each entry is an append-only, human-readable, Obsidian-friendly block:

```markdown
# 2026-11-20

<!-- journal:entry {"id":"je_20261120_065100_a1b2","ts":"2026-11-20T06:51:00.000+08:00","time":"06:51","kind":"note","category":"学习","tags":["agent os","需求 vs 反馈"],"projectRefs":[],"source":"local","provenance":"human","externalId":null,"images":[],"relatedNote":null,"momentTitle":null,"momentSubtitle":null} -->
### 06:51 · 学习
爬山 800 米。在思考 agent os 的规划...

---
```

When images exist, each image is written to `<deskRoot>/journal/attachments/<YYYY>/<MM>/<id>_<idx>.<ext>`, listed in the JSON comment `images[]` with `relativePath: "attachments/YYYY/MM/..."`, AND rendered as standard Obsidian-friendly Markdown inside the entry body section:
`![caption](../../attachments/2026/11/img_xxx.png)` (stripped cleanly on parse back into `body` + `images[]` so it never duplicates in the UI!).

### Idempotency & Safety Rules
- **Dedup**: If `externalId` is non-null and already exists in that day's file (or scanned across recent files), `createJournalEntry` returns `{ ok: true, entry: existing, deduplicated: true }` without appending a duplicate.
- **Atomic writes**: Write to `.tmp-<pid>-<rand>` in the same directory and `rename` atomically so concurrent writes (e.g., Electron + `sentinel-desk-append.mjs`) never leave a truncated `.md` file.
- **Path traversal guard**: `readJournalAttachment(relativePath)` MUST normalize and verify the resolved path stays strictly inside `<deskRoot>/journal/attachments/`.
- **Legacy DB safety**: `legacy-sync.ts` ONLY reads via `sqlite3 -readonly -json <dbPath> "..."`. It NEVER opens `sentinellab.db` for write. Legacy `tags` JSON array is parsed gracefully; legacy `date` (`YYYY-MM-DD`) and `timestamp` (`HH:mm` or ISO) map directly to `JournalEntry` with `externalId: "sl:" + row.id` and `source: "sentinellab-import"`.

## 3. Desktop Seam Additions (Verbatim Contract)

Add to `src/desktop-api.ts` (`DesktopAPI`):
```ts
getJournalConfig?: () => Promise<JournalConfig>
setJournalDeskRoot?: (deskRoot: string) => Promise<JournalConfig>
listJournalDays?: (month?: string) => Promise<JournalDaySummary[]>
getJournalDay?: (date: string) => Promise<JournalDayResult>
getJournalWeek?: (anchorDate: string) => Promise<JournalWeekResult>
createJournalEntry?: (input: CreateJournalEntryInput) => Promise<CreateJournalEntryResult>
updateJournalEntry?: (date: string, entryId: string, patch: UpdateJournalEntryInput) => Promise<UpdateJournalEntryResult>
deleteJournalEntry?: (date: string, entryId: string) => Promise<DeleteJournalEntryResult>
readJournalAttachment?: (relativePath: string) => Promise<JournalAttachmentReadResult>
syncLegacySentinelLabJournal?: (options?: LegacyJournalSyncOptions) => Promise<LegacyJournalSyncResult>
watchJournal?: () => Promise<{ ok: boolean }>
unwatchJournal?: () => Promise<{ ok: boolean }>
onJournalChanged?: (listener: (event: JournalChangedEvent) => void) => () => void
```

Add to `src/desktop-seam.ts`:
- `DESKTOP_INVOKE_CHANNELS`:
  - `getJournalConfig: 'desktop:journal:get-config'`
  - `setJournalDeskRoot: 'desktop:journal:set-desk-root'`
  - `listJournalDays: 'desktop:journal:list-days'`
  - `getJournalDay: 'desktop:journal:get-day'`
  - `getJournalWeek: 'desktop:journal:get-week'`
  - `createJournalEntry: 'desktop:journal:create-entry'`
  - `updateJournalEntry: 'desktop:journal:update-entry'`
  - `deleteJournalEntry: 'desktop:journal:delete-entry'`
  - `readJournalAttachment: 'desktop:journal:read-attachment'`
  - `syncLegacySentinelLabJournal: 'desktop:journal:sync-legacy'`
  - `watchJournal: 'desktop:journal:watch'`
  - `unwatchJournal: 'desktop:journal:unwatch'`
- `DESKTOP_EVENT_CHANNELS`:
  - `onJournalChanged: 'desktop:journal-changed'`

## 4. Visual Design System — 「纸 · 墨 · 黛」(Scoped strictly to `.journal-*`)

- **Light (宣纸)**:
  - desk `#E9E6DE` · canvas `#F5F3ED` · surface `#FFFDF9` · sunken `#EEEBE3`
  - line `#E2DED4` · line-strong `#CFC9BC`
  - ink-1 `#23221F` · ink-2 `#4F4C45` · ink-3 `#66625A`
  - semantic: dai `#3D5A73` / `#E7EEF3` (AI), amber `#875A10` / `#F6EBD7` (decision/sync), pine `#3A6B4F` / `#E3EEE6` (synced/done), cinnabar `#B03D2E` / `#F7E4E0` (error)
  - category tints: 身体 `#F4E7E0` · 事务/工作 `#E8EDEF` · 学习 `#ECEBDB` · 生活 `#F3ECDD` · 工程 `#E5EAE3` · 未归类 `#FFFDF9` + dashed border
- **Dark (夜墨)** (via `@media (prefers-color-scheme: dark)` or `[data-theme="dark"]`):
  - desk `#121211` · canvas `#1A1A18` · surface `#222220` · sunken `#171715`
  - ink-1 `#EDEAE3` · ink-2 `#B9B4AA` · ink-3 `#8E897F`
- **Layout**:
  - Top bar: `YYYY / MM` mono label | interactive 7-day week strip (selected day in `#23221F` dark pill, dot below days with entries, prev/next week arrows) | `日 / 周` segmented toggle
  - Day hero: large mono `MM.DD` (38px) + weekday + entry count | right status pills (e.g. `同步旧日记` button + `● 已就绪` / live sync feedback)
  - 12-column editorial scattered bento grid with 6 deterministic card species (`note`, `photo`, `thought`, `moment`, `ai`, `judgment`) — NO random decoration, NO torn-paper edges
  - Hover quick actions on cards: switch category, edit inline, delete (with confirmation), or click image for full-res Lightbox (Esc / backdrop / ✕ / arrows)
  - Sticky bottom quick composer: image thumbnails (`×` remove, `+` add), text input `"此刻，想记下什么？"`, toolbar (`图片` / `语音` using existing `window.desktop.startSpeechRecognition` if available / `@项目` picker from workspace projects / `#标签` / category selector), hint `"可粘贴或拖入图片 · ⌘↵ 记录"`, primary dark ink submit button `记录 ⌘↵`

## 5. Pre-Agreed TDD Seams Table

| Criterion | Seam (Public Boundary) | Test File |
| --- | --- | --- |
| C1 Plaintext round-trip & CRUD | `JournalStore` (`createEntry`, `getDay`, `getWeek`, `listDays`, `updateEntry`, `deleteEntry`, `readAttachment`) | `electron/journal-store.test.mjs` |
| C1 Security & atomic persistence | `JournalStore.readAttachment` rejects `../` traversal; `watchJournal` emits on external file write | `electron/journal-store.test.mjs` |
| C2 Read-only legacy SQLite sync | `syncLegacySentinelLabJournal(store, { dbPath })` against temp SQLite fixture (checks idempotency + zero mutation to source DB) | `electron/journal-legacy-sync.test.mjs` |
| C3 Feishu bridge side-tee | `scripts/sentinel-desk-append.mjs` CLI invocation + `sentinellab-bridge.sh` hook contract (idempotency, offline resilience, non-blocking) | `electron/journal-bridge-append.test.mjs` |
| C4 Pinned Module Slot & View Routing | `PINNED_MODULES`, `normalizeViewId`, `JournalPage` layout helpers (span classifier, week range builder, category/tag extraction) | `electron/journal-ui-logic.test.mjs` |
| C5 Repo-wide Seam / Style / i18n Regression | `desktop-seam.test.mjs`, `style-layering.test.mjs`, `ui-locale-keys.test.mjs`, `tsc` | Existing repo suites |
