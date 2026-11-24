/**
 * Unified SentinelDesk Date-Archived Page Shell (Option 1 — Canonical Timeline Journal Frame).
 *
 * Single source of truth for:
 *  - Locked 3-column CSS Grid DeskDateTopbar (YYYY / MM ▾, [今天], dead-center 7-day wheel, 1 compact rightSlot)
 *  - Standard scrollable canvas (`max-width: 980px`, `padding: 24px 32px 48px`)
 *  - Standard Editorial Hero (`38px` mono `MM.DD` + weekday · 1-line factual meta + right actions/gear)
 *  - Optional subbar (tabs / filters) directly under Hero
 *  - Optional sticky banner (e.g. Morning Brief audio strip), footer (e.g. JournalComposer), and overlays
 */

import '../../styles/desk-date-shell.css'
import { useEffect, useId, useRef, type DragEventHandler, type ReactNode, type RefObject } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import { formatJournalHeroDate, formatWeekdayLabel } from '../journal/journal-ui-helpers'
import { DeskDateTopbar, type DeskDateTopbarProps } from './DeskDateTopbar'

export type DeskDatePageShellProps = {
  /** Root section className suffix (e.g. 'journal-page', 'intent-todo-page', 'lp-page'). */
  pageClassName?: string
  hidden?: boolean
  ariaLabel?: string
  testId?: string
  onDragOver?: DragEventHandler<HTMLElement>
  onDragLeave?: DragEventHandler<HTMLElement>
  onDrop?: DragEventHandler<HTMLElement>

  /** Shared DeskDateTopbar props (center 7-day wheel & calendar popover). */
  selectedDate: DeskDateTopbarProps['selectedDate']
  todayDate: DeskDateTopbarProps['todayDate']
  disableFuture?: DeskDateTopbarProps['disableFuture']
  calendarMarkers: DeskDateTopbarProps['calendarMarkers']
  calendarLoading?: DeskDateTopbarProps['calendarLoading']
  getDayState: DeskDateTopbarProps['getDayState']
  onSelectDate: DeskDateTopbarProps['onSelectDate']
  onOpenCalendar?: DeskDateTopbarProps['onOpenCalendar']
  topbarRightSlot?: ReactNode

  /** Optional slot directly under topbar and above the scroll area (e.g. sticky audio bar, toast). */
  beforeScroll?: ReactNode

  /** Scroll container customization. */
  scrollRef?: RefObject<HTMLDivElement | null>
  scrollClassName?: string
  innerClassName?: string

  /** Standardized Editorial Date Hero. */
  hideHero?: boolean
  heroMeta?: ReactNode
  heroLeftExtra?: ReactNode
  heroSubline?: ReactNode
  heroRight?: ReactNode
  heroRightRef?: RefObject<HTMLDivElement | null>

  /** Optional sub-navigation row (tabs / filters) directly beneath Hero. */
  subbar?: ReactNode

  /** Main page content inside `.desk-shell-inner`. */
  children: ReactNode

  /** Optional docked footer outside scroll area (e.g. JournalComposer). */
  footer?: ReactNode

  /** Optional overlays/modals/toasts rendered at section root. */
  overlays?: ReactNode
}

export function DeskDatePageShell({
  pageClassName,
  hidden = false,
  ariaLabel,
  testId,
  onDragOver,
  onDragLeave,
  onDrop,
  selectedDate,
  todayDate,
  disableFuture = false,
  calendarMarkers,
  calendarLoading = false,
  getDayState,
  onSelectDate,
  onOpenCalendar,
  topbarRightSlot,
  beforeScroll,
  scrollRef,
  scrollClassName,
  innerClassName,
  hideHero = false,
  heroMeta,
  heroLeftExtra,
  heroSubline,
  heroRight,
  heroRightRef,
  subbar,
  children,
  footer,
  overlays,
}: DeskDatePageShellProps) {
  const { locale } = useI18n()

  return (
    <section
      className={pageClassName ? `desk-surface ${pageClassName}` : 'desk-surface'}
      hidden={hidden}
      aria-label={ariaLabel}
      data-testid={testId}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <DeskDateTopbar
        selectedDate={selectedDate}
        todayDate={todayDate}
        disableFuture={disableFuture}
        calendarMarkers={calendarMarkers}
        calendarLoading={calendarLoading}
        getDayState={getDayState}
        onSelectDate={onSelectDate}
        onOpenCalendar={onOpenCalendar}
        rightSlot={topbarRightSlot}
      />

      {beforeScroll}

      <div
        ref={scrollRef}
        className={scrollClassName ? `desk-shell-scroll ${scrollClassName}` : 'desk-shell-scroll'}
      >
        <div
          className={innerClassName ? `desk-shell-inner ${innerClassName}` : 'desk-shell-inner'}
        >
          {!hideHero ? (
            <div className="desk-shell-hero" data-testid="desk-shell-hero">
              <div className="desk-shell-hero-left">
                <div className="desk-shell-hero-title-row">
                  <h1 className="desk-shell-hero-date">{formatJournalHeroDate(selectedDate)}</h1>
                  <span className="desk-shell-hero-meta">
                    {formatWeekdayLabel(selectedDate, locale)}
                    {heroMeta ? <> · {heroMeta}</> : null}
                  </span>
                  {heroLeftExtra}
                </div>
                {heroSubline ? <div className="desk-shell-hero-sub">{heroSubline}</div> : null}
              </div>

              {heroRight ? (
                <div className="desk-shell-hero-right" ref={heroRightRef}>
                  {heroRight}
                </div>
              ) : null}
            </div>
          ) : null}

          {subbar ? <div className="desk-shell-subbar">{subbar}</div> : null}

          {children}
        </div>
      </div>

      {footer}
      {overlays}
    </section>
  )
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type DeskModalDialogProps = {
  title: string
  closeLabel: string
  triggerRef?: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/**
 * Shared accessible modal dialog for SentinelDesk settings overlays.
 * Provides initial focus, Tab/Shift+Tab focus containment, capture-phase Escape close,
 * backdrop click close, and focus restoration to the opening trigger.
 */
export function DeskModalDialog({
  title,
  closeLabel,
  triggerRef,
  onClose,
  children,
  footer,
}: DeskModalDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialogEl = dialogRef.current
    dialogEl?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key === 'Tab' && dialogEl) {
        const focusables = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null,
        )
        if (focusables.length === 0) {
          event.preventDefault()
          dialogEl.focus()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (event.shiftKey) {
          if (!active || active === first || !dialogEl.contains(active)) {
            event.preventDefault()
            last.focus()
          }
        } else if (!active || active === last || !dialogEl.contains(active)) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const restoreTarget = triggerRef?.current ?? previouslyFocused
      restoreTarget?.focus()
    }
  }, [triggerRef])

  return (
    <div
      className="desk-shell-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="desk-shell-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="desk-shell-modal-head">
          <h2 id={titleId} className="desk-shell-modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="desk-shell-btn desk-shell-btn--icon"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <IconInline name="x" />
          </button>
        </div>

        <div className="desk-shell-modal-body">{children}</div>

        {footer ? <div className="desk-shell-modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}
