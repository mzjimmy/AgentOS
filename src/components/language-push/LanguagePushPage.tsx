/**
 * SentinelDesk Language Push (外语学习推送板块).
 *
 * Foreground shows only threshold-filtered vocab and grammar cards.
 * Translated corpus stays on disk. Date chrome comes from DeskDatePageShell.
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
  LANGUAGE_PUSH_DEFAULT_CUTOVER_HOUR,
  LANGUAGE_PUSH_VOICE_PRESETS,
  type LanguagePushConfig,
  type LanguagePushDecisionAction,
  type LanguagePushEnLevel,
  type LanguagePushJaLevel,
  type LanguagePushLang,
  type LanguagePushOverview,
  type LanguagePushPronunciationHint,
} from '../../language-push-contract'
import { DeskDatePageShell, DeskModalDialog } from '../desk/DeskDatePageShell'
import { useShanghaiToday } from '../desk/useShanghaiToday'
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

type DeckTab = 'today' | 'backlog' | 'mastered'
type LangFilter = 'all' | LanguagePushLang

export function LanguagePushPage({
  hidden = false,
  onNavigateToJournalAnchor,
  onOpenModelSettings,
}: LanguagePushPageProps) {
  const { t } = useI18n()
  const [overview, setOverview] = useState<LanguagePushOverview | null>(null)
  const liveToday = useShanghaiToday({
    cutoverHour: overview?.config.cutoverHour ?? LANGUAGE_PUSH_DEFAULT_CUTOVER_HOUR,
  })
  const [selectedDate, setSelectedDate] = useState(liveToday)
  const [awaitingDate, setAwaitingDate] = useState<string | null>(liveToday)
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
  const loadSeqRef = useRef(0)
  const selectedDateRef = useRef(selectedDate)
  const datePinnedRef = useRef(false)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  selectedDateRef.current = selectedDate

  const todayDate =
    overview?.todayDate && overview.todayDate > liveToday ? overview.todayDate : liveToday
  const isViewingToday = selectedDate === todayDate
  const shown = overview && overview.selectedDate === selectedDate ? overview : null
  const deckPending = awaitingDate === selectedDate && !shown

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
    for (const provider of claudeSettings?.settings?.providers ?? []) {
      map.set(provider.id, provider.name?.trim() || provider.id)
    }
    return map
  }, [claudeSettings])

  const showNotice = useCallback((tone: 'ok' | 'error', message: string) => {
    setNotice({ tone, message })
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3600)
  }, [])

  const clearAwaiting = useCallback((requested: string) => {
    setAwaitingDate((current) => (current === requested ? null : current))
  }, [])

  const loadOverview = useCallback(
    async (date?: string) => {
      const requested = date ?? selectedDateRef.current
      const seq = ++loadSeqRef.current
      setAwaitingDate(requested)
      if (!window.desktop?.getLanguagePushOverview) {
        if (seq === loadSeqRef.current) clearAwaiting(requested)
        return
      }
      try {
        const next = await window.desktop.getLanguagePushOverview(requested)
        if (seq !== loadSeqRef.current || selectedDateRef.current !== requested) return
        setOverview(next)
      } catch (error) {
        if (seq !== loadSeqRef.current) return
        showNotice('error', error instanceof Error ? error.message : t('languagePush.loadFailed'))
      } finally {
        if (seq === loadSeqRef.current) clearAwaiting(requested)
      }
    },
    [clearAwaiting, showNotice, t],
  )

  const cancelPlayback = useCallback(() => {
    playbackGenRef.current += 1
    stopAllSpeech()
    setSpeakingKey(null)
    setPlaylistState(null)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  useEffect(() => {
    void loadOverview(selectedDateRef.current)
    const off = window.desktop?.onLanguagePushChanged?.(() => {
      void loadOverview(selectedDateRef.current)
    })
    return () => {
      off?.()
      playbackGenRef.current += 1
      stopAllSpeech()
      window.clearTimeout(noticeTimerRef.current)
    }
  }, [loadOverview])

  useEffect(() => {
    if (datePinnedRef.current) return
    const nextToday =
      overview?.todayDate && overview.todayDate > liveToday ? overview.todayDate : liveToday
    if (!nextToday || nextToday === selectedDateRef.current) return
    cancelPlayback()
    selectedDateRef.current = nextToday
    setSelectedDate(nextToday)
    void loadOverview(nextToday)
  }, [overview?.todayDate, liveToday, loadOverview, cancelPlayback])

  useEffect(() => {
    if (hidden) cancelPlayback()
  }, [hidden, cancelPlayback])

  const markerByDate = useMemo(() => {
    const map = new Map<string, NonNullable<LanguagePushOverview['calendarMarkers']>[number]>()
    for (const marker of overview?.calendarMarkers ?? []) map.set(marker.date, marker)
    return map
  }, [overview?.calendarMarkers])

  const calendarMarkers = useMemo(
    () =>
      (overview?.calendarMarkers ?? []).map((marker) => ({
        date: marker.date,
        hasActivity: true,
        count: marker.cardCount,
      })),
    [overview?.calendarMarkers],
  )

  const getDayState = useCallback(
    (dateStr: string) => {
      const marker = markerByDate.get(dateStr)
      return {
        hasActivity: Boolean(marker && (marker.cardCount > 0 || marker.hasRun || marker.hasCorpus)),
      }
    },
    [markerByDate],
  )

  const visibleCards = useMemo(() => {
    if (!shown) return []
    const base =
      tab === 'today' ? shown.todayCards : tab === 'backlog' ? shown.backlogCards : shown.masteredCards
    if (langFilter === 'all') return base
    return base.filter((card) => card.lang === langFilter)
  }, [shown, tab, langFilter])

  const playQueue = useMemo(() => {
    if (!shown) return []
    if (tab === 'today') return visibleCards
    return shown.todayCards.filter((card) => langFilter === 'all' || card.lang === langFilter)
  }, [shown, tab, visibleCards, langFilter])

  const heroMeta = useMemo(() => {
    if (!shown) return null
    const breakdown = t('languagePush.statBreakdown', {
      vocab: shown.counts.todayVocab,
      grammar: shown.counts.todayGrammar,
    })
    if (isViewingToday) {
      const parts = [
        t('languagePush.statToday', {
          count: shown.counts.todayTotal,
          limit: shown.config.dailyLimit,
        }),
        breakdown,
      ]
      if (shown.counts.corpusDaysCount > 0) {
        parts.push(t('languagePush.statCorpusDays', { days: shown.counts.corpusDaysCount }))
      }
      return parts.join(' · ')
    }
    return [t('languagePush.statArchive', { count: shown.counts.todayTotal }), breakdown].join(' · ')
  }, [shown, isViewingToday, t])

  const handleSelectDate = (nextDate: string) => {
    if (nextDate === selectedDateRef.current) return
    cancelPlayback()
    datePinnedRef.current = nextDate !== todayDate
    selectedDateRef.current = nextDate
    setSelectedDate(nextDate)
    void loadOverview(nextDate)
  }

  const handleRunNow = async (force = false) => {
    if (!window.desktop?.runLanguagePush || running) return
    const viewedDate = selectedDateRef.current
    setRunning(true)
    try {
      const res = await window.desktop.runLanguagePush({ date: viewedDate, force })
      if (selectedDateRef.current !== viewedDate) return
      if (!res.ok) {
        showNotice('error', res.error || t('languagePush.runFailed'))
      } else if (res.logicalDate === viewedDate) {
        if (res.overview?.selectedDate === viewedDate) {
          setOverview(res.overview)
        }
        const stats = res.overview.lastRun?.stats
        if (stats && stats.addedCards > 0) {
          showNotice('ok', t('languagePush.runAdded', { count: stats.addedCards }))
        } else if (stats && stats.eligibleEntries === 0) {
          showNotice('ok', t('languagePush.runNoNewEntries'))
        } else {
          showNotice('ok', t('languagePush.runDone'))
        }
      }
      await loadOverview(selectedDateRef.current)
    } catch (error) {
      if (selectedDateRef.current !== viewedDate) return
      showNotice('error', error instanceof Error ? error.message : t('languagePush.runFailed'))
    } finally {
      setRunning(false)
    }
  }

  const handleDecide = async (cardId: string, action: LanguagePushDecisionAction) => {
    if (!window.desktop?.decideLanguagePushCard || busyCardId) return
    const viewedDate = selectedDateRef.current
    const seqAtStart = loadSeqRef.current
    setBusyCardId(cardId)
    try {
      const res = await window.desktop.decideLanguagePushCard(cardId, action, viewedDate)
      if (selectedDateRef.current !== viewedDate) return
      if (loadSeqRef.current !== seqAtStart) {
        void loadOverview(viewedDate)
      } else if (res.overview?.selectedDate === viewedDate) {
        setOverview(res.overview)
      }
      if (action === 'familiar') showNotice('ok', t('languagePush.toastFamiliar'))
      else if (action === 'unfamiliar') showNotice('ok', t('languagePush.toastUnfamiliar'))
      else if (action === 'fuzzy') showNotice('ok', t('languagePush.toastFuzzy'))
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
      await loadOverview(selectedDateRef.current)
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
      setSpeakingKey((current) => (current === key ? null : current))
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
    const queue = playQueue
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
      cardElMapRef.current.get(card.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

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

  const cfg = overview?.config
  const isBusy = running || overview?.runState === 'running'
  const counts = shown?.counts

  const toggleLang = (lang: LanguagePushLang) => {
    if (!cfg) return
    const exists = cfg.enabledLangs.includes(lang)
    if (exists && cfg.enabledLangs.length <= 1) return
    const next = exists ? cfg.enabledLangs.filter((item) => item !== lang) : [...cfg.enabledLangs, lang]
    void handleSaveConfig({ enabledLangs: next })
  }

  const updateDailyLimit = (limit: number) => {
    const grammar = limit <= 6 ? 1 : limit >= 12 ? 3 : 2
    const vocab = Math.max(1, limit - grammar)
    void handleSaveConfig({ dailyLimit: limit, dailyVocabLimit: vocab, dailyGrammarLimit: grammar })
  }

  const todayTabLabel = isViewingToday ? t('languagePush.tabToday') : t('languagePush.tabDay')
  const runLabel = isBusy
    ? t('languagePush.running')
    : isViewingToday
      ? t('languagePush.runNow')
      : t('languagePush.extractDay')

  return (
    <DeskDatePageShell
      pageClassName="lp-page"
      hidden={hidden}
      ariaLabel={t('sidebar.pinnedLanguagePush')}
      selectedDate={selectedDate}
      todayDate={todayDate}
      disableFuture={true}
      calendarMarkers={calendarMarkers}
      getDayState={getDayState}
      onSelectDate={handleSelectDate}
      topbarRightSlot={
        <button
          type="button"
          className="desk-shell-btn desk-shell-btn--primary"
          disabled={isBusy}
          onClick={() => void handleRunNow(false)}
        >
          {runLabel}
        </button>
      }
      heroMeta={heroMeta}
      heroRight={
        <>
          <button
            type="button"
            className={playlistState ? 'desk-shell-btn lp-btn-playing' : 'desk-shell-btn'}
            disabled={!playlistState && playQueue.length === 0}
            onClick={() => void handlePlayAllToday()}
          >
            <IconInline name={playlistState ? 'stop' : 'play'} />
            <span>
              {playlistState
                ? t('languagePush.stopPlayAll', {
                    current: playlistState.index,
                    total: playlistState.total,
                  })
                : t('languagePush.playAll')}
            </span>
          </button>
          <button
            type="button"
            ref={settingsTriggerRef}
            className="desk-shell-btn desk-shell-btn--icon"
            aria-label={t('languagePush.settings')}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            disabled={!cfg}
            onClick={() => setSettingsOpen(true)}
          >
            <IconInline name="settings" />
          </button>
        </>
      }
      subbar={
        <>
          <div className="desk-shell-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'today'}
              className={tab === 'today' ? 'desk-shell-seg-btn is-active' : 'desk-shell-seg-btn'}
              onClick={() => setTab('today')}
            >
              {todayTabLabel} ({counts?.todayTotal ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'backlog'}
              className={tab === 'backlog' ? 'desk-shell-seg-btn is-active' : 'desk-shell-seg-btn'}
              onClick={() => setTab('backlog')}
            >
              {t('languagePush.tabBacklog')} ({counts?.backlogTotal ?? 0}/{counts?.backlogCap ?? cfg?.backlogCap ?? 40})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mastered'}
              className={tab === 'mastered' ? 'desk-shell-seg-btn is-active' : 'desk-shell-seg-btn'}
              onClick={() => setTab('mastered')}
            >
              {t('languagePush.tabMastered')} ({counts?.masteredTotal ?? 0})
            </button>
          </div>
          <div className="desk-shell-seg" role="group" aria-label={t('languagePush.langFilterLabel')}>
            {(['all', 'en', 'ja'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={langFilter === filter ? 'desk-shell-seg-btn is-active' : 'desk-shell-seg-btn'}
                aria-pressed={langFilter === filter}
                onClick={() => setLangFilter(filter)}
              >
                {filter === 'all' ? t('languagePush.filterAll') : filter === 'en' ? 'EN' : 'JA'}
              </button>
            ))}
          </div>
        </>
      }
      overlays={
        <>
          {settingsOpen && cfg ? (
            <DeskModalDialog
              title={t('languagePush.settings')}
              closeLabel={t('languagePush.closeSettings')}
              triggerRef={settingsTriggerRef}
              onClose={closeSettings}
            >
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
                      {[6, 8, 10, 12].map((count) => (
                        <button
                          key={count}
                          type="button"
                          className={cfg.dailyLimit === count ? 'lp-pill lp-pill-active' : 'lp-pill'}
                          onClick={() => updateDailyLimit(count)}
                        >
                          {count} 张
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
                          onChange={(event) =>
                            void handleSaveConfig({ enLevel: event.target.value as LanguagePushEnLevel })
                          }
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
                          onChange={(event) =>
                            void handleSaveConfig({ jaLevel: event.target.value as LanguagePushJaLevel })
                          }
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
                          onChange={(event) => void handleSaveConfig({ speechRate: Number(event.target.value) })}
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
                          onChange={(event) => void handleSaveConfig({ ttsVoiceEn: event.target.value })}
                        >
                          {LANGUAGE_PUSH_VOICE_PRESETS.en.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voice.label}（{voice.note}）
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="lp-inline-select">
                        <span>JA</span>
                        <select
                          value={cfg.ttsVoiceJa}
                          onChange={(event) => void handleSaveConfig({ ttsVoiceJa: event.target.value })}
                        >
                          {LANGUAGE_PUSH_VOICE_PRESETS.ja.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voice.label}（{voice.note}）
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

                  <div className="lp-setting-row">
                    <span className="lp-setting-label">{t('languagePush.settingCorpusPool')}</span>
                    <div className="lp-setting-selects">
                      <label className="lp-inline-select">
                        <span>{t('languagePush.settingCorpusWindow')}</span>
                        <select
                          value={String(cfg.corpusWindowDays)}
                          onChange={(event) =>
                            void handleSaveConfig({ corpusWindowDays: Number(event.target.value) })
                          }
                        >
                          <option value="7">7 天</option>
                          <option value="14">14 天</option>
                          <option value="30">30 天</option>
                        </select>
                      </label>
                      <label className="lp-inline-select">
                        <span>{t('languagePush.settingBacklogCap')}</span>
                        <select
                          value={String(cfg.backlogCap)}
                          onChange={(event) => void handleSaveConfig({ backlogCap: Number(event.target.value) })}
                        >
                          <option value="30">30 张</option>
                          <option value="40">40 张</option>
                          <option value="60">60 张</option>
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
                            onChange={(event) => {
                              const value = event.target.value
                              if (!value) {
                                void handleSaveConfig({ modelPick: null })
                                return
                              }
                              const row = cloudModelRows.find((item) => item.pickKey === value)
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
                              const providerName = providerNameById.get(row.providerId) || row.providerId
                              return (
                                <option key={row.pickKey} value={row.pickKey}>
                                  {providerName} · {row.anthropicModelId}
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
            </DeskModalDialog>
          ) : null}
          {notice ? (
            <div className={notice.tone === 'error' ? 'lp-toast lp-toast-error' : 'lp-toast lp-toast-ok'} role="status">
              <p className="lp-toast-text">{notice.message}</p>
              <button type="button" className="lp-mini-btn" onClick={() => setNotice(null)}>
                {t('languagePush.dismiss')}
              </button>
            </div>
          ) : null}
        </>
      }
    >
      {shown && !shown.providerDisplay.configured ? (
        <div className="lp-banner lp-banner-warn">
          <span>{t('languagePush.needsModelConfig')}</span>
          {onOpenModelSettings ? (
            <button type="button" className="lp-btn" onClick={onOpenModelSettings}>
              {t('languagePush.openModelSettings')}
            </button>
          ) : null}
        </div>
      ) : shown?.runError ? (
        <div className="lp-banner lp-banner-error">
          <span>{shown.runError}</span>
        </div>
      ) : null}

      {deckPending ? (
        <div className="lp-empty">
          <p className="lp-empty-body">{t('languagePush.loading')}</p>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="lp-empty">
          <h2 className="lp-empty-title">
            {tab === 'today' && isViewingToday && (counts?.masteredTotal ?? 0) > 0
              ? t('languagePush.todayDoneTitle')
              : t('languagePush.emptyTitle')}
          </h2>
          {tab === 'today' ? (
            <button
              type="button"
              className="lp-btn lp-btn-primary"
              disabled={isBusy}
              onClick={() => void handleRunNow(false)}
            >
              <IconInline name="refresh" />
              <span>{runLabel}</span>
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
              cardRef={(element) => {
                if (element) cardElMapRef.current.set(card.id, element)
                else cardElMapRef.current.delete(card.id)
              }}
              onSpeak={(key, text, lang, hints) => void handleSpeak(key, text, lang, hints)}
              onDecide={(id, action) => void handleDecide(id, action)}
              onNavigateToJournalAnchor={onNavigateToJournalAnchor}
            />
          ))}
        </div>
      )}
    </DeskDatePageShell>
  )
}
