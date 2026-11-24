/**
 * Frozen contract for SentinelDesk Morning Brief (每日早报板块).
 *
 * Design invariants:
 * - Default vertical focus: AI / Coding Agent / DevTools sources (modeled after 字节笔记本《每日AI早报》).
 * - Two-stage synthesis: parallel RSS/API fetch + URL dedup -> Top 10 curated stories + 5 backup stories
 *   so swapping an item (`换一条`) is instant without re-running the cloud LLM.
 * - Persists structured JSON (`<deskRoot>/briefings/issues/YYYY-MM-DD.json`) + WeChat-ready Markdown
 *   (`<deskRoot>/briefings/issues/YYYY-MM-DD.md`) + MiniMax HD TTS MP3 cache (`<deskRoot>/briefings/tts-cache/`).
 */

import type { ChatModelPick } from './claude-chat-types'

export const MORNING_BRIEF_CATEGORIES = [
  '模型与研究',
  'Coding Agent',
  '开源与工具',
  '产业与监管',
] as const
export type MorningBriefCategory = (typeof MORNING_BRIEF_CATEGORIES)[number]

export type MorningBriefSourceKind = 'rss' | 'hackernews' | 'huggingface_papers'

export type MorningBriefSourceConfig = {
  id: string
  name: string
  kind: MorningBriefSourceKind
  url: string
  enabled: boolean
  builtin?: boolean
}

export const MORNING_BRIEF_DEFAULT_SOURCES: readonly MorningBriefSourceConfig[] = [
  {
    id: 'openai-news',
    name: 'OpenAI News',
    kind: 'rss',
    url: 'https://openai.com/news/rss.xml',
    enabled: true,
    builtin: true,
  },
  {
    id: 'huggingface-papers',
    name: 'Hugging Face Papers',
    kind: 'huggingface_papers',
    url: 'https://huggingface.co/api/daily_papers',
    enabled: true,
    builtin: true,
  },
  {
    id: 'hackernews-ai',
    name: 'Hacker News · AI',
    kind: 'hackernews',
    url: 'https://hacker-news.firebaseio.com/v0/topstories.json',
    enabled: true,
    builtin: true,
  },
  {
    id: 'simon-willison',
    name: 'Simon Willison',
    kind: 'rss',
    url: 'https://simonwillison.net/atom/everything/',
    enabled: true,
    builtin: true,
  },
  {
    id: 'github-ai-blog',
    name: 'GitHub AI Blog',
    kind: 'rss',
    url: 'https://github.blog/ai-and-ml/feed/',
    enabled: true,
    builtin: true,
  },
  {
    id: 'latent-space',
    name: 'Latent Space',
    kind: 'rss',
    url: 'https://www.latent.space/feed',
    enabled: true,
    builtin: true,
  },
  {
    id: 'the-verge-ai',
    name: 'The Verge · AI',
    kind: 'rss',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    enabled: true,
    builtin: true,
  },
] as const

export type MorningBriefVoiceOption = {
  id: string
  label: string
}

export const MORNING_BRIEF_DEFAULT_TTS_MODEL = 'speech-2.8-hd'
export const MORNING_BRIEF_DEFAULT_VOICE_ZH = 'Chinese (Mandarin)_News_Anchor'

export const MORNING_BRIEF_VOICE_PRESETS: readonly MorningBriefVoiceOption[] = [
  { id: 'Chinese (Mandarin)_News_Anchor', label: '新闻主播（稳重清晰）' },
  { id: 'Chinese (Mandarin)_Radio_Host', label: '晨间电台（温和自然）' },
  { id: 'presenter_male', label: '青年男声（干脆利落）' },
  { id: 'presenter_female', label: '知性女声（轻快耐听）' },
] as const

export type MorningBriefConfig = {
  authorName: string
  issueTag: string
  itemCount: number
  scheduleHour: number
  autoRunEnabled: boolean
  speechRate: number
  ttsVoiceZh: string
  ttsModel: string
  sources: MorningBriefSourceConfig[]
  modelPick?: ChatModelPick | null
}

export const MORNING_BRIEF_DEFAULT_CONFIG: MorningBriefConfig = {
  authorName: 'SentinelDesk',
  issueTag: '#每日AI早报',
  itemCount: 10,
  scheduleHour: 7,
  autoRunEnabled: false,
  speechRate: 1.02,
  ttsVoiceZh: MORNING_BRIEF_DEFAULT_VOICE_ZH,
  ttsModel: MORNING_BRIEF_DEFAULT_TTS_MODEL,
  sources: MORNING_BRIEF_DEFAULT_SOURCES.map((item) => ({ ...item })),
  modelPick: null,
}

export type MorningBriefRawCandidate = {
  id: string
  title: string
  url: string
  sourceId: string
  sourceName: string
  summary: string
  publishedAt?: string
  score?: number
}

export type MorningBriefStoryItem = {
  id: string
  title: string
  body: string
  spokenText: string
  sourceName: string
  sourceUrl: string
  category: MorningBriefCategory
  publishedAt?: string
}

export type MorningBriefIssue = {
  date: string
  headlineDateLabel: string
  authorName: string
  issueTag: string
  readingMinutes: number
  leadSummary: string
  themes: string[]
  introParagraph: string
  items: MorningBriefStoryItem[]
  backupItems: MorningBriefStoryItem[]
  candidateCount: number
  sourceHitCount: number
  markdownPath: string
  stitchedAudioPath?: string | null
  modelUsed: string
  generatedAt: string
  updatedAt: string
}

export type MorningBriefCalendarDay = {
  date: string
  itemCount: number
  hasAudio: boolean
}

export type MorningBriefRunState = 'idle' | 'running' | 'needs_config' | 'error'

export type MorningBriefOverview = {
  selectedDate: string
  todayDate: string
  runState: MorningBriefRunState
  runningDate: string | null
  lastError: string | null
  modelConfigured: boolean
  ttsConfigured: boolean
  providerName: string
  modelName: string
  config: MorningBriefConfig
  issue: MorningBriefIssue | null
  calendarDays: MorningBriefCalendarDay[]
}

export type MorningBriefRunResult = {
  ok: boolean
  date: string
  issue?: MorningBriefIssue
  error?: string
}

export type MorningBriefSwapResult = {
  ok: boolean
  issue?: MorningBriefIssue
  error?: string
}

export type MorningBriefSpeakInput = {
  date: string
  sectionIndex?: number
  stitchFullIssue?: boolean
}

export type MorningBriefSpeakSegment = {
  sectionIndex: number
  label: string
  text: string
  audioBase64?: string
  mime?: string
}

export type MorningBriefSpeakResult =
  | {
      ok: true
      provider: 'minimax'
      segments: MorningBriefSpeakSegment[]
      stitchedAudioPath?: string | null
    }
  | {
      ok: false
      code: 'tts_not_configured' | 'tts_error'
      message: string
      segments: MorningBriefSpeakSegment[]
    }

export type MorningBriefChangedEvent = {
  reason: 'generated' | 'swapped' | 'config' | 'audio'
  date: string
  at: string
}
