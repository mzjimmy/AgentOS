# 运行时模型选择

当创建 Codex Thread 或委派 subagent 时，必须按下表显式设置 `model` 与 `thinking`，不得依赖平台默认值或继承父任务的模型。

准备创建 Codex Thread 前，必须完整读取 [`.codex/docs/threads.md`](.codex/docs/threads.md)，并遵守其中的能力、独立性、持续价值、Work Order、所有权与停止条件。

| 工作 | 模型 | 推理档位 |
| --- | --- | --- |
| 协调 Thread | `gpt-5.6-sol` | `medium`；跨模块裁决密集时使用 `high` |
| 大范围仓库读取、来源扫描或候选归纳 | `gpt-5.6-terra` | `medium` |
| 产品/业务方案、复杂规格或跨模块设计 | `gpt-5.6-sol` | `high` |
| 普通模块实现 | `gpt-5.6-terra` | `medium`；复杂状态机或高风险时使用 `high` |
| 独立代码审查、复杂状态机审查或安全审查 | `gpt-5.6-sol` 或 `gpt-5.6-terra` | `high`；判断密度更高时选择 Sol |
| 机械转换、格式检查或分类 | `gpt-5.6-luna` | `medium`；分类需要非平凡判断时使用 `high` |

上述表格同时适用于两种执行形式：

- 创建 Codex Thread 时，在创建请求中带上选定的值。
- 委派 subagent 时，在委派请求中带上选定的值。

用户明确指定的模型或推理档位优先。当前平台不支持所选组合时，使用最接近的受支持组合，并报告降级情况。

---

# SentinelDesk 模块边界与面板选型护栏

为控制本仓与上游 `upstream/main` 的合并冲突面，并避免重复造轮子，所有新增或修改 SentinelDesk 模块与项目挂载面板的任务必须遵守以下 5 条硬约束：

1. **新模块独立成目录，禁止继续扩写上游热文件**：新增 SentinelDesk 功能页优先采用独立新增目录（如 `src/components/<module>/`、`src/<module>-contract.ts`、`src/styles/<module>.css`、`electron/desk/<module>-*.ts`）。非必要不得继续扩写 `electron/main.ts`、`electron/preload.ts` 与 `src/desktop-seam.ts`；若确需新增主进程 IPC，必须收口到 `electron/desk/` 独立注册函数，在 `electron/main.ts` 仅保留单行调用（禁止平铺手写一长串 `ipcMain.handle`）。
2. **宿主侧栏与路由仅走最小插槽**：新增顶层固定页仅允许触碰最小宿主接线点——`src/components/types.ts`（`AppViewId`）、`src/components/pinned-modules.ts`（`PINNED_MODULES`）、`src/components/app-shell-constants.ts`（`VIEW_HEADING_KEYS` / `normalizeViewId`）、`src/components/AppShellWorkspace.tsx`（`isDeskView` + `lazy` 挂载）及中英 `src/locales/{zh,en}.json`。
3. **现存代码先冻结边界、暂不贸然大搬迁**：已落地的 `journal` / `intent-todo` 代码保持稳定运行，不为“目录好看”做高风险全量搬迁；仅在触及相关文件或专门重构切片时，顺手把重复注册收口回 `electron/desk/`。
4. **普通挂载目录默认不自动生成面板（止损规则）**：项目列表支持挂载任意本地文件夹（含无 `package.json` 的纯文档/脚本/量化目录），默认直接以对话 + 文件树使用，**严禁为每个挂载目录自动生成或强行绑定独立图形面板**。
5. **需要可视化面板时复用现有 A2UI Home Plugin**：当且仅当某个项目确实需要长期概览、指标卡片或二层交互时，复用仓库既有的 `ProjectHomeSurface.tsx` + A2UI v0.9 Home Plugin（参考 `.agents/skills/a2ui-project-home-panel`）按需定制，禁止另起炉灶搭建第二套项目面板运行时。
6. **每轮代码改动必做「验证 → 重打 → 重启客户端」收尾**：在本仓任意一轮涉及渲染层或主进程代码变动的对话结束前，必须自动完成 `npm run typecheck` + 相关单元测试 + `npm run build:speech-cli && npx vite build && npx electron-builder --config electron-builder.config.cjs --mac --dir --publish never` + 退出旧进程并用 `ditto` 更新 `/Applications/AgentOS.app` + `open -a /Applications/AgentOS.app` 验证存活 PID，交付立即可测的最新桌面客户端（除非用户明确要求只改代码不打包重启）。

