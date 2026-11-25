/**
 * SentinelDesk 常用命令：本机 localStorage 提示词，支持目标项目选择与单命令默认目标，
 * 发给 Agent 后停留在当前页，并通过 toast 提供直达新对话入口。
 */

import '../../styles/quick-commands-page.css'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AgentCommandChannelError, sendAgentCommand } from '../../agent-command-channel'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { DEFAULT_SENTINEL_DESK_ROOT } from '../../journal-contract'
import {
  QUICK_COMMAND_CATEGORIES,
  type QuickCommandCategory,
  type QuickCommandDispatchInput,
  type QuickCommandDispatchResult,
  type QuickCommandItem,
  type QuickCommandStorageLike,
  type QuickCommandTarget,
  type ResolvedQuickCommandTarget,
} from '../../quick-commands-contract'
import type { WorkspaceProject } from '../types'
import {
  buildQuickCommandTargetOptions,
  copyQuickCommandText,
  createQuickCommand,
  deleteQuickCommand,
  filterAndSortQuickCommands,
  loadQuickCommands,
  loadQuickCommandsHeaderTarget,
  parseQuickCommandTargetKey,
  recordCommandUsageInStorage,
  resolveCommandSendState,
  resolveEffectiveQuickCommandTarget,
  saveQuickCommands,
  saveQuickCommandsHeaderTarget,
  serializeQuickCommandTargetKey,
  togglePinQuickCommand,
  updateQuickCommand,
} from './quick-commands-store'

export type QuickCommandsPageProps = {
  hidden?: boolean
  activeProject?: Pick<WorkspaceProject, 'id' | 'name' | 'path' | 'pathMissing'> | null
  projects?: readonly Pick<WorkspaceProject, 'id' | 'name' | 'path' | 'pathMissing'>[]
  onSendCommand?: (input: QuickCommandDispatchInput) => Promise<QuickCommandDispatchResult>
  onOpenDispatchedThread?: (projectId: string, threadId: string) => void
}

type EditorDraft = {
  mode: 'create' | 'edit'
  id?: string
  title: string
  body: string
  category: QuickCommandCategory
  defaultTargetKey: string
  pinned: boolean
}

type EditorError = 'blank_title' | 'blank_body'

type Notice = {
  id: number
  tone: 'ok' | 'error'
  message: string
  threadLink?: { projectId: string; threadId: string }
}

const BODY_CLAMP_CHARS = 140

function browserStorage(): QuickCommandStorageLike {
  return {
    getItem(key) {
      return window.localStorage.getItem(key)
    },
    setItem(key, value) {
      window.localStorage.setItem(key, value)
    },
  }
}

function bodyNeedsToggle(body: string): boolean {
  return body.split('\n').length > 5 || body.length > BODY_CLAMP_CHARS
}

function fallbackCopy(value: string): boolean {
  const prevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    if (prevFocused?.isConnected) prevFocused.focus()
  }
}

function failedSendReason(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('ok' in result)) return null
  if ((result as { ok?: unknown }).ok !== false) return null
  const reason = (result as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason.trim() : ''
}

function categoryLabel(t: (path: string) => string, category: QuickCommandCategory): string {
  switch (category) {
    case 'triage':
      return t('quickCommands.category.triage')
    case 'dev':
      return t('quickCommands.category.dev')
    case 'review':
      return t('quickCommands.category.review')
    case 'content':
      return t('quickCommands.category.content')
    default:
      return t('quickCommands.category.other')
  }
}

