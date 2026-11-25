/**
 * SentinelDesk Morning Brief (每日早报板块).
 *
 * Modeled after 字节笔记本《每日AI早报》:
 * - Zero instructional subtitles on the reading canvas.
 * - Editorial lead callout + 3-theme narrative intro + numbered stories with instant backup swap.
 * - Floating dark capsule audio player (MiniMax HD Mandarin TTS + automatic device speech fallback).
 * - Single gear modal housing all low-frequency settings (model, schedule, voice, vertical sources).
 */

import '../../styles/morning-brief-page.css'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT,
  CLAUDE_AGENT_SETTINGS_CHANGED_EVENT,
} from '../../app-events'
import type { ClaudeAgentSettingsSnapshot } from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { buildModelPickRows, modelPickFromRow, modelPickKey } from '../../model-pick'
import {
  MORNING_BRIEF_VOICE_PRESETS,
  type MorningBriefConfig,
  type MorningBriefIssue,
  type MorningBriefOverview,
  type MorningBriefSourceConfig,
} from '../../morning-brief-contract'
import { DeskAudioBar, DeskAudioStickyStrip, useDeskAudioSticky } from '../desk/DeskAudioBar'
import { computeDeskAudioProgressPct, formatDeskAudioClock } from '../desk/desk-audio-bar-contract'
import { DeskDatePageShell, DeskModalDialog } from '../desk/DeskDatePageShell'
import { useShanghaiToday } from '../desk/useShanghaiToday'
import { morningBriefAudioStore } from './morning-brief-audio-store'

export type MorningBriefPageProps = {
  hidden?: boolean
  onOpenModelSettings?: () => void
}

function buildCopyableWeChatMarkdown(issue: MorningBriefIssue): string {
  const lines: string[] = [
    `# 每日AI早报 · ${issue.headlineDateLabel}`,
    '',
    `> ${issue.leadSummary}`,
    '',
    `${issue.issueTag}`,
    '',
    issue.introParagraph,
    '',
  ]
  issue.items.forEach((item, idx) => {
    lines.push(`## ${idx + 1}. ${item.title}`)
    lines.push('')
    lines.push(item.body)
    lines.push('')
  })
  return lines.join('\n').trim() + '\n'
}

