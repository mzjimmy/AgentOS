# Work Packages & Verification Tasks: `chg-20261120-sentinel-desk-journal`

## Parallel Work Packages (Disjoint File Boundaries)

### WP1 — Core Store, Legacy Read-Only Sync, Bridge Dual-Write & Desktop Seam (`store-worker`, `gemini-3.8-flash-high`)
- **Owned files**:
  - `electron/desk/journal-markdown.ts`
  - `electron/desk/journal-store.ts`
  - `electron/desk/legacy-sync.ts`
  - `electron/desk/journal-ipc.ts`
  - `scripts/sentinel-desk-append.mjs`
  - `electron/journal-store.test.mjs`
  - `electron/journal-legacy-sync.test.mjs`
  - `electron/journal-bridge-append.test.mjs`
  - Seam registration edits ONLY in: `src/desktop-api.ts`, `src/desktop-seam.ts`, `electron/preload.ts`, `electron/main.ts`
- **Hard prohibitions**: Do NOT touch `src/components/*`, `src/styles/*`, `src/locales/*`, `src/journal-contract.ts`, pre-existing dirty files (`ResizableRuntimePreview.tsx`, etc.), or live `sentinellab.db`.
- **TDD slices (Red → Green vertical slices)**:
  1. `journal-markdown.ts` + `journal-store.ts`: create & read daily `.md` round-trip, idempotent `externalId` dedup, update & delete entry.
  2. Image attachment persistence under `journal/attachments/YYYY/MM/`, `readAttachment` dataUrl, and `../` path traversal rejection.
  3. `listJournalDays` & `getJournalWeek` summary/aggregation + `fs.watch` external write notification.
  4. `legacy-sync.ts`: read-only SQLite import from temp SQLite fixture, idempotency on second run, zero modification of source DB.
  5. `scripts/sentinel-desk-append.mjs`: CLI append + dedup + safe error handling.
  6. Wire Desktop Seam (`desktop-api.ts`, `desktop-seam.ts`, `preload.ts`, `main.ts`) and verify `desktop-seam.test.mjs` passes.

### WP2 — Pinned Module Slot & High-Aesthetic Timeline Journal UI (`ui-worker`, `gemini-4-hydrogen-high`)
- **Owned files**:
  - `src/components/pinned-modules.ts`
  - `src/components/journal/journal-ui-helpers.ts`
  - `src/components/journal/JournalPage.tsx`
  - `src/components/journal/JournalCard.tsx`
  - `src/components/journal/JournalWeekView.tsx`
  - `src/components/journal/JournalComposer.tsx`
  - `src/components/journal/JournalLightbox.tsx`
  - `src/styles/journal-page.css`
  - `electron/journal-ui-logic.test.mjs`
  - Slot wiring edits ONLY in: `src/components/types.ts`, `src/components/app-shell-constants.ts`, `src/components/AppShell.tsx`, `src/components/AppShellSidebar.tsx`, `src/components/AppShellWorkspace.tsx`, `src/icons.ts`, `src/locales/zh.json`, `src/locales/en.json`
- **Hard prohibitions**: Do NOT touch `electron/desk/*`, `electron/main.ts`, `electron/preload.ts`, `src/desktop-api.ts`, `src/desktop-seam.ts`, `src/journal-contract.ts`, `src/style.css`, or pre-existing dirty files.
- **TDD slices (Red → Green vertical slices)**:
  1. `pinned-modules.ts` & `journal-ui-helpers.ts`: week date math, 12-column card span classifier, inline `#tag`/`@project` parser, `normalizeViewId` for `'journal'`.
  2. `JournalCard.tsx` (6 species: note, photo, thought, moment, ai, judgment) + `JournalLightbox.tsx` (Esc, backdrop, ✕, arrow navigation).
  3. `JournalWeekView.tsx` (7 compact columns with image thumbnails) + `JournalComposer.tsx` (paste/drag images, file picker, voice input hook, `@project`, `#tag`, category pills, `⌘↵`).
  4. `JournalPage.tsx` + `src/styles/journal-page.css` (strict `.journal-*` classes, "纸·墨·黛" light & dark tokens, week strip, Day/Week toggle, legacy sync button & live reload on `onJournalChanged`).
  5. Wire Pinned Modules slot into `AppShellSidebar`, `AppShellWorkspace`, `AppShell`, `icons.ts`, and `locales/{zh,en}.json`.

### WP3 — Lead Integration, Bridge Hook & 4-Level Verification (Lead Coordinator)
- [x] Align seams after WP1 + WP2 finish; run `npm run typecheck` & `vite build` (caught & fixed 4 real defects: `---` inside prose splitting, Asia/Shanghai legacy timestamp & full-ID uniqueness, `fs.watch` debounce filename overwrite + ESM `mkdirSync`, and `AppShell.tsx` routing `discussJournalEntryInChat` through `window.projectChat` broker seam).
- [x] Add non-invasive side-tee hook to `/Users/sentinellab/AgentOS/SentinelLab/scripts/sentinellab-bridge.sh` (backup saved at `sentinellab-bridge.sh.backup-pre-sentinel-desk-20261120`) and verify end-to-end with loopback mock server (`3/3` pass).
- [x] Run full test suites: all 20 new TDD tests + `desktop-seam` + `style-layering` + `ui-locale-keys` + `window-chrome` + `project-chat-renderer` + full `npm run test:electron` (`520/524` pass vs `500/504` baseline — zero new failures).
- [x] Run live smoke verification: read-only sync against live `sentinellab.db` → `/Users/sentinellab/VibeCoding/SentinelDesk` (`1,143` entries across `172` days imported on Run 1; `0` imported / `1,143` skipped on Run 2; `sentinellab.db` size/mtime/row counts byte-for-byte unchanged).
- [x] Audit every new test (seam-aligned, non-tautological, no weakened existing tests) and commit cleanly on `feat/sentinel-desk-journal` without touching pre-existing dirty files.
