/**
 * Frozen contract for SentinelDesk Outbound Studio (外宣工坊).
 *
 * Separates the "Solo AI Company" narrative into two strictly independent tracks:
 * 1. 日常切片 (Moments / Ship Log): 2-5 line candid snapshots for WeChat Moments / Jike / X.
 * 2. 公众号专栏 (WeChat Column): single-point deep-dive seeds -> anti-AI-slop full drafts.
 *
 * Hard privacy invariant:
 * - Private journal entries (`isPrivateJournalEntry`) and secrets (`scrubSecrets`) are
 *   physically stripped BEFORE prompt assembly or disk persistence.
 */

import type { ChatModelPick } from './claude-chat-types'

export const OUTBOUND_COLUMNS = [
  '折腾实录',
  '工作台拆解',
  '深读祛魅',
  '单品发布',
] as const
export type OutboundColumn = (typeof OUTBOUND_COLUMNS)[number]

export const OUTBOUND_MOMENT_ANGLES = [
  '上线一瞥',
  '幕后吐槽',
  '思考切片',
] as const
export type OutboundMomentAngle = (typeof OUTBOUND_MOMENT_ANGLES)[number]

export type OutboundSourceAnchor = {
  kind: 'journal' | 'commit'
  date: string
  refId: string
  label: string
}

export type OutboundMomentCard = {
  id: string
  angle: OutboundMomentAngle
  body: string
  mediaHint?: string
  anchors: OutboundSourceAnchor[]
  copiedAt?: string | null
}

export type OutboundArticleSeed = {
  id: string
  column: OutboundColumn
  title: string
  hook: string
  storyArc: string[]
  anchors: OutboundSourceAnchor[]
  draftId?: string | null
}

export type OutboundArticleDraft = {
  id: string
  seedId: string
  date: string
  column: OutboundColumn
  title: string
  altTitles: string[]
  markdown: string
  markdownPath: string
  modelUsed: string
  createdAt: string
  updatedAt: string
}

export type OutboundDayPack = {
  date: string
  moments: OutboundMomentCard[]
  seeds: OutboundArticleSeed[]
  scannedJournalEntries: number
  skippedPrivateEntries: number
  scannedCommits: number
  modelUsed: string
  generatedAt: string
}

export type OutboundConfig = {
  companyName: string
  authorPersona: string
  journalWindowDays: number
  commitWindowDays: number
  repoPaths: string[]
  antiAiRedlines: string
  modelPick?: ChatModelPick | null
}

export const OUTBOUND_DEFAULT_ANTI_AI_REDLINES =
  '禁用“赋能、闭环、抓手、数据飞轮、最后一块拼图、拒绝信息过载”等套话；一次只讲透一个具体痛点；短句单行成段（每段1-2句）；保留真实设备型号、报错细节、试错弯路与适度自嘲。'

export const OUTBOUND_DEFAULT_CONFIG: OutboundConfig = {
  companyName: 'SentinelDesk',
  authorPersona: '重度 AI 工具与量化实干派独立开发者',
  journalWindowDays: 5,
  commitWindowDays: 3,
  repoPaths: [],
  antiAiRedlines: OUTBOUND_DEFAULT_ANTI_AI_REDLINES,
  modelPick: null,
}

export type OutboundCalendarDay = {
  date: string
  momentCount: number
  seedCount: number
  draftCount: number
}

export type OutboundRunState = 'idle' | 'running' | 'drafting' | 'needs_config' | 'error'

export type OutboundOverview = {
  selectedDate: string
  todayDate: string
  runState: OutboundRunState
  runningDate: string | null
  draftingSeedId: string | null
  lastError: string | null
  modelConfigured: boolean
  providerName: string
  modelName: string
  config: OutboundConfig
  dayPack: OutboundDayPack | null
  drafts: OutboundArticleDraft[]
  calendarDays: OutboundCalendarDay[]
}

export type OutboundExtractResult = {
  ok: boolean
  date: string
  dayPack?: OutboundDayPack
  error?: string
}

export type OutboundDraftInput = {
  date: string
  seedId: string
  customAngle?: string
}

export type OutboundDraftResult = {
  ok: boolean
  draft?: OutboundArticleDraft
  error?: string
}

export type OutboundSaveDraftInput = {
  draftId: string
  title?: string
  markdown: string
}

export type OutboundChangedEvent = {
  reason: 'extracted' | 'drafted' | 'saved' | 'config'
  date: string
  at: string
}
