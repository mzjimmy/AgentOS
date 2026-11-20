# OpenSpec Proposal: `chg-20261120-sentinel-desk-journal` — SentinelDesk 时间日记固定页与飞书双写桥接

## 1. Outcome Contract（目标契约）

```text
OUTCOME:     在现有 AgentOS 桌面端中以「插槽式固定默认页」追加「时间日记（Timeline Journal）」页面：
             支持暖纸「纸·墨·黛」散页排版、图文/语音低摩擦记录、明文落盘至 `/Users/sentinellab/VibeCoding/SentinelDesk/journal/`、
             一键只读同步旧 SentinelLab SQLite（1,143 条历史日记，绝不改动原库），并与现有飞书桥接脚本 `sentinellab-bridge.sh`
             实现无侵入旁路双写（发往原飞书群时，旧 SentinelLab 与新 AgentOS 两边同时入库），且零影响其他插件与既有功能。

CRITERIA:    C1 明文落盘与可逆读写：新记录与图片附件按 `SentinelDesk/journal/YYYY/MM/YYYY-MM-DD.md` + `attachments/YYYY/MM/`
                持久化，重启或外部编辑后解析无损，外部写入通过文件监听实时推送至界面。
             C2 幂等历史只读同步：从 `~/Library/Application Support/SentinelLab/sentinellab.db` 以只读模式导入全部历史
                `journal_entries`；重复触发 `imported === 0`（完全幂等）；原库行数与写状态零变更。
             C3 飞书原链路无侵入旁路双写：`scripts/sentinel-desk-append.mjs` 与 `sentinellab-bridge.sh` 旁路勾子对
                `record`/`auto` 模式幂等写入 `SentinelDesk/journal/`；即使 SentinelLab API 离线或 AgentOS 关闭均不丢单，
                且绝不干扰原有 `127.0.0.1:3001` 主链路与返回输出。
             C4 插槽式固定页架构与视觉美学：通过 `PinnedModuleRegistry` 挂载「时间日记」为侧栏顶部固定入口（默认启动页），
                采用「纸·墨·黛」浅/深色配色、周历条、`日/周` 切换、6 种有规则多态卡片（笔记/图片/随想/片刻/AI/判断）、
                图片粘贴/拖拽/灯箱、底部快记栏（支持 `@项目` / `#标签` / 本地语音）与「从旧库同步」入口。
             C5 零回归与不变量守卫：`npm run typecheck` 通过；所有新增 TDD 单元测试与集成测试全绿；既有 `desktop-seam`、
                `style-layering`、`ui-locale-keys` 与 500+ 既有 Electron 测试无新增失败；既有工作区/Runtime/MCP/Home Plugin 零破坏。

NON-GOALS:   本次不做外语语料、我的偏好、会话收尾卡自动化、Obsidian 导出、AI 自动分类后端调用、多用户或云同步；
             不重写现有项目聊天/Runtime 引擎；不修改旧 `sentinellab.db` 任何数据。

CONSTRAINTS: 1. 数据根目录默认 `/Users/sentinellab/VibeCoding/SentinelDesk`（支持环境变量与配置覆盖，绝不写进源码仓）。
             2. 所有新增 IPC 必须严格走 Desktop Seam（`src/desktop-api.ts` + `src/desktop-seam.ts` + `electron/preload.ts` + `electron/main.ts`）。
             3. 所有新增静态 `t('...')` 键必须同时写入 `src/locales/zh.json` 与 `src/locales/en.json`。
             4. 新增样式表 `src/styles/journal-page.css` 仅由懒加载组件 `JournalPage.tsx` 唯一引入，且全部使用 `.journal-*` 前缀以通过 `style-layering.test.mjs`。
             5. 严禁修改、暂存或回滚分支创建前工作区中既有的未提交文件（`ResizableRuntimePreview.tsx` 等）。
             6. 禁止提交到 `main` 或执行 `git push`；所有工作在分支 `feat/sentinel-desk-journal` 上进行。
