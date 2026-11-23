# Tasks: SentinelDesk 外语学习推送板块（垂直切片 TDD 路线）

## Phase 1 · 契约与核心纯算法（无 UI、100% 离线可测）
- [x] **Slice 1.1**：冻结 `src/language-push-contract.ts`（卡型 `vocab | grammar`、状态机、每日队列配置、IPC 契约）。
- [x] **Slice 1.2**：实现 `electron/desk/language-push-scheduler.ts`（移植 SentinelLab `scheduleNext` `[1,2,4,7,15,30]`、NFKC 规范词去重、难度门槛过滤、防雪崩队列配额）+ `electron/language-push-scheduler.test.mjs` 全绿。
- [x] **Slice 1.3**：实现 `electron/desk/language-push-store.ts`（原子落盘 `deck.json` / `corpus/YYYY/MM/YYYY-MM-DD.json` / `runs/`，幂等跳过已处理 `entryId` 与已掌握词）。

## Phase 2 · 隐私过滤 + 云端抽取 + 独立 IPC
- [x] **Slice 2.1**：实现 `electron/desk/language-push-analyzer.ts`（强制先过 `isPrivateJournalEntry` + `scrubSecrets`，调用 `anthropic-messages-client.ts` 输出静默译文 + 达门槛词汇/语法 JSON）。
- [x] **Slice 2.2**：实现 `electron/desk/language-push-service.ts` 与 `electron/desk/language-push-ipc.ts`（独立注册函数，`main.ts` 仅加 1 行调用）+ `electron/language-push-service.test.mjs` 回归测试（含私密条目零泄漏断言）。

## Phase 3 · 极简互动卡片 UI（推荐交给 Gemini 4 Neon 打磨视觉）
- [x] **Slice 3.1**：实现 `src/components/language-push/LanguagePushPage.tsx`、`LanguageCard.tsx`、`speech-helper.ts`、`src/styles/language-push-page.css`（卡片流、离线朗读、3 键反馈、原日记日期锚点回跳、空态与配置抽屉）。
- [x] **Slice 3.2**：最小插槽接入 `PINNED_MODULES`、`AppShellWorkspace.tsx` 与中英 `locales`。
- [x] **Slice 3.3**：运行 `npm run typecheck` + 70/70 单元测试 + `vite build`（renderer / main / preload 全绿）。

## Phase 4 · V1.1 增量（MVP 跑顺后再评估）
- [ ] 可选接入云端高质量 TTS（复用 SentinelLab `tts.ts` 语音合成接口）；
- [ ] 支持按项目/场景标签筛选词汇卡，及从时间日记条目右键「划词入池」。
