import { useState } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS,
  type LanguagePushCard,
  type LanguagePushDecisionAction,
  type LanguagePushPronunciationHint,
} from '../../language-push-contract'
import type { LanguagePushPlayPhase } from './language-push-player'

export type LanguageCardProps = {
  card: LanguagePushCard
  isOpen: boolean
  isActive: boolean
  activePhase: LanguagePushPlayPhase
  busy: boolean
  cardRef?: (el: HTMLElement | null) => void
  onToggleOpen: (cardId: string) => void
  onPlaySingle: (card: LanguagePushCard) => void
  onPlayFromHere: (cardId: string) => void
  onPreview: (
    text: string,
    lang: LanguagePushCard['lang'],
    pronunciations?: LanguagePushPronunciationHint[],
  ) => void
  onDecide: (cardId: string, action: LanguagePushDecisionAction) => void
  onNavigateToJournalAnchor?: (date: string, entryId: string) => void
}

function nextFuzzyIntervalDays(exposures: number): number {
  const idx = Math.min(Math.max(0, Math.floor(exposures)), LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS.length - 1)
  return LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS[idx]
}

export function LanguageCard({
  card,
  isOpen,
  isActive,
  activePhase,
  busy,
  cardRef,
  onToggleOpen,
  onPlaySingle,
  onPlayFromHere,
  onPreview,
  onDecide,
  onNavigateToJournalAnchor,
}: LanguageCardProps) {
  const { t } = useI18n()
  const [showTranslation, setShowTranslation] = useState(true)

  const isMorningBrief = card.example.sourceKind === 'morning_brief'
  const isTermSpeaking = isActive && activePhase === 'term'
  const isExampleSpeaking = isActive && activePhase === 'example'
  const nextFuzzyDays = nextFuzzyIntervalDays(card.exposures)
  const jaHints =
    card.lang === 'ja'
      ? [
          ...(card.example.pronunciations ?? []),
          ...(card.reading ? [{ surface: card.surface, reading: card.reading }] : []),
        ]
      : undefined
  const chipLabel = card.levelTag
    ? `${card.lang.toUpperCase()} · ${card.levelTag}`
    : card.lang.toUpperCase()

  const rowClasses = [
    'lp-row',
    isOpen ? 'lp-row-open' : '',
    isActive ? 'lp-row-active' : '',
    card.status === 'mastered' ? 'lp-row-mastered' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article ref={cardRef} className={rowClasses}>
      <div
        className="lp-row-bar"
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => onToggleOpen(card.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggleOpen(card.id)
          }
        }}
      >
        <button
          type="button"
          className={isActive ? 'lp-row-play-btn lp-row-play-btn-active' : 'lp-row-play-btn'}
          title={isActive ? t('languagePush.stopPlayback') : t('languagePush.speakWord')}
          aria-label={isActive ? t('languagePush.stopPlayback') : t('languagePush.speakWord')}
          onClick={(event) => {
            event.stopPropagation()
            onPlaySingle(card)
          }}
        >
          {isActive ? (
            <span className="desk-audio-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <IconInline name="play" />
          )}
        </button>
        <span className={`lp-chip lp-chip-lang-${card.lang}`}>{chipLabel}</span>
        <span className={isTermSpeaking ? 'lp-row-surface lp-row-speaking' : 'lp-row-surface'}>
          {card.surface}
        </span>
        <span className="lp-row-reading">{card.reading}</span>
        <span className="lp-row-meaning">{card.meaning}</span>
        <span
          className="lp-row-side"
          role="group"
          aria-label={t('languagePush.ratingGroupLabel')}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {card.status === 'mastered' ? (
            <button
              type="button"
              className="lp-rate-btn"
              disabled={busy}
              onClick={() => onDecide(card.id, 'restore')}
            >
              <IconInline name="undo" />
              <span>{t('languagePush.restore')}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={
                  card.familiarity === 'unfamiliar'
                    ? 'lp-rate-btn lp-rate-unfamiliar lp-rate-selected'
                    : 'lp-rate-btn lp-rate-unfamiliar'
                }
                disabled={busy}
                title={t('languagePush.unfamiliarHint')}
                onClick={() => onDecide(card.id, 'unfamiliar')}
              >
                {t('languagePush.actionUnfamiliar')}
              </button>
              <button
                type="button"
                className={
                  card.familiarity === 'fuzzy'
                    ? 'lp-rate-btn lp-rate-fuzzy lp-rate-selected'
                    : 'lp-rate-btn lp-rate-fuzzy'
                }
                disabled={busy}
                title={t('languagePush.fuzzyHint', { days: nextFuzzyDays })}
                onClick={() => onDecide(card.id, 'fuzzy')}
              >
                {t('languagePush.actionFuzzy')}
              </button>
              <button
                type="button"
                className="lp-rate-btn lp-rate-familiar"
                disabled={busy}
                title={t('languagePush.familiarHint')}
                onClick={() => onDecide(card.id, 'familiar')}
              >
                {t('languagePush.actionFamiliar')}
              </button>
            </>
          )}
        </span>
      </div>

      <div className={isOpen ? 'lp-drawer-wrap lp-drawer-open' : 'lp-drawer-wrap'}>
        <div className="lp-drawer-inner">
          <div className="lp-drawer">
            <div className="lp-drawer-head">
              <div className={isTermSpeaking ? 'lp-drawer-term-box lp-drawer-term-speaking' : 'lp-drawer-term-box'}>
                <h3 className="lp-drawer-surface">{card.surface}</h3>
                {card.reading ? <p className="lp-drawer-reading">{card.reading}</p> : null}
              </div>
              <div className="lp-drawer-side">
                {isMorningBrief ? (
                  <span className="lp-meta">
                    {t('languagePush.sourceMorningBrief', { date: card.example.sourceDate })}
                  </span>
                ) : card.example.sourceDate && onNavigateToJournalAnchor ? (
                  <button
                    type="button"
                    className="lp-anchor-btn"
                    title={t('languagePush.jumpJournal')}
                    onClick={() => onNavigateToJournalAnchor(card.example.sourceDate, card.example.sourceEntryId || '')}
                  >
                    {card.example.sourceDate}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="lp-mini-btn"
                  onClick={() => onPreview(card.surface, card.lang, jaHints)}
                >
                  <IconInline name="play" />
                  <span>{t('languagePush.speakWord')}</span>
                </button>
                <button
                  type="button"
                  className="lp-mini-btn"
                  onClick={() => onPreview(card.example.sentence, card.lang, jaHints)}
                >
                  <IconInline name="play" />
                  <span>{t('languagePush.speakExample')}</span>
                </button>
                <button type="button" className="lp-mini-btn" onClick={() => onPlayFromHere(card.id)}>
                  <IconInline name="play" />
                  <span>{t('languagePush.playFromHere')}</span>
                </button>
              </div>
            </div>

            {card.grammarNote ? (
              <div className="lp-drawer-note">
                <span className="lp-note-label">{t('languagePush.usageNote')}</span>
                <p className="lp-note-text">{card.grammarNote}</p>
              </div>
            ) : null}

            <div className={isExampleSpeaking ? 'lp-drawer-ex-card lp-drawer-ex-speaking' : 'lp-drawer-ex-card'}>
              <div className="lp-drawer-ex-head">
                <span className="lp-example-label">
                  {isMorningBrief ? t('languagePush.exampleLabelMorningBrief') : t('languagePush.exampleLabel')}
                </span>
                {card.example.translation ? (
                  <button type="button" className="lp-mini-btn" onClick={() => setShowTranslation((prev) => !prev)}>
                    {showTranslation ? t('languagePush.hideGloss') : t('languagePush.showGloss')}
                  </button>
                ) : null}
              </div>
              <p className="lp-example-sentence">{card.example.sentence}</p>
              {showTranslation && card.example.translation ? (
                <p className="lp-example-gloss">{card.example.translation}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </article>
  )
}