export function QuickCommandsPage({
  hidden = false,
  activeProject = null,
  projects = [],
  onSendCommand,
  onOpenDispatchedThread,
}: QuickCommandsPageProps) {
  const { t } = useI18n()
  const titleFieldId = useId()
  const bodyFieldId = useId()
  const categoryFieldId = useId()
  const targetFieldId = useId()
  const headerTargetSelectId = useId()
  const dialogTitleId = useId()
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const newBtnRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLFormElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const restoreFocusFrameRef = useRef(0)
  const commitRef = useRef<() => void>(() => {})
  const noticeTimerRef = useRef(0)
  const copiedTimerRef = useRef(0)
  const sendingLockRef = useRef(false)
  const mountedRef = useRef(true)
  const [items, setItems] = useState<QuickCommandItem[]>(() => loadQuickCommands(browserStorage()))
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [deskRoot, setDeskRoot] = useState<string>(DEFAULT_SENTINEL_DESK_ROOT)
  const [headerTarget, setHeaderTarget] = useState<QuickCommandTarget | null>(() => loadQuickCommandsHeaderTarget(browserStorage()))
  const [category, setCategory] = useState<QuickCommandCategory | 'all'>('all')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorDraft | null>(null)
  const [editorError, setEditorError] = useState<EditorError | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let active = true
    void window.desktop?.getJournalConfig?.()
      .then((cfg) => {
        if (active && cfg?.deskRoot?.trim()) setDeskRoot(cfg.deskRoot.trim())
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const deskLabel = t('quickCommands.targetDesk')
  const targetOptions = useMemo(
    () => buildQuickCommandTargetOptions(projects, { deskRoot, deskLabel }),
    [deskLabel, deskRoot, projects],
  )
  const resolvedHeaderTarget = useMemo(
    () => resolveEffectiveQuickCommandTarget({
      headerTarget,
      activeProject,
      projects,
      deskRoot,
      deskLabel,
    }),
    [activeProject, deskLabel, deskRoot, headerTarget, projects],
  )
  const fallbackSendState = resolveCommandSendState(activeProject)
  const canSend = onSendCommand ? true : fallbackSendState.canSend
  const visible = useMemo(
    () => filterAndSortQuickCommands(items, { category, query }),
    [items, category, query],
  )
  const filtersActive = category !== 'all' || query.trim().length > 0

  const showNotice = useCallback((
    tone: Notice['tone'],
    message: string,
    threadLink?: { projectId: string; threadId: string },
  ) => {
    if (!mountedRef.current) return
    const id = Date.now()
    setNotice({ id, tone, message, threadLink })
    window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return
      setNotice((current) => (current?.id === id ? null : current))
    }, threadLink ? 5600 : 3600)
  }, [])

  const persist = useCallback((next: QuickCommandItem[]) => {
    itemsRef.current = next
    setItems(next)
    const saved = saveQuickCommands(browserStorage(), next)
    if (!saved) {
      showNotice('error', t('quickCommands.saveFailed'))
    }
    return saved
  }, [showNotice, t])

  const closeEditor = useCallback(() => {
    setEditor(null)
    setEditorError(null)
    const target = restoreFocusRef.current
    restoreFocusRef.current = null
    window.cancelAnimationFrame(restoreFocusFrameRef.current)
    restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
      if (!mountedRef.current) return
      if (target?.isConnected) {
        target.focus()
      } else if (newBtnRef.current?.isConnected) {
        newBtnRef.current.focus()
      }
    })
  }, [])

  const commitEditor = useCallback(() => {
    if (!editor) return
    const input = {
      title: editor.title,
      body: editor.body,
      category: editor.category,
      defaultTarget: parseQuickCommandTargetKey(editor.defaultTargetKey),
      pinned: editor.pinned,
    }
    const currentItems = itemsRef.current
    const result = editor.mode === 'edit' && editor.id
      ? updateQuickCommand(currentItems, editor.id, input)
      : createQuickCommand(currentItems, input)
    if (!result.ok) {
      if (result.reason === 'blank_body') setEditorError('blank_body')
      else if (result.reason === 'blank_title') setEditorError('blank_title')
      else closeEditor()
      return
    }
    persist(result.items)
    closeEditor()
  }, [closeEditor, editor, persist])

  commitRef.current = commitEditor
  // Key the listener off open/closed. Depending on the whole draft would
  // refocus the title field on every keystroke.
  const editorOpen = editor !== null

  useEffect(() => {
    if (!editorOpen) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      // Yield to any higher-layer global search modal if opened via shortcut.
      if (document.querySelector('.app-search-modal')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeEditor()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        event.stopPropagation()
        commitRef.current()
        return
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )]
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (event.shiftKey) {
          if (active === first || !dialogRef.current.contains(active)) {
            event.preventDefault()
            last.focus()
          }
        } else if (active === last || !dialogRef.current.contains(active)) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    const frame = window.requestAnimationFrame(() => titleInputRef.current?.focus())
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.cancelAnimationFrame(frame)
    }
  }, [closeEditor, editorOpen])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      window.clearTimeout(noticeTimerRef.current)
      window.clearTimeout(copiedTimerRef.current)
      window.cancelAnimationFrame(restoreFocusFrameRef.current)
    }
  }, [])

  const openEditor = (draft: EditorDraft, trigger: HTMLElement) => {
    window.cancelAnimationFrame(restoreFocusFrameRef.current)
    restoreFocusRef.current = trigger
    setConfirmDeleteId(null)
    setEditorError(null)
    setEditor(draft)
  }

  const patchEditor = (patch: Partial<EditorDraft>) => {
    setEditorError(null)
    setEditor((current) => (current ? { ...current, ...patch } : current))
  }

  const copyItem = async (item: QuickCommandItem) => {
    const result = await copyQuickCommandText(item.body, {
      writeText: async (value) => {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable')
        await navigator.clipboard.writeText(value)
      },
      fallbackWrite: fallbackCopy,
    })
    if (!mountedRef.current) return
    if (!result.ok) {
      showNotice('error', t('quickCommands.copyFailed'))
      return
    }
    setCopiedId(item.id)
    window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return
      setCopiedId((current) => (current === item.id ? null : current))
    }, 1600)
  }

  const handleHeaderTargetChange = (value: string) => {
    const parsed = parseQuickCommandTargetKey(value)
    if (!parsed) return
    setHeaderTarget(parsed)
    saveQuickCommandsHeaderTarget(browserStorage(), parsed)
  }

  const sendItem = async (item: QuickCommandItem, resolvedTarget: ResolvedQuickCommandTarget) => {
    if (!canSend || sendingLockRef.current) return
    sendingLockRef.current = true
    setSendingId(item.id)
    setNotice(null)
    try {
      let sentProjectId = ''
      let sentProjectName = resolvedTarget.label
      let sentThreadId = ''
      if (onSendCommand) {
        const res = await onSendCommand({
          title: item.title,
          body: item.body,
          target: resolvedTarget.target,
        })
        if (!res.ok) {
          showNotice('error', res.error || t('quickCommands.sendFailed'))
          return
        }
        sentProjectId = res.projectId
        sentProjectName = res.projectName
        sentThreadId = res.threadId
      } else {
        const targetName = fallbackSendState.canSend ? fallbackSendState.projectName : resolvedTarget.label
        const result = await sendAgentCommand(item.body, {
          threadTitle: item.title,
          navigation: 'stay',
        })
        const failure = failedSendReason(result)
        if (failure !== null) {
          showNotice('error', failure || t('quickCommands.sendFailed'))
          return
        }
        sentProjectId = result.projectId
        sentProjectName = targetName
        sentThreadId = result.threadId
      }
      const { items: synced, saved } = recordCommandUsageInStorage(browserStorage(), item.id)
      if (mountedRef.current) {
        itemsRef.current = synced
        setItems(synced)
        const threadLink = sentProjectId && sentThreadId
          ? { projectId: sentProjectId, threadId: sentThreadId }
          : undefined
        if (!saved) {
          showNotice('error', t('quickCommands.saveFailed'))
        } else {
          showNotice('ok', t('quickCommands.sentTo', { name: sentProjectName }), threadLink)
        }
      }
    } catch (error) {
      if (!mountedRef.current) return
      const detail = error instanceof Error ? error.message.trim() : ''
      const base = t('quickCommands.sendFailed')
      if (error instanceof AgentCommandChannelError && error.code === 'not_configured') {
        showNotice('error', t('quickCommands.sendNeedsProject'))
        return
      }
      showNotice('error', detail && detail !== base ? `${base} · ${detail}` : base)
    } finally {
      sendingLockRef.current = false
      if (mountedRef.current) setSendingId(null)
    }
  }

  const removeItem = (id: string) => {
    persist(deleteQuickCommand(itemsRef.current, id))
    setConfirmDeleteId(null)
    window.cancelAnimationFrame(restoreFocusFrameRef.current)
    restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
      if (mountedRef.current && newBtnRef.current?.isConnected) {
        newBtnRef.current.focus()
      }
    })
  }

  return (
    <section
      className="desk-surface qc-page"
      hidden={hidden}
      aria-label={t('sidebar.pinnedQuickCommands')}
    >
      <header className="qc-header">
        <div className="qc-header-drag" aria-hidden="true" />
        <div className="qc-header-inner">
          <div className="qc-header-copy">
            <h1 className="qc-title">{t('shell.viewQuickCommands')}</h1>
          </div>
          <div className="qc-header-actions">
            <p className="qc-count">{t('quickCommands.count', { count: items.length })}</p>
            <label className="qc-target-picker" htmlFor={headerTargetSelectId}>
              <span className="qc-target-prefix">{t('quickCommands.targetPrefix')}</span>
              <select
                id={headerTargetSelectId}
                className="qc-target-select"
                aria-label={t('quickCommands.targetSelectLabel')}
                value={resolvedHeaderTarget.key}
                onChange={(event) => handleHeaderTargetChange(event.target.value)}
              >
                {targetOptions.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </label>
            <button
              ref={newBtnRef}
              type="button"
              className="qc-btn qc-btn-primary"
              onClick={(event) => openEditor({
                mode: 'create',
                title: '',
                body: '',
                category: 'other',
                defaultTargetKey: '',
                pinned: false,
              }, event.currentTarget)}
            >
              <IconInline name="plus" />
              <span>{t('quickCommands.newCommand')}</span>
            </button>
          </div>
        </div>
        {canSend ? null : (
          <p className="qc-banner">{t('quickCommands.sendNeedsProject')}</p>
        )}
      </header>

      <div className="qc-toolbar">
        <div className="qc-toolbar-inner">
          <div className="qc-filters" role="group" aria-label={t('quickCommands.filtersLabel')}>
            <button
              type="button"
              className={category === 'all' ? 'qc-pill qc-pill-active' : 'qc-pill'}
              aria-pressed={category === 'all'}
              onClick={() => setCategory('all')}
            >
              {t('quickCommands.filterAll')}
            </button>
            {QUICK_COMMAND_CATEGORIES.map((entry) => (
              <button
                key={entry}
                type="button"
                className={category === entry ? 'qc-pill qc-pill-active' : 'qc-pill'}
                aria-pressed={category === entry}
                onClick={() => setCategory(entry)}
              >
                {categoryLabel(t, entry)}
              </button>
            ))}
          </div>
          <label className="qc-search">
            <IconInline name="search" />
            <span className="qc-sr">{t('quickCommands.searchLabel')}</span>
            <input
              className="qc-search-input"
              type="search"
              value={query}
              placeholder={t('quickCommands.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="qc-scroll">
        <div className="qc-board">
          {items.length === 0 ? (
            <div className="qc-empty">
              <h2 className="qc-empty-title">{t('quickCommands.emptyTitle')}</h2>
              <p className="qc-empty-body">{t('quickCommands.emptyBody')}</p>
              <button
                type="button"
                className="qc-btn qc-btn-primary"
                onClick={(event) => openEditor({
                  mode: 'create',
                  title: '',
                  body: '',
                  category: 'other',
                  defaultTargetKey: '',
                  pinned: false,
                }, event.currentTarget)}
              >
                <IconInline name="plus" />
                <span>{t('quickCommands.newCommand')}</span>
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="qc-empty">
              <h2 className="qc-empty-title">{t('quickCommands.filteredEmptyTitle')}</h2>
              <p className="qc-empty-body">{t('quickCommands.filteredEmptyBody')}</p>
              {filtersActive ? (
                <button
                  type="button"
                  className="qc-btn"
                  onClick={() => {
                    setCategory('all')
                    setQuery('')
                  }}
                >
                  {t('quickCommands.clearFilters')}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="qc-grid">
              {visible.map((item) => {
                const expanded = expandedIds.has(item.id)
                const showToggle = bodyNeedsToggle(item.body)
                const sending = sendingId === item.id
                const effectiveTarget = resolveEffectiveQuickCommandTarget({
                  itemTarget: item.defaultTarget,
                  headerTarget: resolvedHeaderTarget.target,
                  activeProject,
                  projects,
                  deskRoot,
                  deskLabel,
                })
                return (
                  <article
                    key={item.id}
                    className={item.pinned ? 'qc-card qc-card-pinned' : 'qc-card'}
                  >
                    <div className="qc-card-top">
                      <span className={`qc-chip qc-chip-${item.category}`}>{categoryLabel(t, item.category)}</span>
                      {item.pinned ? <span className="qc-pin-mark">{t('quickCommands.pinned')}</span> : null}
                      {effectiveTarget.source === 'command' ? (
                        <span className="qc-target-chip">{t('quickCommands.cardFixedTarget', { name: effectiveTarget.label })}</span>
                      ) : null}
                      {item.useCount > 0 ? (
                        <span className="qc-meta">{t('quickCommands.useCount', { count: item.useCount })}</span>
                      ) : null}
                    </div>
                    <h2 className="qc-card-title">{item.title}</h2>
                    <div className="qc-body-box">
                      <p className={expanded ? 'qc-body-text qc-body-expanded' : 'qc-body-text'}>{item.body}</p>
                    </div>
                    {showToggle ? (
                      <button
                        type="button"
                        className="qc-text-btn"
                        aria-expanded={expanded}
                        onClick={() => {
                          setExpandedIds((current) => {
                            const next = new Set(current)
                            if (next.has(item.id)) next.delete(item.id)
                            else next.add(item.id)
                            return next
                          })
                        }}
                      >
                        {expanded ? t('quickCommands.collapse') : t('quickCommands.expand')}
                      </button>
                    ) : null}
                    <div className="qc-actions">
                      <button type="button" className="qc-btn" onClick={() => void copyItem(item)}>
                        <IconInline name={copiedId === item.id ? 'check' : 'copy'} />
                        <span>{copiedId === item.id ? t('quickCommands.copied') : t('quickCommands.copy')}</span>
                      </button>
                      <button
                        type="button"
                        className="qc-btn qc-btn-send"
                        disabled={!canSend || sendingId !== null}
                        aria-busy={sending}
                        title={canSend
                          ? t('quickCommands.sendToTitle', { name: effectiveTarget.label })
                          : t('quickCommands.sendNeedsProject')}
                        onClick={() => void sendItem(item, effectiveTarget)}
                      >
                        <IconInline name="send" />
                        <span>{sending ? t('quickCommands.sending') : t('quickCommands.send')}</span>
                      </button>
                      <button
                        type="button"
                        className="qc-btn"
                        onClick={(event) => openEditor({
                          mode: 'edit',
                          id: item.id,
                          title: item.title,
                          body: item.body,
                          category: item.category,
                          defaultTargetKey: serializeQuickCommandTargetKey(item.defaultTarget),
                          pinned: item.pinned,
                        }, event.currentTarget)}
                      >
                        <IconInline name="edit" />
                        <span>{t('quickCommands.edit')}</span>
                      </button>
                      <button
                        type="button"
                        className="qc-btn"
                        aria-pressed={item.pinned}
                        onClick={() => {
                          persist(togglePinQuickCommand(itemsRef.current, item.id))
                          setConfirmDeleteId(null)
                        }}
                      >
                        <IconInline name="pin" />
                        <span>{item.pinned ? t('quickCommands.unpin') : t('quickCommands.pin')}</span>
                      </button>
                      {confirmDeleteId === item.id ? (
                        <span className="qc-confirm">
                          <button
                            type="button"
                            className="qc-btn qc-btn-danger"
                            onClick={() => removeItem(item.id)}
                          >
                            {t('quickCommands.confirmDelete')}
                          </button>
                          <button
                            type="button"
                            className="qc-btn"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            {t('quickCommands.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="qc-btn qc-btn-quiet"
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          <IconInline name="trash" />
                          <span>{t('quickCommands.delete')}</span>
                        </button>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {notice ? (
        <div className={notice.tone === 'error' ? 'qc-toast qc-toast-error' : 'qc-toast qc-toast-ok'} role="status">
          <p className="qc-toast-text">{notice.message}</p>
          {notice.threadLink && onOpenDispatchedThread ? (
            <button
              type="button"
              className="qc-toast-link"
              onClick={() => {
                const link = notice.threadLink
                setNotice(null)
                if (link) onOpenDispatchedThread(link.projectId, link.threadId)
              }}
            >
              {t('quickCommands.openDispatchedThread')}
            </button>
          ) : null}
          <button type="button" className="qc-text-btn" onClick={() => setNotice(null)}>
            {t('quickCommands.dismiss')}
          </button>
        </div>
      ) : null}

      {editor && typeof document !== 'undefined' ? createPortal(
        <div
          className="qc-modal"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor()
          }}
        >
          <form
            ref={dialogRef}
            className="qc-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            onSubmit={(event) => {
              event.preventDefault()
              commitRef.current()
            }}
          >
            <div className="qc-dialog-head">
              <h2 id={dialogTitleId} className="qc-dialog-title">
                {editor.mode === 'edit' ? t('quickCommands.modalEditTitle') : t('quickCommands.modalCreateTitle')}
              </h2>
              <button type="button" className="qc-icon-btn" aria-label={t('quickCommands.close')} onClick={closeEditor}>
                <IconInline name="x" />
              </button>
            </div>
            <label className="qc-label" htmlFor={titleFieldId}>
              {t('quickCommands.fieldTitle')}
              <input
                id={titleFieldId}
                ref={titleInputRef}
                className="qc-input"
                value={editor.title}
                placeholder={t('quickCommands.titlePlaceholder')}
                onChange={(event) => patchEditor({ title: event.target.value })}
              />
            </label>
            <label className="qc-label" htmlFor={bodyFieldId}>
              {t('quickCommands.fieldBody')}
              <textarea
                id={bodyFieldId}
                className="qc-textarea"
                value={editor.body}
                placeholder={t('quickCommands.bodyPlaceholder')}
                onChange={(event) => patchEditor({ body: event.target.value })}
              />
            </label>
            <label className="qc-label" htmlFor={categoryFieldId}>
              {t('quickCommands.fieldCategory')}
              <select
                id={categoryFieldId}
                className="qc-select"
                value={editor.category}
                onChange={(event) => patchEditor({ category: event.target.value as QuickCommandCategory })}
              >
                {QUICK_COMMAND_CATEGORIES.map((entry) => (
                  <option key={entry} value={entry}>{categoryLabel(t, entry)}</option>
                ))}
              </select>
            </label>
            <label className="qc-label" htmlFor={targetFieldId}>
              {t('quickCommands.fieldTarget')}
              <select
                id={targetFieldId}
                className="qc-select"
                value={editor.defaultTargetKey}
                onChange={(event) => patchEditor({ defaultTargetKey: event.target.value })}
              >
                <option value="">{t('quickCommands.targetFollowHeader')}</option>
                {targetOptions.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="qc-check">
              <input
                className="qc-checkbox"
                type="checkbox"
                checked={editor.pinned}
                onChange={(event) => patchEditor({ pinned: event.target.checked })}
              />
              <span>{t('quickCommands.fieldPinned')}</span>
            </label>
            {editorError ? (
              <p className="qc-error" role="alert">
                {editorError === 'blank_body' ? t('quickCommands.blankBody') : t('quickCommands.blankTitle')}
              </p>
            ) : null}
            <div className="qc-dialog-actions">
              <button type="button" className="qc-btn" onClick={closeEditor}>
                {t('quickCommands.cancel')}
              </button>
              <button type="submit" className="qc-btn qc-btn-primary">
                {t('quickCommands.save')}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
    </section>
  )
}
