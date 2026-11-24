/**
 * SentinelDesk Outbound Studio (外宣工坊).
 *
 * Separates the Solo AI Company narrative into two independent tracks:
 * - 日常切片 (Moments / Ship Log): 2-4 line candid snapshots for WeChat Moments / Jike.
 * - 公众号选题 & 已成稿 (WeChat Column): single-point deep-dive seeds -> anti-AI-slop drafts.
 *
 * Strictly adheres to the 5 UI minimalism rules: zero instructional subtitles,
 * <=1 badge per card, and a single gear modal for all low-frequency settings.
 */

import '../../styles/outbound-page.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CLAUDE_AGENT_MODEL_CATALOG_CHANGED_EVENT,
  CLAUDE_AGENT_SETTINGS_CHANGED_EVENT,
} from '../../app-events'
import type { ClaudeAgentSettingsSnapshot } from '../../claude-chat-types'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { buildModelPickRows, modelPickFromRow, modelPickKey } from '../../model-pick'
import type {
  OutboundArticleDraft,
  OutboundConfig,
  OutboundOverview,
  OutboundSourceAnchor,
} from '../../outbound-contract'
import { DeskDatePageShell, DeskModalDialog } from '../desk/DeskDatePageShell'
import { useShanghaiToday } from '../desk/useShanghaiToday'

export type OutboundPageProps = {
  hidden?: boolean
  onNavigateToJournalAnchor?: (date: string, entryId: string) => void
  onOpenModelSettings?: () => void
}

type OutboundTab = 'moments' | 'seeds' | 'drafts'

