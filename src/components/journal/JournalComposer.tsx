/**
 * 底部固定快记栏：支持文字输入、⌘V 粘贴图片、拖拽图片、文件选择、本地语音听写、
 * 卡片类型切换、@项目 关联、#标签 快插、分类选择与 ⌘↵ 提交。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import type { SpeechRecognitionStatus } from '../../desktop-types'
import { useI18n } from '../../i18n/i18n'
import { IconInline } from '../../icon-inline'
import {
  JOURNAL_CATEGORIES,
  type CreateJournalEntryInput,
  type JournalCategory,
  type JournalCreateImageInput,
  type JournalEntryKind,
} from '../../journal-contract'
import type { WorkspaceProject } from '../types'
import { extractJournalTokens, getJournalCategorySlug } from './journal-ui-helpers'

type PendingComposerImage = JournalCreateImageInput & {
  id: string
}

type ComposerKindOption = Extract<JournalEntryKind, 'note' | 'thought' | 'moment'>

const COMPOSER_KINDS: readonly ComposerKindOption[] = ['note', 'thought', 'moment']

type JournalComposerProps = {
  targetDate: string
  projects: WorkspaceProject[]
  suggestedTags: string[]
  externalDroppedFiles?: File[]
  onConsumedExternalDrop?: () => void
  onSubmit: (input: CreateJournalEntryInput) => Promise<boolean>
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

export function JournalComposer({
  targetDate,
  projects,
  suggestedTags,
  externalDroppedFiles,
  onConsumedExternalDrop,
  onSubmit,
}: JournalComposerProps) {
  const { t } = useI18n()
  const [body, setBody] = useState('')
  const [category, setCategory] = useState<JournalCategory>('学习')
  const [kind, setKind] = useState<ComposerKindOption>('note')
  const [images, setImages] = useState<PendingComposerImage[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [openMenu, setOpenMenu] = useState<'project' | 'tag' | 'category' | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<SpeechRecognitionStatus>('idle')
  const [voiceMessage, setVoiceMessage] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const voiceBaseTextRef = useRef('')
  const voiceListeningRef = useRef(false)

  const speechAvailable = Boolean(
    typeof window !== 'undefined' &&
      window.desktop?.startSpeechRecognition &&
      window.desktop?.stopSpeechRecognition &&
      window.desktop?.onSpeechRecognitionEvent,
  )

  const appendImageFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const loaded: PendingComposerImage[] = []
    for (const file of imageFiles.slice(0, 9)) {
      try {
        const dataUrl = await readFileAsDataUrl(file)
        if (!dataUrl) continue
        loaded.push({
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          fileName: file.name || `pasted-${Date.now()}.png`,
          mimeType: file.type || 'image/png',
          dataUrl,
        })
      } catch {
        /* skip unreadable file */
      }
    }
    if (loaded.length > 0) {
      setImages((prev) => [...prev, ...loaded])
    }
  }, [])

  useEffect(() => {
    if (!externalDroppedFiles || externalDroppedFiles.length === 0) return
    void appendImageFiles(externalDroppedFiles).finally(() => {
      onConsumedExternalDrop?.()
    })
  }, [appendImageFiles, externalDroppedFiles, onConsumedExternalDrop])

  useEffect(() => {
    if (!openMenu) return
    const onDocClick = (event: MouseEvent) => {
      if (toolbarRef.current && event.target instanceof Node && !toolbarRef.current.contains(event.target)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenu])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, Math.max(42, el.scrollHeight))}px`
  }, [body])

  useEffect(() => {
    if (!speechAvailable) return
    const unsubscribe = window.desktop?.onSpeechRecognitionEvent?.((event) => {
      if (!voiceListeningRef.current) return
      if (event.type === 'status') {
        setVoiceStatus(event.status)
        if (event.status === 'idle' || event.status === 'error') {
          voiceListeningRef.current = false
        }
      } else if (event.type === 'partial' || event.type === 'final') {
        const prefix = voiceBaseTextRef.current
        const spacer = prefix && !prefix.endsWith(' ') && !prefix.endsWith('\n') ? ' ' : ''
        setBody(`${prefix}${spacer}${event.text}`)
        if (event.type === 'final') {
          voiceListeningRef.current = false
          setVoiceStatus('idle')
          setVoiceMessage('')
        }
      } else if (event.type === 'error') {
        voiceListeningRef.current = false
        setVoiceStatus('error')
        setVoiceMessage(event.message)
      }
    })
    return () => unsubscribe?.()
  }, [speechAvailable])

  const toggleVoice = async () => {
    if (!speechAvailable) return
    if (voiceListeningRef.current) {
      setVoiceStatus('transcribing')
      const result = await window.desktop?.stopSpeechRecognition?.()
      if (result && !result.ok) {
        voiceListeningRef.current = false
        setVoiceStatus(result.status)
        setVoiceMessage(result.message)
      }
      return
    }
    voiceBaseTextRef.current = body
    voiceListeningRef.current = true
    setVoiceStatus('starting')
    setVoiceMessage('')
    const result = await window.desktop?.startSpeechRecognition?.({ requiresOnDevice: true })
    if (result && !result.ok) {
      voiceListeningRef.current = false
      setVoiceStatus(result.status)
      setVoiceMessage(result.message)
    }
  }

  const insertToken = (token: string) => {
    const el = textareaRef.current
    const needsSpace = body.length > 0 && !body.endsWith(' ') && !body.endsWith('\n')
    const addition = `${needsSpace ? ' ' : ''}${token} `
    if (!el) {
      setBody((prev) => `${prev}${addition}`)
      return
    }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const before = body.slice(0, start)
    const after = body.slice(end)
    const sepBefore = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
    const next = `${before}${sepBefore}${token} ${after}`
    setBody(next)
    setOpenMenu(null)
    requestAnimationFrame(() => {
      el.focus()
      const cursor = before.length + sepBefore.length + token.length + 1
      el.setSelectionRange(cursor, cursor)
    })
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items
    if (!items) return
    const pastedFiles: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) pastedFiles.push(file)
      }
    }
    if (pastedFiles.length > 0) {
      event.preventDefault()
      void appendImageFiles(pastedFiles)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.files?.length) return
    const hasImage = Array.from(event.dataTransfer.files).some((file) => file.type.startsWith('image/'))
    if (!hasImage) return
    event.preventDefault()
    event.stopPropagation()
    setIsDragOver(false)
    void appendImageFiles(event.dataTransfer.files)
  }

  const handleSubmit = async () => {
    const trimmed = body.trim()
    if ((!trimmed && images.length === 0) || submitting) return

    if (voiceListeningRef.current) {
      voiceListeningRef.current = false
      await window.desktop?.stopSpeechRecognition?.().catch(() => undefined)
      setVoiceStatus('idle')
    }

    setSubmitting(true)
    const { tags, projectRefs } = extractJournalTokens(trimmed, projects)
    const resolvedKind: JournalEntryKind =
      images.length > 0 && kind === 'note' && trimmed.length <= 140 ? 'photo' : kind

    const ok = await onSubmit({
      date: targetDate,
      body: trimmed,
      kind: resolvedKind,
      category,
      tags,
      projectRefs,
      source: 'local',
      provenance: 'human',
      images: images.map(({ fileName, mimeType, dataUrl, caption }) => ({
        fileName,
        mimeType,
        dataUrl,
        caption,
      })),
    })

    setSubmitting(false)
    if (ok) {
      setBody('')
      setImages([])
      setOpenMenu(null)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void handleSubmit()
    }
  }

  const cycleKind = () => {
    const idx = COMPOSER_KINDS.indexOf(kind)
    setKind(COMPOSER_KINDS[(idx + 1) % COMPOSER_KINDS.length])
  }

  const kindLabelKey =
    kind === 'thought'
      ? 'journal.kindThought'
      : kind === 'moment'
        ? 'journal.kindMoment'
        : 'journal.kindNote'

  const isListening =
    voiceStatus === 'listening' || voiceStatus === 'starting' || voiceStatus === 'requesting_permission'
  const canSubmit = (body.trim().length > 0 || images.length > 0) && !submitting

  return (
    <div className="journal-composer-dock">
      <div
        className={`journal-composer-card${isDragOver ? ' is-drag-over' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes('Files')) {
            event.preventDefault()
            setIsDragOver(true)
          }
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        {images.length > 0 ? (
          <div className="journal-composer-attachments">
            {images.map((img) => (
              <div key={img.id} className="journal-composer-thumb-wrap">
                <img src={img.dataUrl} alt={img.fileName} className="journal-composer-thumb" />
                <button
                  type="button"
                  className="journal-composer-thumb-remove"
                  aria-label={t('journal.removeAttachment')}
                  onClick={() => setImages((prev) => prev.filter((item) => item.id !== img.id))}
                >
                  <IconInline name="x" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="journal-composer-thumb-add"
              title={t('journal.addImage')}
              aria-label={t('journal.addImage')}
              onClick={() => fileInputRef.current?.click()}
            >
              <IconInline name="plus" />
            </button>
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          className="journal-composer-input"
          placeholder={t('journal.composerPlaceholder')}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          rows={1}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="journal-visually-hidden"
          onChange={(event) => {
            if (event.target.files?.length) {
              void appendImageFiles(event.target.files)
            }
            event.target.value = ''
          }}
        />

        <div className="journal-composer-toolbar" ref={toolbarRef}>
          <div className="journal-composer-tools">
            <button
              type="button"
              className="journal-tool-icon-btn"
              title={t('journal.addImage')}
              aria-label={t('journal.addImage')}
              onClick={() => fileInputRef.current?.click()}
            >
              <IconInline name="image" />
            </button>

            <button
              type="button"
              className={`journal-tool-icon-btn${isListening ? ' is-recording' : ''}`}
              disabled={!speechAvailable}
              title={
                !speechAvailable
                  ? t('journal.voiceUnavailable')
                  : isListening
                    ? t('journal.voiceStop')
                    : t('journal.voiceStart')
              }
              aria-label={t('journal.voiceStart')}
              onClick={() => void toggleVoice()}
            >
              <IconInline name="mic" />
            </button>

            <button
              type="button"
              className="journal-tool-pill"
              title={t('journal.cycleKindHint')}
              onClick={cycleKind}
            >
              <IconInline name="file" />
              <span>{t(kindLabelKey)}</span>
            </button>

            <div className="journal-popover-anchor">
              <button
                type="button"
                className={`journal-tool-pill${openMenu === 'project' ? ' is-open' : ''}`}
                onClick={() => setOpenMenu((cur) => (cur === 'project' ? null : 'project'))}
              >
                {t('journal.projectChipLabel')}
              </button>
              {openMenu === 'project' ? (
                <div className="journal-popover-menu" role="menu">
                  {projects.length === 0 ? (
                    <div className="journal-popover-empty">{t('journal.noProjects')}</div>
                  ) : (
                    projects.map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        role="menuitem"
                        className="journal-popover-item"
                        onClick={() => insertToken(`@${project.name}`)}
                      >
                        <IconInline name="folder" />
                        <span>{project.name}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>

            <div className="journal-popover-anchor">
              <button
                type="button"
                className={`journal-tool-pill${openMenu === 'tag' ? ' is-open' : ''}`}
                onClick={() => setOpenMenu((cur) => (cur === 'tag' ? null : 'tag'))}
              >
                {t('journal.tagChipLabel')}
              </button>
              {openMenu === 'tag' ? (
                <div className="journal-popover-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="journal-popover-item"
                    onClick={() => insertToken('#')}
                  >
                    <span># {t('journal.insertCustomTag')}</span>
                  </button>
                  {suggestedTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      role="menuitem"
                      className="journal-popover-item"
                      onClick={() => insertToken(`#${tag}`)}
                    >
                      <span>#{tag}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="journal-popover-anchor">
              <button
                type="button"
                className={`journal-cat-pill journal-cat-pill--${getJournalCategorySlug(category)}`}
                onClick={() => setOpenMenu((cur) => (cur === 'category' ? null : 'category'))}
              >
                {category}
              </button>
              {openMenu === 'category' ? (
                <div className="journal-popover-menu journal-popover-menu--cats" role="menu">
                  {JOURNAL_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      role="menuitem"
                      className={`journal-cat-pill journal-cat-pill--${getJournalCategorySlug(cat)}${cat === category ? ' is-selected' : ''}`}
                      onClick={() => {
                        setCategory(cat)
                        setOpenMenu(null)
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="journal-composer-right">
            <span className="journal-composer-hint">
              {voiceMessage || t('journal.composerHint')}
            </span>
            <button
              type="button"
              className="journal-submit-btn"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              <span>{submitting ? t('journal.saving') : t('journal.submitRecord')}</span>
              <kbd className="journal-submit-kbd">⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
