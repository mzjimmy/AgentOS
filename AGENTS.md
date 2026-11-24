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

为控制本仓与上游 `upstream/main` 的合并冲突面，并避免重复造轮子，所有新增或修改 SentinelDesk 模块与项目挂载面板的任务必须遵守以下 8 条硬约束：

1. **新模块独立成目录，禁止继续扩写上游热文件**：新增 SentinelDesk 功能页优先采用独立新增目录（如 `src/components/<module>/`、`src/<module>-contract.ts`、`src/styles/<module>.css`、`electron/desk/<module>-*.ts`）。非必要不得继续扩写 `electron/main.ts`、`electron/preload.ts` 与 `src/desktop-seam.ts`。desk 主进程装配统一在 `sentinel-desk/main/mount.ts`（服务单例、IPC 注册、调度与生命周期），`electron/main.ts` 只保留 `mountAgentOSDesk(...)` 及 `start` / `observeProjectChatEvent` / `dispose` 调用；只有 `sentinel-desk/adapters/agentos/` 可以引用底座内部实现。
2. **宿主侧栏与路由仅走最小插槽**：新增顶层固定页仅允许触碰最小宿主接线点——`src/components/types.ts`（`AppViewId`）、`src/components/pinned-modules.ts`（`PINNED_MODULES`）、`src/components/app-shell-constants.ts`（`VIEW_HEADING_KEYS` / `normalizeViewId`）、`src/components/AppShellWorkspace.tsx`（`isDeskView` + `lazy` 挂载）及中英 `src/locales/{zh,en}.json`。
3. **边界由护栏自动检查，只许收紧**：`npm run test:electron` 会运行 `sentinel-desk/scripts/desk-boundary.mjs`（import 边界棘轮，清单 `sentinel-desk/boundary-allowlist.json`）与 `sentinel-desk/scripts/upstream-surface.mjs`（相对上游合并点的底座改动面预算，`sentinel-desk/upstream-surface.budget.json`，兼作 C 类 fork 补丁清单）。新增越界 import 或底座改动超预算即失败；需要放宽时必须在对应 JSON 里写明理由，禁止为过测试直接 `--write` 覆盖。`electron/desk/` 等旧位置暂不搬迁，留待专门的搬迁切片。
4. **普通挂载目录默认不自动生成面板（止损规则）**：项目列表支持挂载任意本地文件夹（含无 `package.json` 的纯文档/脚本/量化目录），默认直接以对话 + 文件树使用，**严禁为每个挂载目录自动生成或强行绑定独立图形面板**。
5. **需要可视化面板时复用现有 A2UI Home Plugin**：当且仅当某个项目确实需要长期概览、指标卡片或二层交互时，复用仓库既有的 `ProjectHomeSurface.tsx` + A2UI v0.9 Home Plugin（参考 `.agents/skills/a2ui-project-home-panel`）按需定制，禁止另起炉灶搭建第二套项目面板运行时。
6. **每轮代码改动必做「验证 → 重打 → 重启客户端」收尾**：在本仓任意一轮涉及渲染层或主进程代码变动的对话结束前，必须自动完成 `npm run typecheck` + 相关单元测试 + `npm run build:speech-cli && npx vite build && npx electron-builder --config electron-builder.config.cjs --mac --dir --publish never` + 退出旧进程并用 `ditto` 更新 `/Applications/AgentOS.app` + `open -a /Applications/AgentOS.app` 验证存活 PID，交付立即可测的最新桌面客户端（除非用户明确要求只改代码不打包重启）。
7. **UI 极简、单一控制入口与零冗余文案铁律（硬数字红线，防弱模型堆砌与配置外泄）**：
   - **Hero 零教学副标题**：页面主标题下默认 **0 句**功能介绍或原理说明（`lead` / `subtitle`）；仅允许日期、统计摘要与极简进度（≤ 16 字），**严禁**在 Hero 区裸露 `<select>`、输入框或开关，也禁止把既有静态信息胶囊改造成可交互表单控件。
   - **控件/弹窗默认零说明**：依靠清晰标签名自解释，默认 **0 行** `hint` / `helperText`；仅存在不可逆风险、隐私外发或隐蔽副作用时允许 1 句且 **≤ 18 个汉字**（英文 ≤ 12 词），禁止在常规文案里出现架构原理、历史重构说明、版本号或耗时毫秒数。
   - **胶囊硬上限**：顶栏统计区最多 **1 个**胶囊（多维计数用 `·` 合并为无边框次级文字）；单张卡片最多 **2 个**标签/胶囊，其余降级为普通文字或收进二级展开区。
   - **单一入口（Single Entry Point，禁止双处镜像）**：模型切换、分析引擎、定时开关、桥接地址、同步策略等低频配置统一收纳在齿轮设置弹窗 / Popover / Drawer 中，同一项配置在同一页面内只保留**一个**控制入口；需求未明示位置时先盘点现有设置弹窗并默认归入其中（拿不准先问用户，绝不两处都放）。
   - **交付前机械三问与死样式清理**：新增任意标签/文案前自查——①删掉后用户是否仍会用？②是否在复述标题/按钮意思？③是否只在改设置时才看？任一为“是”即删或挪入设置弹窗；替换/删除 UI 控件与文案时，必须同步移除无用 DOM 容器与死 CSS 规则。
8. **UI 变动必先交付「3–4 方案可交互预览」再动工（U0 门禁）**：凡涉及新增页面、布局结构调整、常驻条/播放器/侧栏/卡片位置变更等有视觉空间取舍的需求（不含已指定精确位置的单行小修），**严禁直接盲写生产代码并跑重型打包**；必须先基于真实主题色令牌（含用户当前深/浅色模式）、真实文案与可滚动视口，生成 3–4 种不同空间结构的**可交互切换 HTML 预览**（支持内联 `<agent-embed>` 时直接嵌入对话，否则落盘单文件 HTML 并打开浏览器），等用户回一个数字（`1–4`）选定方案后，再一次性完成 TDD 实现、打包替换与重启验收。