export function OutboundPage({
  hidden = false,
  onNavigateToJournalAnchor,
  onOpenModelSettings,
}: OutboundPageProps) {
  const { t } = useI18n()
  const todayDate = useShanghaiToday()
  const [selectedDate, setSelectedDate] = useState(todayDate)
  const [overview, setOverview] = useState<OutboundOverview | null>(null)
  const [tab, setTab] = useState<OutboundTab>('seeds')
  const [extracting, setExtracting] = useState(false)
  const [draftingSeedId, setDraftingSeedId] = useState<string | null>(null)
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [editorMarkdown, setEditorMarkdown] = useState('')
  const [rewriteAngle, setRewriteAngle] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draftConfig, setDraftConfig] = useState<OutboundConfig | null>(null)
  const [reposText, setReposText] = useState('')
  const [claudeSettings, setClaudeSettings] = useState<ClaudeAgentSettingsSnapshot | null>(null)
  const [toast, setToast] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const toastTimerRef = useRef(0)
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
      if (!window.desktop?.getOutboundOverview) return
      const seq = ++loadSeqRef.current
      try {
        const next = await window.desktop.getOutboundOverview(target)
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
    const off = window.desktop?.onOutboundChanged?.(() => {
      void loadOverview(selectedDate)
    })
    return () => {
      off?.()
      window.clearTimeout(toastTimerRef.current)
    }
  }, [loadOverview, selectedDate])

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

  const drafts = overview?.drafts ?? []
  const activeDraft: OutboundArticleDraft | null = useMemo(() => {
    if (drafts.length === 0) return null
    return drafts.find((d) => d.id === activeDraftId) ?? drafts[0]
  }, [drafts, activeDraftId])

  useEffect(() => {
    if (activeDraft) {
      setEditorMarkdown(activeDraft.markdown)
    }
  }, [activeDraft?.id, activeDraft?.updatedAt])

  const calendarMarkers = useMemo(
    () =>
      (overview?.calendarDays ?? []).map((d) => ({
        date: d.date,
        hasActivity: d.momentCount + d.seedCount > 0,
        allCleared: d.draftCount > 0,
      })),
    [overview?.calendarDays],
  )

  const calendarMap = useMemo(() => {
    const m = new Map<string, { hasDraft: boolean }>()
    for (const d of overview?.calendarDays ?? []) {
      m.set(d.date, { hasDraft: d.draftCount > 0 })
    }
    return m
  }, [overview?.calendarDays])

  const dayPack = overview?.dayPack ?? null
  const isExtracting = extracting || overview?.runState === 'running'
  const activeDraftingSeedId =
    draftingSeedId ?? (overview?.runState === 'drafting' ? overview.draftingSeedId : null)

  const handleExtract = async (force: boolean) => {
    if (!window.desktop?.extractOutboundPack || isExtracting) return
    setExtracting(true)
    try {
      const res = await window.desktop.extractOutboundPack({ date: selectedDate, force })
      if (!res.ok) {
        showToast('error', res.error || '提炼失败')
      } else {
        await loadOverview(selectedDate)
      }
    } finally {
      setExtracting(false)
    }
  }

  const handleGenerateDraft = async (date: string, seedId: string, customAngle?: string) => {
    if (!window.desktop?.generateOutboundDraft || activeDraftingSeedId) return
    setDraftingSeedId(seedId)
    try {
      const res = await window.desktop.generateOutboundDraft({ date, seedId, customAngle })
      if (!res.ok || !res.draft) {
        showToast('error', res.error || '成稿失败')
      } else {
        await loadOverview(selectedDate)
        setActiveDraftId(res.draft.id)
        setEditorMarkdown(res.draft.markdown)
        setRewriteAngle('')
        setTab('drafts')
      }
    } finally {
      setDraftingSeedId(null)
    }
  }

  const handleSaveDraft = async () => {
    if (!activeDraft || !window.desktop?.saveOutboundDraft) return
    const firstHeading = /^#\s+(.+)$/m.exec(editorMarkdown)?.[1]?.trim()
    const res = await window.desktop.saveOutboundDraft({
      draftId: activeDraft.id,
      title: firstHeading || activeDraft.title,
      markdown: editorMarkdown,
    })
    if (res.ok) {
      await loadOverview(selectedDate)
      showToast('ok', t('outbound.savedDraft'))
    } else {
      showToast('error', res.error || '保存失败')
    }
  }

  const handleAdoptAltTitle = (altTitle: string) => {
    if (!editorMarkdown) return
    const replaced = /^#\s+.+$/m.test(editorMarkdown)
      ? editorMarkdown.replace(/^#\s+.+$/m, `# ${altTitle}`)
      : `# ${altTitle}\n\n${editorMarkdown}`
    setEditorMarkdown(replaced)
  }

  const renderAnchors = (anchors: OutboundSourceAnchor[]) => {
    if (anchors.length === 0) return null
    return (
      <div className="ob-anchors">
        {anchors.map((a) =>
          a.kind === 'journal' && onNavigateToJournalAnchor ? (
            <button
              key={`${a.kind}:${a.refId}`}
              type="button"
              className="ob-anchor-link"
              onClick={() => onNavigateToJournalAnchor(a.date, a.refId)}
            >
              {a.label}
            </button>
          ) : (
            <span key={`${a.kind}:${a.refId}`} className="ob-anchor-link" style={{ cursor: 'default' }}>
              {a.label}
            </span>
          ),
        )}
      </div>
    )
  }

  const openSettings = () => {
    if (!overview) return
    setDraftConfig({ ...overview.config })
    setReposText(overview.config.repoPaths.join('\n'))
    setSettingsOpen(true)
  }

  const handleSaveSettings = async () => {
    if (!draftConfig || !window.desktop?.saveOutboundConfig) return
    const repoPaths = reposText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    await window.desktop.saveOutboundConfig({
      ...draftConfig,
      repoPaths,
    })
    setSettingsOpen(false)
    await loadOverview(selectedDate)
    showToast('ok', t('outbound.savedToast'))
  }

  return (
    <DeskDatePageShell
      pageClassName="ob-page"
      hidden={hidden}
      testId="outbound-page"
      selectedDate={selectedDate}
      todayDate={todayDate}
      disableFuture={true}
      calendarMarkers={calendarMarkers}
      getDayState={(dateStr) => {
        const hit = calendarMap.get(dateStr)
        return {
          allCleared: Boolean(hit?.hasDraft),
          hasActivity: Boolean(hit && !hit.hasDraft),
        }
      }}
      onSelectDate={setSelectedDate}
      topbarRightSlot={
        <button
          type="button"
          className="ob-btn ob-btn--primary"
          disabled={isExtracting}
          onClick={() => void handleExtract(Boolean(dayPack))}
        >
          <IconInline name="refresh" />
          <span>
            {isExtracting
              ? t('outbound.extracting')
              : dayPack
                ? t('outbound.reextract')
                : t('outbound.extract')}
          </span>
        </button>
      }
      heroMeta={
        dayPack
          ? t('outbound.statSummary', {
              moments: dayPack.moments.length,
              seeds: dayPack.seeds.length,
            })
          : undefined
      }
      heroRight={
        <button
          ref={settingsTriggerRef}
          type="button"
          className="ob-btn ob-btn--icon"
          aria-label={t('outbound.settings')}
          title={t('outbound.settings')}
          onClick={openSettings}
        >
          <IconInline name="settings" />
        </button>
      }
      beforeScroll={
        toast ? (
          <div className={`ob-toast${toast.tone === 'error' ? ' is-error' : ''}`} role="status">
            {toast.text}
          </div>
        ) : null
      }
      subbar={
        <div className="ob-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'moments'}
            className={`ob-tab${tab === 'moments' ? ' is-active' : ''}`}
            onClick={() => setTab('moments')}
          >
            {t('outbound.tabMoments')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'seeds'}
            className={`ob-tab${tab === 'seeds' ? ' is-active' : ''}`}
            onClick={() => setTab('seeds')}
          >
            {t('outbound.tabSeeds')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'drafts'}
            className={`ob-tab${tab === 'drafts' ? ' is-active' : ''}`}
            onClick={() => setTab('drafts')}
          >
            {t('outbound.tabDrafts', { count: drafts.length })}
          </button>
        </div>
      }
      overlays={
        settingsOpen && draftConfig ? (
          <DeskModalDialog
            title={t('outbound.settings')}
            closeLabel={t('outbound.closeSettings')}
            triggerRef={settingsTriggerRef}
            onClose={() => setSettingsOpen(false)}
            footer={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '12px' }}>
                <span className="ob-privacy-note">{t('outbound.privacyNote')}</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="ob-btn" onClick={() => setSettingsOpen(false)}>
                    {t('outbound.closeSettings')}
                  </button>
                  <button
                    type="button"
                    className="ob-btn ob-btn--primary"
                    onClick={() => void handleSaveSettings()}
                  >
                    {t('outbound.saveSettings')}
                  </button>
                </div>
              </div>
            }
          >
              <div className="ob-field">
                <label className="ob-field-label">{t('outbound.settingModel')}</label>
                <select
                  className="ob-select"
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

              <div className="ob-field-grid">
                <div className="ob-field">
                  <label className="ob-field-label">{t('outbound.settingCompany')}</label>
                  <input
                    className="ob-input"
                    value={draftConfig.companyName}
                    onChange={(e) => setDraftConfig({ ...draftConfig, companyName: e.target.value })}
                  />
                </div>
                <div className="ob-field">
                  <label className="ob-field-label">{t('outbound.settingPersona')}</label>
                  <input
                    className="ob-input"
                    value={draftConfig.authorPersona}
                    onChange={(e) =>
                      setDraftConfig({ ...draftConfig, authorPersona: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="ob-field-grid">
                <div className="ob-field">
                  <label className="ob-field-label">{t('outbound.settingJournalDays')}</label>
                  <input
                    type="number"
                    min={1}
                    max={14}
                    className="ob-input"
                    value={draftConfig.journalWindowDays}
                    onChange={(e) =>
                      setDraftConfig({
                        ...draftConfig,
                        journalWindowDays: Number(e.target.value) || 5,
                      })
                    }
                  />
                </div>
                <div className="ob-field">
                  <label className="ob-field-label">{t('outbound.settingCommitDays')}</label>
                  <input
                    type="number"
                    min={1}
                    max={14}
                    className="ob-input"
                    value={draftConfig.commitWindowDays}
                    onChange={(e) =>
                      setDraftConfig({
                        ...draftConfig,
                        commitWindowDays: Number(e.target.value) || 3,
                      })
                    }
                  />
                </div>
              </div>

              <div className="ob-field">
                <label className="ob-field-label">{t('outbound.settingRepos')}</label>
                <textarea
                  rows={3}
                  className="ob-small-textarea"
                  value={reposText}
                  onChange={(e) => setReposText(e.target.value)}
                />
              </div>

              <div className="ob-field">
                <label className="ob-field-label">{t('outbound.settingRedlines')}</label>
                <textarea
                  rows={3}
                  className="ob-small-textarea"
                  value={draftConfig.antiAiRedlines}
                  onChange={(e) =>
                    setDraftConfig({ ...draftConfig, antiAiRedlines: e.target.value })
                  }
                />
              </div>
          </DeskModalDialog>
        ) : null
      }
    >
          {tab === 'drafts' ? (
            activeDraft ? (
              <div className="ob-drafts-layout">
                <aside className="ob-draft-nav">
                  {drafts.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`ob-draft-nav-item${d.id === activeDraft.id ? ' is-active' : ''}`}
                      onClick={() => setActiveDraftId(d.id)}
                    >
                      <span className="ob-draft-nav-title">{d.title}</span>
                      <span className="ob-draft-nav-meta">
                        {d.date} · {d.column}
                      </span>
                    </button>
                  ))}
                </aside>

                <div className="ob-editor-card">
                  <div className="ob-editor-toolbar">
                    <span className="ob-pill">{activeDraft.column}</span>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="ob-btn"
                        onClick={() =>
                          void window.desktop?.showItemInFolder?.(activeDraft.markdownPath)
                        }
                      >
                        <IconInline name="folder" />
                        <span>{t('outbound.revealFile')}</span>
                      </button>
                      <button
                        type="button"
                        className="ob-btn"
                        onClick={async () => {
                          await navigator.clipboard.writeText(editorMarkdown)
                          showToast('ok', t('outbound.copiedMarkdown'))
                        }}
                      >
                        <IconInline name="copy" />
                        <span>{t('outbound.copyMarkdown')}</span>
                      </button>
                      <button
                        type="button"
                        className="ob-btn ob-btn--primary"
                        onClick={() => void handleSaveDraft()}
                      >
                        <IconInline name="save" />
                        <span>{t('outbound.saveDraft')}</span>
                      </button>
                    </div>
                  </div>

                  {activeDraft.altTitles.length > 0 ? (
                    <div className="ob-alt-titles">
                      {activeDraft.altTitles.map((alt) => (
                        <button
                          key={alt}
                          type="button"
                          className="ob-alt-btn"
                          onClick={() => handleAdoptAltTitle(alt)}
                        >
                          {alt}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <textarea
                    className="ob-textarea"
                    value={editorMarkdown}
                    onChange={(e) => setEditorMarkdown(e.target.value)}
                  />

                  <div className="ob-rewrite-bar">
                    <input
                      className="ob-input"
                      placeholder={t('outbound.customAnglePlaceholder')}
                      value={rewriteAngle}
                      onChange={(e) => setRewriteAngle(e.target.value)}
                    />
                    <button
                      type="button"
                      className="ob-btn"
                      disabled={Boolean(activeDraftingSeedId)}
                      onClick={() =>
                        void handleGenerateDraft(
                          activeDraft.date,
                          activeDraft.seedId,
                          rewriteAngle,
                        )
                      }
                    >
                      <IconInline name="refresh" />
                      <span>
                        {activeDraftingSeedId === activeDraft.seedId
                          ? t('outbound.drafting')
                          : t('outbound.regenerateDraft')}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ob-empty">
                <p className="ob-empty-title">{t('outbound.emptyDrafts')}</p>
              </div>
            )
          ) : !overview?.modelConfigured && !dayPack ? (
            <div className="ob-empty">
              <p className="ob-empty-title">{t('outbound.needsModel')}</p>
              {onOpenModelSettings ? (
                <button
                  type="button"
                  className="ob-btn ob-btn--primary"
                  onClick={onOpenModelSettings}
                >
                  {t('outbound.openModelSettings')}
                </button>
              ) : null}
            </div>
          ) : !dayPack ? (
            <div className="ob-empty">
              <p className="ob-empty-title">
                {isExtracting ? t('outbound.extracting') : t('outbound.emptyTitle')}
              </p>
              {overview?.runState === 'error' && overview.lastError ? (
                <p className="ob-empty-error">{overview.lastError}</p>
              ) : null}
              <button
                type="button"
                className="ob-btn ob-btn--primary"
                disabled={isExtracting}
                onClick={() => void handleExtract(true)}
              >
                {isExtracting ? t('outbound.extracting') : t('outbound.emptyAction')}
              </button>
            </div>
          ) : tab === 'moments' ? (
            <div className="ob-moments-grid">
              {dayPack.moments.map((m) => (
                <article key={m.id} className="ob-card">
                  <div className="ob-card-head">
                    <span className="ob-pill ob-pill--amber">{m.angle}</span>
                    <button
                      type="button"
                      className="ob-btn"
                      onClick={async () => {
                        await navigator.clipboard.writeText(m.body)
                        showToast('ok', t('outbound.copiedMoment'))
                      }}
                    >
                      <IconInline name="copy" />
                      <span>{t('outbound.copyMoment')}</span>
                    </button>
                  </div>

                  <p className="ob-moment-body">{m.body}</p>

                  {m.mediaHint ? <p className="ob-media-hint">配图：{m.mediaHint}</p> : null}

                  {renderAnchors(m.anchors)}
                </article>
              ))}
            </div>
          ) : (
            <div className="ob-seeds-list">
              {dayPack.seeds.map((seed) => {
                const existingDraft = seed.draftId
                  ? drafts.find((d) => d.id === seed.draftId)
                  : undefined
                const busy = activeDraftingSeedId === seed.id

                return (
                  <article key={seed.id} className="ob-card">
                    <div className="ob-card-head">
                      <span className="ob-pill">{seed.column}</span>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {existingDraft ? (
                          <button
                            type="button"
                            className="ob-btn"
                            onClick={() => {
                              setActiveDraftId(existingDraft.id)
                              setTab('drafts')
                            }}
                          >
                            <span>{t('outbound.openDraft')}</span>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="ob-btn ob-btn--primary"
                          disabled={Boolean(activeDraftingSeedId)}
                          onClick={() => void handleGenerateDraft(dayPack.date, seed.id)}
                        >
                          <IconInline name="compose" />
                          <span>
                            {busy ? t('outbound.drafting') : t('outbound.generateDraft')}
                          </span>
                        </button>
                      </div>
                    </div>

                    <h2 className="ob-seed-title">{seed.title}</h2>
                    <p className="ob-seed-hook">{seed.hook}</p>

                    {seed.storyArc.length > 0 ? (
                      <ol className="ob-seed-arc">
                        {seed.storyArc.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    ) : null}

                    {renderAnchors(seed.anchors)}
                  </article>
                )
              })}
            </div>
          )}
    </DeskDatePageShell>
  )
}