export function MorningBriefPage({ hidden = false, onOpenModelSettings }: MorningBriefPageProps) {
  const { t } = useI18n()
  const todayDate = useShanghaiToday()
  const [selectedDate, setSelectedDate] = useState(todayDate)
  const [overview, setOverview] = useState<MorningBriefOverview | null>(null)
  const [running, setRunning] = useState(false)
  const [swappingId, setSwappingId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draftConfig, setDraftConfig] = useState<MorningBriefConfig | null>(null)
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourceUrl, setNewSourceUrl] = useState('')
  const [claudeSettings, setClaudeSettings] = useState<ClaudeAgentSettingsSnapshot | null>(null)
  const [toast, setToast] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const audio = useSyncExternalStore(
    morningBriefAudioStore.subscribe,
    morningBriefAudioStore.getSnapshot,
  )

  const toastTimerRef = useRef(0)
  const storyElsRef = useRef<Map<number, HTMLElement>>(new Map())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inlinePlayerRef = useRef<HTMLDivElement | null>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const loadSeqRef = useRef(0)
  const selectedDateRef = useRef(selectedDate)
  selectedDateRef.current = selectedDate

  const showToast = useCallback((tone: 'ok' | 'error', text: string) => {
    setToast({ tone, text })
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  const loadOverview = useCallback(
    async (dateArg?: string) => {
      const target = dateArg ?? selectedDateRef.current
      if (!window.desktop?.getMorningBriefOverview) return
      const seq = ++loadSeqRef.current
      try {
        const next = await window.desktop.getMorningBriefOverview(target)
        if (seq !== loadSeqRef.current || selectedDateRef.current !== target) return
        setOverview(next)
      } catch (error) {
        if (seq !== loadSeqRef.current) return
        showToast('error', error instanceof Error ? error.message : '加载失败')
      }
    },
    [showToast],
  )

  useEffect(() => {
    void loadOverview(selectedDate)
  }, [selectedDate, loadOverview])

  useEffect(() => {
    const off = window.desktop?.onMorningBriefChanged?.(() => {
      void loadOverview(selectedDate)
    })
  return () => {
      off?.()
      window.clearTimeout(toastTimerRef.current)
    }
  }, [loadOverview, selectedDate])

  useEffect(() => {
    if (audio.error) {
      showToast('error', audio.error)
    }
  }, [audio.error, showToast])

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

  const calendarMarkers = useMemo(
    () =>
      (overview?.calendarDays ?? []).map((day) => ({
        date: day.date,
        hasActivity: day.itemCount > 0,
        allCleared: day.itemCount > 0,
      })),
    [overview?.calendarDays],
  )

  const calendarDateSet = useMemo(
    () => new Set((overview?.calendarDays ?? []).map((d) => d.date)),
    [overview?.calendarDays],
  )

  const issue = overview?.issue ?? null
  const isRunning = running || overview?.runState === 'running'
  const totalSections = issue ? issue.items.length + 1 : 0
  const isPlayingThisIssue = Boolean(issue && audio.issueDate === issue.date && audio.isPlaying)
  const activeSectionForIssue =
    issue && audio.issueDate === issue.date ? audio.activeSection : 0
  const elapsedForIssue =
    issue && audio.issueDate === issue.date ? audio.elapsedSec : 0
  const audioBusyForIssue = Boolean(issue && audio.issueDate === issue.date && audio.audioBusy)

  useEffect(() => {
    if (isPlayingThisIssue && activeSectionForIssue > 0) {
      storyElsRef.current.get(activeSectionForIssue)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    }
  }, [isPlayingThisIssue, activeSectionForIssue])

  const handleGenerate = async (force: boolean) => {
    if (!window.desktop?.runMorningBrief || isRunning) return
    morningBriefAudioStore.invalidateDate(selectedDate)
    setRunning(true)
    try {
      const res = await window.desktop.runMorningBrief({ date: selectedDate, force })
      if (!res.ok) {
        showToast('error', res.error || '生成失败')
      } else {
        await loadOverview(selectedDate)
      }
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : '生成失败')
    } finally {
      setRunning(false)
    }
  }

  const handleSwap = async (itemId: string) => {
    if (!window.desktop?.swapMorningBriefItem || !issue || swappingId) return
    morningBriefAudioStore.invalidateDate(issue.date)
    setSwappingId(itemId)
    try {
      const res = await window.desktop.swapMorningBriefItem(issue.date, itemId)
      if (!res.ok) {
        showToast('error', res.error || '替换失败')
      } else {
        await loadOverview(selectedDate)
        showToast('ok', t('morningBrief.swappedToast'))
      }
    } finally {
      setSwappingId(null)
    }
  }

  const handleCopyWeChat = async () => {
    if (!issue) return
    await navigator.clipboard.writeText(buildCopyableWeChatMarkdown(issue))
    showToast('ok', t('morningBrief.copiedWeChat'))
  }

  const playSegmentSequence = useCallback(
    async (startIdx: number) => {
      if (!issue) return
      await morningBriefAudioStore.play({
        date: issue.date,
        headlineDateLabel: issue.headlineDateLabel,
        totalSections: issue.items.length + 1,
        startSection: startIdx,
        onAudioStitched: () => {
          void loadOverview(issue.date)
        },
      })
    },
    [issue, loadOverview],
  )

  const openSettings = () => {
    if (!overview) return
    setDraftConfig({
      ...overview.config,
      sources: overview.config.sources.map((s) => ({ ...s })),
    })
    setSettingsOpen(true)
  }

  const handleSaveSettings = async () => {
    if (!draftConfig || !window.desktop?.saveMorningBriefConfig) return
    await window.desktop.saveMorningBriefConfig(draftConfig)
    setSettingsOpen(false)
    await loadOverview(selectedDate)
    showToast('ok', t('morningBrief.savedToast'))
  }

  const handleAddSource = () => {
    if (!draftConfig) return
    const name = newSourceName.trim()
    const url = newSourceUrl.trim()
    if (!name || !/^https?:\/\//i.test(url)) return
    const id = `custom-${Date.now().toString(36)}`
    const added: MorningBriefSourceConfig = {
      id,
      name,
      kind: 'rss',
      url,
      enabled: true,
      builtin: false,
    }
    setDraftConfig({
      ...draftConfig,
      sources: [...draftConfig.sources, added],
    })
    setNewSourceName('')
    setNewSourceUrl('')
  }

  const showStickyStrip = useDeskAudioSticky({
    scrollRef,
    anchorRef: inlinePlayerRef,
    active: Boolean(issue && (isPlayingThisIssue || audioBusyForIssue)),
    rebindKey: issue?.date ?? null,
  })

  const progressPct = computeDeskAudioProgressPct(activeSectionForIssue, totalSections)

  const audioLabels = useMemo(
    () => ({
      play: 'Play',
      pause: 'Pause',
      prev: t('morningBrief.playerPrev'),
      next: t('morningBrief.playerNext'),
      speed: t('morningBrief.settingSpeechRate'),
      loopOn: t('morningBrief.playerLoopOn'),
      loopOff: t('morningBrief.playerLoopOff'),
    }),
    [t],
  )

  const handleToggleAudioPlay = () => {
    if (isPlayingThisIssue) {
      morningBriefAudioStore.stop()
    } else {
      void playSegmentSequence(activeSectionForIssue)
    }
  }

  const audioExtraActions = issue?.stitchedAudioPath ? (
    <button
      type="button"
      className="desk-audio-extra-btn"
      onClick={() => void window.desktop?.showItemInFolder?.(issue.stitchedAudioPath!)}
    >
      {t('morningBrief.revealAudio')}
    </button>
  ) : null

  return (
    <DeskDatePageShell
      pageClassName="mb-page"
      hidden={hidden}
      testId="morning-brief-page"
      selectedDate={selectedDate}
      todayDate={todayDate}
      calendarMarkers={calendarMarkers}
      getDayState={(dateStr) => ({
        allCleared: calendarDateSet.has(dateStr),
      })}
      onSelectDate={(dateStr) => {
        setSelectedDate(dateStr)
      }}
      topbarRightSlot={
        <button
          type="button"
          className="mb-btn mb-btn--primary"
          disabled={isRunning}
          onClick={() => void handleGenerate(Boolean(issue))}
        >
          <IconInline name="refresh" />
          <span>
            {isRunning
              ? t('morningBrief.generating')
              : issue
                ? t('morningBrief.regenerate')
                : t('morningBrief.generate')}
          </span>
        </button>
      }
      heroMeta={
        issue
          ? t('morningBrief.statSummary', {
              candidates: issue.candidateCount,
              items: issue.items.length,
            })
          : undefined
      }
      heroRight={
        <>
          {issue ? (
            <button type="button" className="mb-btn" onClick={() => void handleCopyWeChat()}>
              <IconInline name="copy" />
              <span>{t('morningBrief.copyWeChat')}</span>
            </button>
          ) : null}
          <button
            ref={settingsTriggerRef}
            type="button"
            className="mb-btn mb-btn--icon"
            aria-label={t('morningBrief.settings')}
            title={t('morningBrief.settings')}
            onClick={openSettings}
          >
            <IconInline name="settings" />
          </button>
        </>
      }
      scrollRef={scrollRef}
      beforeScroll={
        toast ? (
          <div className={`mb-toast${toast.tone === 'error' ? ' is-error' : ''}`} role="status">
            {toast.text}
          </div>
        ) : null
      }
      stickyOverlay={
        issue ? (
          <DeskAudioStickyStrip
            visible={showStickyStrip}
            title={t('morningBrief.playerTitle', { date: issue.headlineDateLabel })}
            subtitle={
              audioBusyForIssue
                ? t('morningBrief.synthesizingAudio')
                : `${formatDeskAudioClock(elapsedForIssue)} · ${Math.min(totalSections, activeSectionForIssue + 1)}/${totalSections}`
            }
            isPlaying={isPlayingThisIssue}
            isBusy={audioBusyForIssue}
            progressPct={progressPct}
            playbackRate={audio.playbackRate}
            loop={audio.loop}
            canPrev={activeSectionForIssue > 0}
            canNext={activeSectionForIssue < totalSections - 1}
            onTogglePlay={handleToggleAudioPlay}
            onCycleSpeed={() => morningBriefAudioStore.cyclePlaybackRate()}
            onToggleLoop={() => morningBriefAudioStore.toggleLoop()}
            onPrev={() => void playSegmentSequence(Math.max(0, activeSectionForIssue - 1))}
            onNext={() =>
              void playSegmentSequence(Math.min(totalSections - 1, activeSectionForIssue + 1))
            }
            extraActions={audioExtraActions}
            labels={audioLabels}
            maxWidthPx={720}
            testId="morning-brief-sticky-strip"
          />
        ) : null
      }
      overlays={
        settingsOpen && draftConfig ? (
          <DeskModalDialog
            title={t('morningBrief.settings')}
            closeLabel={t('morningBrief.closeSettings')}
            triggerRef={settingsTriggerRef}
            onClose={() => setSettingsOpen(false)}
            footer={
              <>
                <button type="button" className="mb-btn" onClick={() => setSettingsOpen(false)}>
                  {t('morningBrief.closeSettings')}
                </button>
                <button
                  type="button"
                  className="mb-btn mb-btn--primary"
                  onClick={() => void handleSaveSettings()}
                >
                  {t('morningBrief.saveSettings')}
                </button>
              </>
            }
          >
              <div className="mb-field">
                <label className="mb-field-label">{t('morningBrief.settingModel')}</label>
                <select
                  className="mb-select"
                  value={draftConfig.modelPick ? modelPickKey(draftConfig.modelPick) : ''}
                  onChange={(e) => {
                    const key = e.target.value
                    const row = cloudModelRows.find((r) => r.pickKey === key)
                    setDraftConfig({
                      ...draftConfig,
                      modelPick: row ? modelPickFromRow(row) : null,
                    })
                  }}
                >
                  <option value="">
                    {t('languagePush.followGlobalModel', { name: overview?.modelName || 'Default' })}
                  </option>
                  {cloudModelRows.map((row) => (
                    <option key={row.pickKey} value={row.pickKey}>
                      {row.metaLine ? `${row.metaLine} · ${row.headline}` : row.headline}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-field-grid">
                <div className="mb-field">
                  <label className="mb-field-label">{t('morningBrief.settingAuthor')}</label>
                  <input
                    className="mb-input"
                    value={draftConfig.authorName}
                    onChange={(e) => setDraftConfig({ ...draftConfig, authorName: e.target.value })}
                  />
                </div>
                <div className="mb-field">
                  <label className="mb-field-label">{t('morningBrief.settingTag')}</label>
                  <input
                    className="mb-input"
                    value={draftConfig.issueTag}
                    onChange={(e) => setDraftConfig({ ...draftConfig, issueTag: e.target.value })}
                  />
                </div>
              </div>

              <div className="mb-field-grid">
                <div className="mb-field">
                  <label className="mb-field-label">{t('morningBrief.settingItemCount')}</label>
                  <input
                    type="number"
                    min={5}
                    max={12}
                    className="mb-input"
                    value={draftConfig.itemCount}
                    onChange={(e) =>
                      setDraftConfig({ ...draftConfig, itemCount: Number(e.target.value) || 10 })
                    }
                  />
                </div>
                <div className="mb-field">
                  <label className="mb-field-label">{t('morningBrief.settingScheduleHour')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label className="mb-inline-check">
                      <input
                        type="checkbox"
                        checked={draftConfig.autoRunEnabled}
                        onChange={(e) =>
                          setDraftConfig({ ...draftConfig, autoRunEnabled: e.target.checked })
                        }
                      />
                      <span>{t('morningBrief.settingAutoRun')}</span>
                    </label>
                    <input
                      type="time"
                      className="mb-input"
                      style={{ width: '96px' }}
                      value={`${String(draftConfig.scheduleHour).padStart(2, '0')}:${String(draftConfig.scheduleMinute ?? 0).padStart(2, '0')}`}
                      onChange={(e) => {
                        const [hRaw, mRaw] = e.target.value.split(':')
                        const parsedH = Number(hRaw)
                        const parsedM = Number(mRaw)
                        if (Number.isFinite(parsedH) && Number.isFinite(parsedM)) {
                          setDraftConfig({
                            ...draftConfig,
                            scheduleHour: Math.max(4, Math.min(23, Math.round(parsedH))),
                            scheduleMinute: Math.max(0, Math.min(59, Math.round(parsedM))),
                          })
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="mb-field">
                <label className="mb-field-label">{t('morningBrief.settingVoice')}</label>
                <select
                  className="mb-select"
                  value={draftConfig.ttsVoiceZh}
                  onChange={(e) => setDraftConfig({ ...draftConfig, ttsVoiceZh: e.target.value })}
                >
                  {MORNING_BRIEF_VOICE_PRESETS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-field">
                <label className="mb-field-label">{t('morningBrief.settingSources')}</label>
                <div className="mb-source-list">
                  {draftConfig.sources.map((src) => (
                    <div key={src.id} className="mb-source-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={src.enabled}
                          onChange={(e) =>
                            setDraftConfig({
                              ...draftConfig,
                              sources: draftConfig.sources.map((s) =>
                                s.id === src.id ? { ...s, enabled: e.target.checked } : s,
                              ),
                            })
                          }
                        />
                        <span>{src.name}</span>
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className="mb-source-url">{src.url}</span>
                        {!src.builtin ? (
                          <button
                            type="button"
                            className="mb-story-tool-btn"
                            onClick={() =>
                              setDraftConfig({
                                ...draftConfig,
                                sources: draftConfig.sources.filter((s) => s.id !== src.id),
                              })
                            }
                          >
                            {t('morningBrief.removeSource')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mb-source-add">
                  <input
                    className="mb-input"
                    placeholder={t('morningBrief.addSourceName')}
                    value={newSourceName}
                    onChange={(e) => setNewSourceName(e.target.value)}
                  />
                  <input
                    className="mb-input"
                    placeholder={t('morningBrief.addSourceUrl')}
                    value={newSourceUrl}
                    onChange={(e) => setNewSourceUrl(e.target.value)}
                  />
                  <button type="button" className="mb-btn" onClick={handleAddSource}>
                    {t('morningBrief.addSourceBtn')}
                  </button>
                </div>
              </div>
          </DeskModalDialog>
        ) : null
      }
    >
        {!overview?.modelConfigured && !issue ? (
          <div className="mb-empty">
            <p className="mb-empty-title">{t('morningBrief.needsModel')}</p>
            {onOpenModelSettings ? (
              <button type="button" className="mb-btn mb-btn--primary" onClick={onOpenModelSettings}>
                {t('morningBrief.openModelSettings')}
              </button>
            ) : null}
          </div>
        ) : issue ? (
          <article className="mb-sheet" data-testid="morning-brief-sheet">
            <h1 className="mb-headline">每日AI早报 · {issue.headlineDateLabel}</h1>

            <blockquote className="mb-lead-quote">{issue.leadSummary}</blockquote>

            <div className="mb-byline">
              <span className="mb-byline-author">{issue.authorName}</span>
              <span>·</span>
              <span>{t('morningBrief.readingMinutes', { minutes: issue.readingMinutes })}</span>
              <span>·</span>
              <span className="mb-byline-tag">{issue.issueTag}</span>
            </div>

            <DeskAudioBar
              barRef={inlinePlayerRef}
              variant="inset"
              className="mb-audio-bar"
              testId="morning-brief-player"
              loopTestId="morning-brief-loop-toggle"
              title={t('morningBrief.playerTitle', { date: issue.headlineDateLabel })}
              subtitle={
                audioBusyForIssue
                  ? t('morningBrief.synthesizingAudio')
                  : `${formatDeskAudioClock(elapsedForIssue)} · ${t('morningBrief.playerSection', {
                      current: Math.min(totalSections, activeSectionForIssue + 1),
                      total: totalSections,
                    })}`
              }
              isPlaying={isPlayingThisIssue}
              isBusy={audioBusyForIssue}
              playbackRate={audio.playbackRate}
              loop={audio.loop}
              canPrev={activeSectionForIssue > 0}
              canNext={activeSectionForIssue < totalSections - 1}
              onTogglePlay={handleToggleAudioPlay}
              onCycleSpeed={() => morningBriefAudioStore.cyclePlaybackRate()}
              onToggleLoop={() => morningBriefAudioStore.toggleLoop()}
              onPrev={() => void playSegmentSequence(Math.max(0, activeSectionForIssue - 1))}
              onNext={() =>
                void playSegmentSequence(Math.min(totalSections - 1, activeSectionForIssue + 1))
              }
              extraActions={audioExtraActions}
              labels={audioLabels}
            />

            <hr className="mb-divider" />

            <p className="mb-intro">{issue.introParagraph}</p>

            <div className="mb-stories">
              {issue.items.map((item, idx) => {
                const sectionNumber = idx + 1
                const speakingThis = isPlayingThisIssue && activeSectionForIssue === sectionNumber
  return (
                  <section
                    key={item.id}
                    ref={(el) => {
                      if (el) storyElsRef.current.set(sectionNumber, el)
                      else storyElsRef.current.delete(sectionNumber)
                    }}
                    className={`mb-story${speakingThis ? ' is-speaking' : ''}`}
                  >
                    <div className="mb-story-head">
                      <h2 className="mb-story-title">
                        {sectionNumber}. {item.title}
                      </h2>
                      <div className="mb-story-tools">
                        <button
                          type="button"
                          className="mb-story-tool-btn"
                          onClick={() => void playSegmentSequence(sectionNumber)}
                        >
                          <IconInline name="play" />
                          <span>{t('morningBrief.playSection')}</span>
                        </button>
                        {issue.backupItems.length > 0 ? (
                          <button
                            type="button"
                            className="mb-story-tool-btn"
                            disabled={swappingId === item.id}
                            onClick={() => void handleSwap(item.id)}
                          >
                            <IconInline name="refresh" />
                            <span>
                              {swappingId === item.id
                                ? t('morningBrief.swapping')
                                : t('morningBrief.swapItem')}
                            </span>
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <p className="mb-story-body">{item.body}</p>

                    <div className="mb-story-meta">
                      <span className="mb-story-cat">{item.category}</span>
                      <button
                        type="button"
                        className="mb-story-source"
                        onClick={() => void window.desktop?.openExternal?.(item.sourceUrl)}
                      >
                        <span>{item.sourceName}</span>
                        <IconInline name="externalLink" />
                      </button>
                    </div>
                  </section>
                )
              })}
            </div>
          </article>
        ) : (
          <div className="mb-empty">
            <p className="mb-empty-title">
              {isRunning ? t('morningBrief.generating') : t('morningBrief.emptyTitle')}
            </p>
            {overview?.runState === 'error' && overview.lastError ? (
              <p className="mb-empty-error">{overview.lastError}</p>
            ) : null}
            <button
              type="button"
              className="mb-btn mb-btn--primary"
              disabled={isRunning}
              onClick={() => void handleGenerate(true)}
            >
              {isRunning ? t('morningBrief.generating') : t('morningBrief.emptyAction')}
            </button>
          </div>
        )}
    </DeskDatePageShell>
  )
}
