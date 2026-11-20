/**
 * 多态日记卡片：6 种确定性卡片形态（note / photo / thought / moment / ai / judgment），
 * 支持图片懒加载、分类切换、行内编辑、安全二次确认删除与开对话探讨。
 */

import { useState, type KeyboardEvent } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  JOURNAL_CATEGORIES,
  type JournalCategory,
  type JournalEntry,
  type UpdateJournalEntryInput,
} from '../../journal-contract'
import {
  classifyJournalCardSpan,
  getJournalCategorySlug,
  getNextJournalCategory,
  resolveEffectiveCardKind,
} from './journal-ui-helpers'

type JournalCardProps = {
  entry: JournalEntry
  index: number
  imageCache: Record<string, string>
  onOpenImage: (entry: JournalEntry, imageIndex: number) => void
  onUpdateEntry: (entryId: string, patch: UpdateJournalEntryInput) => Promise<boolean>
  onDeleteEntry: (entryId: string) => Promise<boolean>
  onDiscussInChat?: (entry: JournalEntry) => void
  onFilterByTag?: (tag: string) => void
}

export function JournalCard({
  entry,
  index,
  imageCache,
  onOpenImage,
  onUpdateEntry,
  onDeleteEntry,
  onDiscussInChat,
  onFilterByTag,
}: JournalCardProps) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draftBody, setDraftBody] = useState(entry.body)
  const [draftCategory, setDraftCategory] = useState<JournalCategory>(entry.category)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)

  const species = resolveEffectiveCardKind(entry)
  const colSpan = classifyJournalCardSpan(entry, index)
  const categorySlug = getJournalCategorySlug(entry.category)

  const startEditing = () => {
    setDraftBody(entry.body)
    setDraftCategory(entry.category)
    setConfirmDelete(false)
    setEditing(true)
  }

  const handleSaveEdit = async () => {
    const trimmed = draftBody.trim()
    if (!trimmed && entry.images.length === 0) return
    setSaving(true)
    const ok = await onUpdateEntry(entry.id, {
      body: draftBody,
      category: draftCategory,
    })
    setSaving(false)
    if (ok) {
      setEditing(false)
    }
  }

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void handleSaveEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(false)
    }
  }

  const handleCycleCategory = async () => {
    const nextCategory = getNextJournalCategory(entry.category)
    await onUpdateEntry(entry.id, { category: nextCategory })
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entry.body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked */
    }
  }

  const renderCategoryPill = () => (
    <button
      type="button"
      className={`journal-cat-pill journal-cat-pill--${categorySlug}`}
      title={t('journal.cycleCategoryHint')}
      onClick={() => void handleCycleCategory()}
    >
      {entry.category}
    </button>
  )

  const renderHoverActions = () => (
    <div className="journal-card-actions" role="toolbar" aria-label={t('journal.cardActions')}>
      {onDiscussInChat ? (
        <button
          type="button"
          className="journal-card-action-btn"
          title={t('journal.discussInChat')}
          aria-label={t('journal.discussInChat')}
          onClick={() => onDiscussInChat(entry)}
        >
          <IconInline name="message" />
        </button>
      ) : null}
      <button
        type="button"
        className="journal-card-action-btn"
        title={copied ? t('journal.copied') : t('journal.copyBody')}
        aria-label={t('journal.copyBody')}
        onClick={() => void handleCopy()}
      >
        <IconInline name={copied ? 'check' : 'copy'} />
      </button>
      <button
        type="button"
        className="journal-card-action-btn"
        title={t('journal.editEntry')}
        aria-label={t('journal.editEntry')}
        onClick={startEditing}
      >
        <IconInline name="edit" />
      </button>
      {confirmDelete ? (
        <span className="journal-card-delete-confirm">
          <button
            type="button"
            className="journal-card-delete-yes"
            onClick={() => void onDeleteEntry(entry.id)}
          >
            {t('journal.confirmDelete')}
          </button>
          <button
            type="button"
            className="journal-card-delete-no"
            onClick={() => setConfirmDelete(false)}
          >
            {t('journal.cancel')}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="journal-card-action-btn journal-card-action-btn--danger"
          title={t('journal.deleteEntry')}
          aria-label={t('journal.deleteEntry')}
          onClick={() => setConfirmDelete(true)}
        >
          <IconInline name="trash" />
        </button>
      )}
    </div>
  )

  const renderImageGrid = () => {
    if (entry.images.length === 0) return null
    const visibleImages = entry.images.slice(0, 4)
    const overflowCount = entry.images.length - 4
    const countClass =
      visibleImages.length === 1
        ? 'journal-photo-grid--single'
        : visibleImages.length === 2
          ? 'journal-photo-grid--two'
          : visibleImages.length === 3
            ? 'journal-photo-grid--three'
            : 'journal-photo-grid--four'

    return (
      <div className={`journal-photo-grid ${countClass}`}>
        {visibleImages.map((img, imgIdx) => {
          const src = imageCache[img.relativePath]
          const showOverflow = imgIdx === 3 && overflowCount > 0
          return (
            <button
              key={img.relativePath}
              type="button"
              className="journal-photo-tile"
              aria-label={img.caption || img.fileName}
              onClick={() => onOpenImage(entry, imgIdx)}
            >
              {src ? (
                <img
                  src={src}
                  alt={img.caption || img.fileName}
                  className="journal-photo-img"
                  loading="lazy"
                />
              ) : (
                <span className="journal-photo-placeholder">
                  <IconInline name="image" />
                </span>
              )}
              {showOverflow ? <span className="journal-photo-overflow">+{overflowCount}</span> : null}
            </button>
          )
        })}
      </div>
    )
  }

  const renderMetaFooter = () => {
    if (entry.tags.length === 0 && entry.projectRefs.length === 0 && !entry.relatedNote) {
      return null
    }
    return (
      <div className="journal-card-chips">
        {entry.relatedNote ? (
          <span className="journal-related-note">↗ {entry.relatedNote}</span>
        ) : null}
        {entry.projectRefs.map((projectName) => (
          <span key={projectName} className="journal-project-chip">
            @{projectName}
          </span>
        ))}
        {entry.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="journal-tag-chip"
            onClick={() => onFilterByTag?.(tag)}
          >
            {tag}
          </button>
        ))}
      </div>
    )
  }

  if (editing) {
    return (
      <article
        className={`journal-card journal-card--${species} journal-card--editing journal-span-${colSpan}`}
        data-entry-id={entry.id}
      >
        <div className="journal-card-edit-head">
          <span className="journal-card-time">{entry.time}</span>
          <div className="journal-card-edit-cats">
            {JOURNAL_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`journal-cat-pill journal-cat-pill--${getJournalCategorySlug(cat)}${draftCategory === cat ? ' is-selected' : ''}`}
                onClick={() => setDraftCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
        <textarea
          autoFocus
          className="journal-card-edit-textarea"
          value={draftBody}
          onChange={(event) => setDraftBody(event.target.value)}
          onKeyDown={handleEditKeyDown}
          rows={4}
        />
        <div className="journal-card-edit-actions">
          <button
            type="button"
            className="journal-btn-secondary"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            {t('journal.cancel')}
          </button>
          <button
            type="button"
            className="journal-btn-primary"
            disabled={saving}
            onClick={() => void handleSaveEdit()}
          >
            {saving ? t('journal.saving') : t('journal.save')}
          </button>
        </div>
      </article>
    )
  }

  if (species === 'moment') {
    return (
      <article
        className={`journal-card journal-card--moment journal-span-${colSpan}`}
        data-entry-id={entry.id}
      >
        <div className="journal-moment-head">
          <span className="journal-card-time">{entry.time} ♪</span>
          {renderHoverActions()}
        </div>
        <div className="journal-moment-title">{entry.momentTitle || entry.body}</div>
        {entry.momentSubtitle ? (
          <div className="journal-moment-subtitle">{entry.momentSubtitle}</div>
        ) : entry.momentTitle && entry.body ? (
          <div className="journal-moment-subtitle">{entry.body}</div>
        ) : null}
      </article>
    )
  }

  if (species === 'judgment') {
    return (
      <article
        className={`journal-card journal-card--judgment journal-span-${colSpan}`}
        data-entry-id={entry.id}
      >
        <div className="journal-card-head">
          <div className="journal-card-head-left">
            <span className="journal-judgment-pill">✓ {entry.category}</span>
            <span className="journal-card-time">{entry.time}</span>
          </div>
          {renderHoverActions()}
        </div>
        <p className="journal-card-body journal-card-body--compact">{entry.body}</p>
        {renderMetaFooter()}
      </article>
    )
  }

  if (species === 'ai') {
    return (
      <article
        className={`journal-card journal-card--ai journal-span-${colSpan}`}
        data-entry-id={entry.id}
      >
        <div className="journal-card-head">
          <div className="journal-card-head-left">
            <span className="journal-ai-badge">AI</span>
            <span className="journal-card-time">
              {entry.time} · {t('journal.aiSummaryLabel')}
            </span>
          </div>
          {renderHoverActions()}
        </div>
        <div className="journal-card-body">{entry.body}</div>
        {renderMetaFooter()}
      </article>
    )
  }

  if (species === 'photo') {
    return (
      <article
        className={`journal-card journal-card--photo journal-span-${colSpan}`}
        data-entry-id={entry.id}
      >
        {renderImageGrid()}
        <div className="journal-photo-body">
          <div className="journal-card-head">
            <div className="journal-card-head-left">
              <span className="journal-card-time">{entry.time}</span>
              {renderCategoryPill()}
              <span className="journal-photo-count">
                · {t('journal.photoCount', { n: entry.images.length })}
              </span>
              {entry.source === 'feishu' ? (
                <span className="journal-source-badge">{t('journal.sourceFeishu')}</span>
              ) : null}
            </div>
            {renderHoverActions()}
          </div>
          {entry.body.trim() ? <p className="journal-card-body">{entry.body}</p> : null}
          {renderMetaFooter()}
        </div>
      </article>
    )
  }

  if (species === 'thought') {
    return (
      <article
        className={`journal-card journal-card--thought${entry.category === '未归类' ? ' is-uncategorized' : ''} journal-span-${colSpan}`}
        data-entry-id={entry.id}
      >
        <div className="journal-card-head">
          <div className="journal-card-head-left">
            <span className="journal-card-time">{entry.time}</span>
            {renderCategoryPill()}
            {entry.source === 'feishu' ? (
              <span className="journal-source-badge">{t('journal.sourceFeishu')}</span>
            ) : null}
          </div>
          {renderHoverActions()}
        </div>
        <div className="journal-card-body">{entry.body}</div>
        {renderImageGrid()}
        {renderMetaFooter()}
      </article>
    )
  }

  return (
    <article
      className={`journal-card journal-card--note journal-span-${colSpan}`}
      data-entry-id={entry.id}
    >
      <div className="journal-card-head">
        <div className="journal-card-head-left">
          <span className="journal-card-time">{entry.time}</span>
          {renderCategoryPill()}
          {entry.source === 'feishu' ? (
            <span className="journal-source-badge">{t('journal.sourceFeishu')}</span>
          ) : null}
        </div>
        {renderHoverActions()}
      </div>
      <div className="journal-card-body">{entry.body}</div>
      {renderImageGrid()}
      {renderMetaFooter()}
    </article>
  )
}
