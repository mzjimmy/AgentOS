# Proposal: SentinelDesk 每日早报（NewsAgent 固化）与外宣工坊（Outbound 双轨独立输出）

- **Change ID**: `chg-20261123-sentinel-desk-briefing-and-outbound`
- **Status**: `active`

## 1. 背景与目标

1. **每日早报（`morning-brief`）**：将旧 `NewsAgent-0.4-notion-feishu` 抽核去壳固化进 SentinelDesk，默认聚焦 AI / Coding Agent / 工具链垂直信源，生成对标字节笔记本《每日AI早报》的「一句话导读框 + 3 主题词综述 + 10 条大事 + MiniMax 语音版」，支持单条备选替换（`换一条`）与一键导出微信公众号格式。
2. **外宣工坊（`outbound`）**：把「用户 + SentinelDesk」作为一家 AI 原生一人公司，彻底分离 **日常切片（朋友圈 / 即刻 Ship Log）** 与 **公众号深度专栏（单点痛点故事 / 拆解）** 两条内容线；全程执行硬隐私隔离（`isPrivateJournalEntry` + `scrubSecrets`），内置去 AI 味写作约束。

## 2. 边界护栏

- 严格遵守 `AGENTS.md` 模块独立目录与最小宿主插槽原则，主进程 IPC 独立封装为 `registerMorningBriefIpc` 与 `registerOutboundIpc`。
- 严格执行 UI 极简 5 条数字红线（Hero 零教学副标题、表单零废话说明、胶囊上限、右上角单齿轮设置收纳全部低频配置）。
