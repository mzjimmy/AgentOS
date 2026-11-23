/**
 * SentinelDesk Language Push (外语学习推送板块).
 *
 * Strictly enforces the anti-bloat invariant:
 * - Background translated corpus is archived silently on disk only.
 * - Foreground presents ONLY threshold-filtered vocab & grammar interactive cards
 *   with 1-click feedback and zero-config offline Web Speech synthesis.
 */

import '../../styles/language-push-page.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT,
  CLAUDE_AGENT_SETTINGS_CHANGED_EVENT,
} from '../../app-events'
import type { ChatModelPick, ClaudeAgentSettingsSnapshot } from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { buildModelPickRows, modelPickFromRow, modelPickKey } from '../../model-pick'
import {
  LANGUAGE_PUSH_VOICE_PRESETS,
  type LanguagePushCard,
  type LanguagePushConfig,
  type LanguagePushDecisionAction,
  type LanguagePushEnLevel,
  type LanguagePushJaLevel,
  type LanguagePushLang,
  type LanguagePushOverview,
  type LanguagePushPronunciationHint,
} from '../../language-push-contract'
import { LanguageCard } from './LanguageCard'
import {
  playLanguagePushSpeech,
  prefetchLanguagePushSpeech,
  sleepCancellable,
  stopAllSpeech,
} from './speech-helper'

export type LanguagePushPageProps = {
  hidden?: boolean
  onNavigateToJournalAnchor?: (date: string, entryId: string) => void
  onOpenModelSettings?: () => void
}

type DeckTab = 'today' | 'backlog' | 'pinned' | 'mastered'
type LangFilter = 'all' | LanguagePushLang

