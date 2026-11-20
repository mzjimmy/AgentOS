/**
 * 全屏图片灯箱：支持 Esc / 遮罩 / ✕ 关闭，左右箭头键与按钮切换多图。
 * Full-resolution image lightbox with keyboard (Esc, ArrowLeft, ArrowRight) and backdrop dismissal.
 */

import { useEffect } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { stepLightboxIndex } from './journal-ui-helpers'

export type LightboxImageItem = {
  relativePath: string
  fileName: string
  caption?: string
  dataUrl?: string
  metaLabel?: string
}

type JournalLightboxProps = {
  images: LightboxImageItem[]
  activeIndex: number
  onChangeIndex: (nextIndex: number) => void
  onClose: () => void
}

export function JournalLightbox({
  images,
  activeIndex,
  onChangeIndex,
  onClose,
}: JournalLightboxProps) {
  const { t } = useI18n()
  const total = images.length
  const safeIndex = total > 0 ? Math.min(Math.max(0, activeIndex), total - 1) : 0
  const current = images[safeIndex]

  useEffect(() => {
    if (total === 0) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft' && total > 1) {
        event.preventDefault()
        onChangeIndex(stepLightboxIndex(safeIndex, total, -1))
      } else if (event.key === 'ArrowRight' && total > 1) {
        event.preventDefault()
        onChangeIndex(stepLightboxIndex(safeIndex, total, 1))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onChangeIndex, onClose, safeIndex, total])

  if (!current) return null

  return (
    <div
      className="journal-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('journal.lightboxTitle')}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="journal-lightbox-shell">
        <header className="journal-lightbox-header">
          <div className="journal-lightbox-meta">
            {current.metaLabel ? <span className="journal-lightbox-time">{current.metaLabel}</span> : null}
            {total > 1 ? (
              <span className="journal-lightbox-counter">
                {safeIndex + 1} / {total}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="journal-lightbox-close"
            aria-label={t('journal.lightboxClose')}
            title={t('journal.lightboxClose')}
            onClick={onClose}
          >
            <IconInline name="x" />
          </button>
        </header>

        <div className="journal-lightbox-stage">
          {total > 1 ? (
            <button
              type="button"
              className="journal-lightbox-nav journal-lightbox-nav--prev"
              aria-label={t('journal.lightboxPrev')}
              onClick={() => onChangeIndex(stepLightboxIndex(safeIndex, total, -1))}
            >
              <IconInline name="back" />
            </button>
          ) : null}

          <div className="journal-lightbox-frame">
            {current.dataUrl ? (
              <img
                src={current.dataUrl}
                alt={current.caption || current.fileName}
                className="journal-lightbox-img"
              />
            ) : (
              <div className="journal-lightbox-loading">{t('journal.loadingImage')}</div>
            )}
          </div>

          {total > 1 ? (
            <button
              type="button"
              className="journal-lightbox-nav journal-lightbox-nav--next"
              aria-label={t('journal.lightboxNext')}
              onClick={() => onChangeIndex(stepLightboxIndex(safeIndex, total, 1))}
            >
              <IconInline name="forward" />
            </button>
          ) : null}
        </div>

        {current.caption || current.fileName ? (
          <footer className="journal-lightbox-footer">
            <p className="journal-lightbox-caption">{current.caption || current.fileName}</p>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