```

## 2. Ground Truth & Pre-Dispatch Invariants（基线与不变量）

- **Branch**: `feat/sentinel-desk-journal` (branched from `main`)
- **Typecheck baseline**: `npm run typecheck` → **PASS (0 errors)**
- **Test baseline**: `npm run test:electron` → **504 total, 500 pass, 4 pre-existing failures** (`agent-context-home-skill.test.mjs:9`, `local-app-runtime.test.mjs:817`, `project-chat-pairing.test.mjs:13,18`)
- **Live DB invariant (`INVARIANT: live_db_readonly`)**:
  - Path: `/Users/sentinellab/Library/Application Support/SentinelLab/sentinellab.db`
  - Pre-work row counts: `journal_entries = 1143`, `user_facts = 0`, `user_preferences = 13`
  - Core safety fact (Level 5): AgentOS **never opens `sentinellab.db` for writing** (strictly `sqlite3 -readonly` / `mode=ro`).
- **Existing bridge invariant**:
  - Path: `/Users/sentinellab/AgentOS/SentinelLab/scripts/sentinellab-bridge.sh`
  - Backup created before any edit; primary `POST /api/bridge/inbound` behavior, stdout/stderr, and exit codes must remain byte-for-byte compatible.

## 3. Recorded Assumptions（记录的假设）

- `ASSUMED: startup_view` — options: (A) keep `'home'` as default when hash is empty / (B) default to `'journal'` when hash is empty, switching to `'home'` whenever user clicks any project, thread, or new-thread button. Took **(B)** per Notion spec ("打开 App 默认进时间日记的今天"). Reversible by 1-line default in `src/components/app-shell-constants.ts`.
- `ASSUMED: legacy_sqlite_reader` — options: (A) add native `better-sqlite3` dependency / (B) invoke macOS built-in `sqlite3 -readonly -json` via `execFile` (zero native ABI rebuild risk for Electron 30). Took **(B)** because zero new native dependency keeps Electron builds boring, fast, and 100% read-only enforced by SQLite CLI flag `-readonly`. Reversible inside `electron/desk/legacy-sync.ts`.
- `ASSUMED: bridge_dual_write_mechanism` — options: (A) run an HTTP server inside AgentOS Electron / (B) call a lightweight standalone Node script `scripts/sentinel-desk-append.mjs` directly from `sentinellab-bridge.sh` to append idempotently into `SentinelDesk/journal/YYYY/MM/YYYY-MM-DD.md`, while AgentOS watches the folder. Took **(B)** because it works **even when AgentOS is closed**, requires zero open network ports, and fails safely (`|| true`). Reversible in `sentinellab-bridge.sh`.
- `ASSUMED: tdd_seams` — Pre-agreed public seams in `design.md` §5 are confirmed by the lead coordinator per `outside-agent` unattended loop discipline and surfaced in the final delivery report.
- `ASSUMED: model_delegation` — Per user instruction ("ui界面要用审美好的模型例如hydrogen", "其他低一级别的模型来实施落库") and `AGENTS.md`:
  - `store-worker` (Core Markdown Store, Legacy Read-Only Sync, Desktop Seam IPC, Bridge Dual-Write & TDD tests) → pinned to `gemini-3.8-flash-high` (closest supported fast lower-tier model on platform).
  - `ui-worker` (Pinned Module Slot, "纸·墨·黛" Timeline Journal UI, Lightbox, Week View, Composer, i18n & UI tests) → pinned to `gemini-4-hydrogen-high` (user-requested Hydrogen high-aesthetic model).
  - Lead coordinator (OpenSpec, Wire Contract, Seam Alignment, Code Review & Full Verification) → current session model (`Gemini 4 Neon (High)`).

## 4. Runtime-Delta Inventory (R1)

| Delta | Headless / Node Test vs Shipped Electron Runtime | Verification Gate |
| --- | --- | --- |
| D1 Desktop Seam & Preload | Renderer calls `window.desktop.*` exposed via `preload.ts` | `electron/desktop-seam.test.mjs` + `npm run typecheck` |
| D2 Style Layering & Cascade | Lazy route CSS (`journal-page.css`) loads after `style.css` in Vite bundle | `electron/style-layering.test.mjs` + `vite build` |
| D3 Locale Catalog Completeness | Missing `t('...')` key renders raw key string in UI | `electron/ui-locale-keys.test.mjs` |
| D4 Image Attachment Display | Electron blocks arbitrary `file://` image paths across origins | `readJournalAttachment` returns validated `data:` URL scoped strictly under `<deskRoot>/journal/attachments/` (path-traversal tested) |
| D5 Live File Watch & External Bridge Write | External `sentinel-desk-append.mjs` writes to disk while app is open | Watcher emits `desktop:journal-changed` on external write; verified via automated integration test |
