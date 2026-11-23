# Design: SentinelDesk 外语学习推送板块架构与 SentinelLab 资产复用

## 1. 数据流与隐私边界

```text
SentinelDesk/journal/YYYY/MM/YYYY-MM-DD.md
  │
  ▼ [1. 硬隐私过滤 + 脱敏]
  electron/desk/journal-privacy.ts (isPrivateJournalEntry + scrubSecrets)
  │  (私密条目 100% 截断，不入语料、不出卡)
  ▼ [2. 后台静默译文 & 词法抽取]
  electron/desk/language-push-analyzer.ts
  │  复用 ClaudeAgentSettingsStore + electron/anthropic-messages-client.ts
  │  输出：
  │   - 语料归档：~/VibeCoding/SentinelDesk/language/corpus/YYYY/MM/YYYY-MM-DD.json (前台不直接展示)
  │   - 候选词 & 语法点（附上下文例句 + 来源日记 entryId 锚点）
  ▼ [3. 门槛过滤 + 规范词归并 + SRS 调度]
  electron/desk/language-push-store.ts
  │  移植 SentinelLab vocabulary-review.ts 纯算法：
  │   - NFKC 规范词去重 (wordKey + readingKey)
  │   - 分级词表门槛过滤 (复用 SentinelLab wordlists.ts 分级规则)
  │   - 间隔重复序列：[1, 2, 4, 7, 15, 30] 天 (scheduleNext)
  │   - 每日新词硬上限 + 攒池顺延（防止复习量雪崩）
  ▼ [4. 极简互动卡片流]
  src/components/language-push/LanguagePushPage.tsx
     仅展示达门槛生词/语法卡 + 例句 + 朗读 + [已掌握 / 收藏强化 / 稍后再看]
```

## 2. SentinelLab 可直接复用的代码映射

| 能力 | SentinelLab 源文件 | 迁移到 AgentOS 的方式 |
|---|---|---|
| SRS 调度与复习间隔 | `apps/api/src/services/vocabulary-review.ts:51-68`（`REVIEW_INTERVAL_DAYS = [1, 2, 4, 7, 15, 30]`、`scheduleNext`、`NEW_WORD_DAILY_CAP`） | 纯函数零依赖直接移植进 `electron/desk/language-push-scheduler.ts` |
| 规范词去重与状态流转 | `vocabulary-review.ts:119-160`（NFKC 规范词归并、`manual` 收藏免门槛转正、`mastered` 整卡下线、`exposures` 曝光计数） | 去掉 `DbPool` SQL，改为本地原子 JSON 读写（同 `intent-todo-store.ts`） |
| 词频/等级过滤门槛 | `apps/api/src/services/wordlists.ts`（`en: 1500`、`ja: N3`、`ko: 1` 默认分级门槛） | 打包轻量化 JSON 词表或分级停用词集用于过滤基础高频词 |
| 发音预处理与例句增强 | `apps/api/src/services/tts.ts`（`normalizeTtsLanguage`、`prepareJapaneseTtsText`、`enrichVocabularyItem`） | MVP 复用文本清洗与 Prompt 结构，前端用 `window.speechSynthesis` / macOS `say` 零密钥朗读；V1.1 接可选云端 TTS |

## 3. 本地存储布局（Zero-DB）

全部落在 `~/VibeCoding/SentinelDesk/language/`（可随 `deskRoot` 迁移，不污染 AgentOS 安装目录）：

```text
~/VibeCoding/SentinelDesk/language/
├── config.json                     # 目标语种、难度门槛、每日上限、专属模型选择
├── deck.json                       # 规范词与语法卡状态（status: candidate | active | mastered, dueAt, exposures, pinned）
├── corpus/
│   └── YYYY/MM/YYYY-MM-DD.json     # 后台静默译文语料（含 entryId 锚点，绝不含私密条目，前台不整篇展示）
└── runs/
    └── YYYY-MM-DD.json             # 每日抽取跑批元信息（扫描条数、跳过私密数、新增卡数、耗时）
```

## 4. 严格遵守 `AGENTS.md` 上游同步护栏的模块划分

### 新增独立文件（不污染上游核心）
- 共享契约：`src/language-push-contract.ts`
- 主进程模块：
  - `electron/desk/language-push-scheduler.ts`（纯函数：SRS、去重、攒池队列排序）
  - `electron/desk/language-push-store.ts`（原子文件读写、语料归档与卡池管理）
  - `electron/desk/language-push-analyzer.ts`（硬隐私过滤 + 云端译文与高难词/语法 JSON 抽取）
  - `electron/desk/language-push-service.ts`（定时调度 `04:00 +08:00` 切日 + 手动运行 + 状态事件）
  - `electron/desk/language-push-ipc.ts`（独立 `registerLanguagePushIpc(ipcMain, getLanguagePushService)`）
- 渲染层模块：
  - `src/components/language-push/LanguagePushPage.tsx`
  - `src/components/language-push/LanguageCard.tsx`
  - `src/styles/language-push-page.css`（全 `lp-` 前缀隔离样式）
- 单元测试：
  - `electron/language-push-scheduler.test.mjs`
  - `electron/language-push-service.test.mjs`

### 宿主最小接线点（严格限 7 处小改动）
1. `electron/main.ts`：仅新增 1 行 lazy getter + 1 行 `registerLanguagePushIpc(ipcMain, getLanguagePushService)`（绝不平铺 handler）。
2. `electron/preload.ts` / `src/desktop-seam.ts` / `src/desktop-api.ts`：按分组新增 `languagePush` 命名空间 5 个通道（`getDeck` / `runToday` / `decideCard` / `getConfig` / `saveConfig`）。
3. `src/components/types.ts`：`AppViewId` 新增 `'language-push'`。
4. `src/components/pinned-modules.ts`：`PINNED_MODULES` 新增第 4 个插槽项。
5. `src/components/app-shell-constants.ts`：`VIEW_HEADING_KEYS` 与 `normalizeViewId` 注册 `'language-push'`。
6. `src/components/AppShellWorkspace.tsx`：`isDeskView` + `lazy` 挂载 `<LanguagePushPage />`。
7. `src/locales/{zh,en}.json`：补充 `languagePush.*` 与 `sidebar.pinnedLanguagePush` 键。

## 5. 卡片状态机与防雪崩规则

- **每日队列配额**：先排 `dueAt <= today` 的到期复习卡（最多占每日上限的 60%），再补高优先级收藏/新抽词汇卡与 1–2 张语法卡；未刷完的卡片留在池中按 `dueAt` 顺延，绝不因为三天没开就堆积 100 张压垮界面。
- **单卡动作**：
  - `master`（已掌握）→ `status = 'mastered'`，永久下线，后续抽取遇同规范词自动跳过。
  - `pin`（收藏强化）→ `pinned = true`，若为候选词立即转正并置顶复习。
  - `later`（稍后再看）→ `exposures += 1`，`dueAt = scheduleNext(exposures, today)`，移出今日待刷队列。
- **质量与成本护栏**：单日最多抽取最近 15 条非私密、长度 ≥ 12 字的有效日记（复用 `intent-todo` 同样的时间窗与 token 预算控制）；同一天重复点「立即生成」仅对未处理过的 `entryId` 增量抽取，幂等不重复造卡。