export function LanguagePushPage({
  hidden = false,
  onNavigateToJournalAnchor,
  onOpenModelSettings,
}: LanguagePushPageProps) {
  const { t } = useI18n()
  const [overview, setOverview] = useState<LanguagePushOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [busyCardId, setBusyCardId] = useState<string | null>(null)
  const [tab, setTab] = useState<DeckTab>('today')
  const [langFilter, setLangFilter] = useState<LangFilter>('all')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const [playlistState, setPlaylistState] = useState<{
    activeCardId: string
    index: number
    total: number
  } | null>(null)
  const [claudeSettings, setClaudeSettings] = useState<ClaudeAgentSettingsSnapshot | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; message: string } | null>(null)
  const noticeTimerRef = useRef(0)
  const playbackGenRef = useRef(0)
  const cardElMapRef = useRef<Map<string, HTMLElement>>(new Map())

  useEffect(() => {
    let disposed = false
    const pullSettings = () => {
      void window.claudeChat
        ?.getSettings()
        .then((snap) => {
          if (!disposed && snap) setClaudeSettings(snap)
        })
        .catch(() => undefined)
    }
    pullSettings()
    window.addEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, pullSettings)
    window.addEventListener(CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT, pullSettings)
    return () => {
      disposed = true
      window.removeEventListener(CLAUDE_AGENT_SETTINGS_CHANGED_EVENT, pullSettings)
      window.removeEventListener(CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT, pullSettings)
    }
  }, [])

  const cloudModelRows = useMemo(() => {
    const providers = claudeSettings?.settings?.providers ?? []
    return buildModelPickRows(
      providers,
      {
        primary: t('intentTodo.modelSlotPrimary'),
        haiku: 'Haiku',
        sonnet: 'Sonnet',
        opus: 'Opus',
      },
      t('intentTodo.modelFallback'),
    )
  }, [claudeSettings, t])

  const providerNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of claudeSettings?.settings?.providers ?? []) {
      map.set(p.id, p.name?.trim() || p.id)
    }
    return map
  }, [claudeSettings])

  const showNotice = useCallback((tone: 'ok' | 'error', message: string) => {
    setNotice({ tone, message })
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3600)
  }, [])

  const loadOverview = useCallback(async () => {
    if (!window.desktop?.getLanguagePushOverview) {
      setLoading(false)
      return
    }
    try {
      const next = await window.desktop.getLanguagePushOverview()
      setOverview(next)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('languagePush.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [showNotice, t])

  const cancelPlayback = useCallback(() => {
    playbackGenRef.current += 1
    stopAllSpeech()
    setSpeakingKey(null)
    setPlaylistState(null)
  }, [])

  useEffect(() => {
    void loadOverview()
    const off = window.desktop?.onLanguagePushChanged?.(() => {
      void loadOverview()
    })
    return () => {
      off?.()
      playbackGenRef.current += 1
      stopAllSpeech()
      window.clearTimeout(noticeTimerRef.current)
    }
  }, [loadOverview])

  useEffect(() => {
    if (hidden) {
      cancelPlayback()
    }
  }, [hidden, cancelPlayback])

  const handleRunNow = async (force = false) => {
    if (!window.desktop?.runLanguagePush || running) return
    setRunning(true)
    try {
      const res = await window.desktop.runLanguagePush({ force })
      setOverview(res.overview)
      if (!res.ok) {
        showNotice('error', res.error || t('languagePush.runFailed'))
      } else {
        const stats = res.overview.lastRun?.stats
        if (stats && stats.addedCards > 0) {
          showNotice('ok', t('languagePush.runAdded', { count: stats.addedCards }))
        } else if (stats && stats.eligibleEntries === 0) {
          showNotice('ok', t('languagePush.runNoNewEntries'))
        } else {
          showNotice('ok', t('languagePush.runDone'))
        }
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('languagePush.runFailed'))
    } finally {
      setRunning(false)
    }
  }

  const handleDecide = async (cardId: string, action: LanguagePushDecisionAction) => {
    if (!window.desktop?.decideLanguagePushCard || busyCardId) return
    setBusyCardId(cardId)
    try {
      const res = await window.desktop.decideLanguagePushCard(cardId, action)
      setOverview(res.overview)
      if (action === 'master') showNotice('ok', t('languagePush.toastMastered'))
      else if (action === 'later') showNotice('ok', t('languagePush.toastDeferred'))
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('languagePush.actionFailed'))
    } finally {
      setBusyCardId(null)
    }
  }

  const handleSaveConfig = async (patch: Partial<LanguagePushConfig>) => {
    if (!window.desktop?.saveLanguagePushConfig) return
    try {
      await window.desktop.saveLanguagePushConfig(patch)
      await loadOverview()
      showNotice('ok', t('languagePush.configSaved'))
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('languagePush.configFailed'))
    }
  }

  const resolveVoiceId = useCallback(
    (lang: LanguagePushLang): string | undefined => {
      if (!overview?.config) return undefined
      return lang === 'ja' ? overview.config.ttsVoiceJa : overview.config.ttsVoiceEn
    },
    [overview?.config],
  )

  const handleSpeak = async (
    key: string,
    text: string,
    lang: LanguagePushLang,
    pronunciations?: LanguagePushPronunciationHint[],
  ) => {
    if (speakingKey === key && !playlistState) {
      cancelPlayback()
      return
    }
    cancelPlayback()
    const gen = playbackGenRef.current
    const isCancelled = () => playbackGenRef.current !== gen
    setSpeakingKey(key)

    const result = await playLanguagePushSpeech({
      text,
      lang,
      speed: overview?.config.speechRate ?? 0.95,
      voiceId: resolveVoiceId(lang),
      pronunciations,
      isCancelled,
    })

    if (!isCancelled()) {
      setSpeakingKey((cur) => (cur === key ? null : cur))
      if (result.outcome === 'error') {
        showNotice('error', result.fallbackReason || t('languagePush.speechFailed'))
      } else if (result.provider === 'offline' && result.fallbackReason) {
        showNotice('ok', t('languagePush.speechFallbackNotice'))
      }
    }
  }

  const handlePlayAllToday = async () => {
    if (playlistState) {
      cancelPlayback()
      return
    }
    const queue =
      tab === 'today'
        ? visibleCards
        : (overview?.todayCards ?? []).filter((c) => langFilter === 'all' || c.lang === langFilter)
    if (queue.length === 0) {
      showNotice('ok', t('languagePush.playAllEmpty'))
      return
    }

    cancelPlayback()
    const gen = playbackGenRef.current
    const isCancelled = () => playbackGenRef.current !== gen
    const rate = overview?.config.speechRate ?? 0.95
    let fallbackNotified = false

    for (let i = 0; i < queue.length; i += 1) {
      if (isCancelled()) break
      const card = queue[i]
      const hints =
        card.lang === 'ja'
          ? [
              ...(card.example.pronunciations ?? []),
              ...(card.reading ? [{ surface: card.surface, reading: card.reading }] : []),
            ]
          : undefined
      const voiceId = resolveVoiceId(card.lang)

      setPlaylistState({ activeCardId: card.id, index: i + 1, total: queue.length })
      const el = cardElMapRef.current.get(card.id)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

      // Warm disk cache for next card while current card is playing
      const nextCard = queue[i + 1]
      if (nextCard) {
        const nextHints =
          nextCard.lang === 'ja'
            ? [
                ...(nextCard.example.pronunciations ?? []),
                ...(nextCard.reading ? [{ surface: nextCard.surface, reading: nextCard.reading }] : []),
              ]
            : undefined
        const nextVoice = resolveVoiceId(nextCard.lang)
        prefetchLanguagePushSpeech({
          text: nextCard.surface,
          lang: nextCard.lang,
          speed: rate,
          voiceId: nextVoice,
          pronunciations: nextHints,
        })
        if (nextCard.example.sentence) {
          prefetchLanguagePushSpeech({
            text: nextCard.example.sentence,
            lang: nextCard.lang,
            speed: rate,
            voiceId: nextVoice,
            pronunciations: nextHints,
          })
        }
      }

      // 1. Speak term / grammar pattern
      setSpeakingKey(`${card.id}:term`)
      const termRes = await playLanguagePushSpeech({
        text: card.surface,
        lang: card.lang,
        speed: rate,
        voiceId,
        pronunciations: hints,
        isCancelled,
      })
      if (isCancelled()) break
      if (termRes.provider === 'offline' && !fallbackNotified && termRes.fallbackReason) {
        fallbackNotified = true
        showNotice('ok', t('languagePush.speechFallbackNotice'))
      }

      // 2. Natural brief pause before contextual diary example
      if (card.example.sentence) {
        const keepGoing = await sleepCancellable(420, isCancelled)
        if (!keepGoing) break
        setSpeakingKey(`${card.id}:example`)
        await playLanguagePushSpeech({
          text: card.example.sentence,
          lang: card.lang,
          speed: rate,
          voiceId,
          pronunciations: hints,
          isCancelled,
        })
        if (isCancelled()) break
      }

      // 3. Pause between cards
      if (i < queue.length - 1) {
        const keepGoing = await sleepCancellable(720, isCancelled)
        if (!keepGoing) break
      }
    }

    if (!isCancelled()) {
      setSpeakingKey(null)
      setPlaylistState(null)
      showNotice('ok', t('languagePush.playAllDone', { count: queue.length }))
    }
  }

  const visibleCards: LanguagePushCard[] = useMemo(() => {
    if (!overview) return []
    let base: LanguagePushCard[] = []
    if (tab === 'today') base = overview.todayCards
    else if (tab === 'backlog') base = overview.backlogCards
    else if (tab === 'pinned') {
      base = [...overview.todayCards, ...overview.backlogCards].filter((c) => c.pinned)
    } else {
      base = overview.masteredCards
    }
    if (langFilter === 'all') return base
    return base.filter((c) => c.lang === langFilter)
  }, [overview, tab, langFilter])

  const cfg = overview?.config
  const isBusy = running || overview?.runState === 'running'

  const toggleLang = (lang: LanguagePushLang) => {
    if (!cfg) return
    const exists = cfg.enabledLangs.includes(lang)
    if (exists && cfg.enabledLangs.length <= 1) return
    const next = exists ? cfg.enabledLangs.filter((l) => l !== lang) : [...cfg.enabledLangs, lang]
    void handleSaveConfig({ enabledLangs: next })
  }

  const updateDailyLimit = (limit: number) => {
    const grammar = limit <= 6 ? 1 : limit >= 12 ? 3 : 2
    const vocab = Math.max(1, limit - grammar)
    void handleSaveConfig({ dailyLimit: limit, dailyVocabLimit: vocab, dailyGrammarLimit: grammar })
  }

  return (
    <section
      className="desk-surface lp-page"
      hidden={hidden}
      aria-label={t('sidebar.pinnedLanguagePush')}
    >
      <header className="lp-header">
        <div className="lp-header-inner">
          <div className="lp-header-copy">
            <h1 className="lp-title">{t('shell.viewLanguagePush')}</h1>
            <p className="lp-lead">{t('languagePush.lead')}</p>
          </div>
          <div className="lp-header-actions">
            {overview ? (
              <div className="lp-stats-strip">
                <span className="lp-stat-pill">
                  {t('languagePush.statToday', {
                    count: overview.counts.todayTotal,
                    limit: overview.config.dailyLimit,
                  })}
                </span>
                <span className="lp-stat-pill lp-stat-muted">
                  {t('languagePush.statBreakdown', {
                    vocab: overview.counts.todayVocab,
                    grammar: overview.counts.todayGrammar,
                  })}
                </span>
                {overview.counts.corpusDaysCount > 0 ? (
                  <span className="lp-stat-pill lp-stat-muted">
                    {t('languagePush.statCorpusDays', { days: overview.counts.corpusDaysCount })}
                  </span>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className={playlistState ? 'lp-btn lp-btn-playing' : 'lp-btn'}
              disabled={!playlistState && (overview?.counts.todayTotal ?? 0) === 0}
              onClick={() => void handlePlayAllToday()}
            >
              <IconInline name={playlistState ? 'stop' : 'play'} />
              <span>
                {playlistState
                  ? t('languagePush.stopPlayAll', {
                      current: playlistState.index,
                      total: playlistState.total,
                    })
                  : t('languagePush.playAllToday')}
              </span>
            </button>
            <button
              type="button"
              className="lp-btn"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((prev) => !prev)}
            >
              <IconInline name="settings" />
              <span>{t('languagePush.settings')}</span>
            </button>
            <button
              type="button"
              className="lp-btn lp-btn-primary"
              disabled={isBusy}
              onClick={() => void handleRunNow(false)}
            >
              <IconInline name="refresh" />
              <span>{isBusy ? t('languagePush.running') : t('languagePush.runNow')}</span>
            </button>
          </div>
        </div>

        {overview && !overview.providerDisplay.configured ? (
          <div className="lp-banner lp-banner-warn">
            <span>{t('languagePush.needsModelConfig')}</span>
            {onOpenModelSettings ? (
              <button type="button" className="lp-btn" onClick={onOpenModelSettings}>
                {t('languagePush.openModelSettings')}
              </button>
            ) : null}
          </div>
        ) : overview?.runError ? (
          <div className="lp-banner lp-banner-error">
            <span>{overview.runError}</span>
          </div>
        ) : null}

        {settingsOpen && cfg ? (
          <div className="lp-settings-drawer">
            <div className="lp-setting-row">
              <span className="lp-setting-label">{t('languagePush.settingLangs')}</span>
              <div className="lp-setting-pills">
                <button
                  type="button"
                  className={cfg.enabledLangs.includes('en') ? 'lp-pill lp-pill-active' : 'lp-pill'}
                  onClick={() => toggleLang('en')}
                >
                  EN 英语
                </button>
                <button
                  type="button"
                  className={cfg.enabledLangs.includes('ja') ? 'lp-pill lp-pill-active' : 'lp-pill'}
                  onClick={() => toggleLang('ja')}
                >
                  JA 日语
                </button>
              </div>
            </div>

            <div className="lp-setting-row">
              <span className="lp-setting-label">{t('languagePush.settingDailyLimit')}</span>
              <div className="lp-setting-pills">
                {[6, 8, 10, 12].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={cfg.dailyLimit === n ? 'lp-pill lp-pill-active' : 'lp-pill'}
                    onClick={() => updateDailyLimit(n)}
                  >
                    {n} 张
                  </button>
                ))}
              </div>
            </div>

            <div className="lp-setting-row">
              <span className="lp-setting-label">{t('languagePush.settingThresholds')}</span>
              <div className="lp-setting-selects">
                <label className="lp-inline-select">
                  <span>EN</span>
                  <select
                    value={cfg.enLevel}
                    onChange={(e) => void handleSaveConfig({ enLevel: e.target.value as LanguagePushEnLevel })}
                  >
                    <option value="1500">1500+</option>
                    <option value="3000">3000+</option>
                    <option value="5000">5000+</option>
                  </select>
                </label>
                <label className="lp-inline-select">
                  <span>JA</span>
                  <select
                    value={cfg.jaLevel}
                    onChange={(e) => void handleSaveConfig({ jaLevel: e.target.value as LanguagePushJaLevel })}
                  >
                    <option value="N4">N4+</option>
                    <option value="N3">N3+</option>
                    <option value="N2">N2+</option>
                    <option value="N1">N1</option>
                  </select>
                </label>
                <label className="lp-inline-select">
                  <span>{t('languagePush.settingSpeechRate')}</span>
                  <select
                    value={String(cfg.speechRate)}
                    onChange={(e) => void handleSaveConfig({ speechRate: Number(e.target.value) })}
                  >
                    <option value="0.8">0.8x</option>
                    <option value="0.95">0.95x</option>
                    <option value="1.1">1.1x</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="lp-setting-row">
              <span className="lp-setting-label">
                {t('languagePush.settingVoices')}
                {overview?.providerDisplay.ttsConfigured ? ' · MiniMax HD' : ''}
              </span>
              <div className="lp-setting-selects">
                <label className="lp-inline-select">
                  <span>EN</span>
                  <select
                    value={cfg.ttsVoiceEn}
                    onChange={(e) => void handleSaveConfig({ ttsVoiceEn: e.target.value })}
                  >
                    {LANGUAGE_PUSH_VOICE_PRESETS.en.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}（{v.note}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="lp-inline-select">
                  <span>JA</span>
                  <select
                    value={cfg.ttsVoiceJa}
                    onChange={(e) => void handleSaveConfig({ ttsVoiceJa: e.target.value })}
                  >
                    {LANGUAGE_PUSH_VOICE_PRESETS.ja.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}（{v.note}）
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="lp-setting-row">
              <span className="lp-setting-label">{t('languagePush.settingMeta')}</span>
              <div className="lp-setting-meta">
                {cloudModelRows.length > 0 ? (
                  <label className="lp-inline-select">
                    <select
                      aria-label={t('languagePush.settingMeta')}
                      value={cfg.modelPick ? modelPickKey(cfg.modelPick) : ''}
                      onChange={(e) => {
                        const val = e.target.value
                        if (!val) {
                          void handleSaveConfig({ modelPick: null })
                          return
                        }
                        const row = cloudModelRows.find((r) => r.pickKey === val)
                        if (!row) return
                        const nextPick: ChatModelPick = modelPickFromRow(row)
                        void handleSaveConfig({ modelPick: nextPick })
                      }}
                    >
                      <option value="">
                        {t('languagePush.followGlobalModel', {
                          name: overview?.providerDisplay.modelName
                            ? `${overview.providerDisplay.providerName} · ${overview.providerDisplay.modelName}`
                            : overview?.providerDisplay.providerName || '',
                        })}
                      </option>
                      {cloudModelRows.map((row) => {
                        const pName = providerNameById.get(row.providerId) || row.providerId
                        return (
                          <option key={row.pickKey} value={row.pickKey}>
                            {pName} · {row.anthropicModelId}
                          </option>
                        )
                      })}
                    </select>
                  </label>
                ) : (
                  <span>
                    {overview?.providerDisplay.providerName}
                    {overview?.providerDisplay.modelName ? ` · ${overview.providerDisplay.modelName}` : ''}
                  </span>
                )}
                <button
                  type="button"
                  className="lp-mini-btn"
                  disabled={isBusy}
                  onClick={() => void handleRunNow(true)}
                >
                  {t('languagePush.forceReextract')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </header>

      <div className="lp-toolbar">
        <div className="lp-toolbar-inner">
          <div className="lp-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'today'}
              className={tab === 'today' ? 'lp-pill lp-pill-active' : 'lp-pill'}
              onClick={() => setTab('today')}
            >
              {t('languagePush.tabToday')} ({overview?.counts.todayTotal ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'backlog'}
              className={tab === 'backlog' ? 'lp-pill lp-pill-active' : 'lp-pill'}
              onClick={() => setTab('backlog')}
            >
              {t('languagePush.tabBacklog')} ({overview?.counts.backlogTotal ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'pinned'}
              className={tab === 'pinned' ? 'lp-pill lp-pill-active' : 'lp-pill'}
              onClick={() => setTab('pinned')}
            >
              {t('languagePush.tabPinned')} ({overview?.counts.pinnedTotal ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mastered'}
              className={tab === 'mastered' ? 'lp-pill lp-pill-active' : 'lp-pill'}
              onClick={() => setTab('mastered')}
            >
              {t('languagePush.tabMastered')} ({overview?.counts.masteredTotal ?? 0})
            </button>
          </div>

          <div className="lp-lang-filters" role="group" aria-label={t('languagePush.langFilterLabel')}>
            {(['all', 'en', 'ja'] as const).map((lf) => (
              <button
                key={lf}
                type="button"
                className={langFilter === lf ? 'lp-pill lp-pill-active' : 'lp-pill'}
                aria-pressed={langFilter === lf}
                onClick={() => setLangFilter(lf)}
              >
                {lf === 'all' ? t('languagePush.filterAll') : lf === 'en' ? 'EN 英语' : 'JA 日语'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="lp-scroll">
        <div className="lp-board">
          {loading ? (
            <div className="lp-empty">
              <p className="lp-empty-body">{t('languagePush.loading')}</p>
            </div>
          ) : visibleCards.length === 0 ? (
            <div className="lp-empty">
              <h2 className="lp-empty-title">
                {tab === 'today' && (overview?.counts.masteredTotal ?? 0) > 0
                  ? t('languagePush.todayDoneTitle')
                  : t('languagePush.emptyTitle')}
              </h2>
              <p className="lp-empty-body">
                {tab === 'today' ? t('languagePush.emptyTodayBody') : t('languagePush.emptyTabBody')}
              </p>
              {tab === 'today' ? (
                <button
                  type="button"
                  className="lp-btn lp-btn-primary"
                  disabled={isBusy}
                  onClick={() => void handleRunNow(false)}
                >
                  <IconInline name="refresh" />
                  <span>{isBusy ? t('languagePush.running') : t('languagePush.runNow')}</span>
                </button>
              ) : null}
            </div>
          ) : (
            <div className="lp-grid">
              {visibleCards.map((card) => (
                <LanguageCard
                  key={card.id}
                  card={card}
                  speakingKey={speakingKey}
                  isPlaylistActive={playlistState?.activeCardId === card.id}
                  busy={busyCardId === card.id}
                  cardRef={(el) => {
                    if (el) cardElMapRef.current.set(card.id, el)
                    else cardElMapRef.current.delete(card.id)
                  }}
                  onSpeak={(key, text, lang, hints) => void handleSpeak(key, text, lang, hints)}
                  onDecide={(id, action) => void handleDecide(id, action)}
                  onNavigateToJournalAnchor={onNavigateToJournalAnchor}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {notice ? (
        <div className={notice.tone === 'error' ? 'lp-toast lp-toast-error' : 'lp-toast lp-toast-ok'} role="status">
          <p className="lp-toast-text">{notice.message}</p>
          <button type="button" className="lp-mini-btn" onClick={() => setNotice(null)}>
            {t('languagePush.dismiss')}
          </button>
        </div>
      ) : null}
    </section>
  )
}
