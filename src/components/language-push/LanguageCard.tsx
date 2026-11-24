import { useState } from 'react'
import { IconInline } from '../../icon-inline'
import { useI18n } from '../../i18n/i18n'
import {
  LANGUAGE_PUSH_FUZZY_INTERVAL_DAYS,
  type LanguagePushCard,
  type LanguagePushDecisionAction,
} from '../../language-push-contract'

export type LanguageCardProps = {
  card: LanguagePushCard
  speakingKey: string | null
  isPlaylistActive?: boolean
  busy: boolean
  cardRef?: (el: HTMLElement | null) => void
  onSpeak: (
    key: string,
    text: string,
    lang: LanguagePushCard['lang'],
    pronunciations?: Array<{ surface: string; reading: string }>,
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
  speakingKey,
  isPlaylistActive = false,
  busy,
  cardRef,
  onSpeak,
  onDecide,
  onNavigateToJournalAnchor,
}: LanguageCardProps) {
  const { t } = useI18n()
  const [showTranslation, setShowTranslation] = useState(true)

  const termKey = `${card.id}:term`
  const exampleKey = `${card.id}:example`
  const isSpeakingTerm = speakingKey === termKey
  const isSpeakingExample = speakingKey === exampleKey
  const nextFuzzyDays = nextFuzzyIntervalDays(card.exposures)
  const jaHints =
    card.lang === 'ja'
      ? [
          ...(card.example.pronunciations ?? []),
          ...(card.reading ? [{ surface: card.surface, reading: card.reading }] : []),
        ]
      : undefined

  const cardClasses = [
    'lp-card',
    card.familiarity === 'unfamiliar' ? 'lp-card-unfamiliar' : '',
    card.status === 'mastered' ? 'lp-card-mastered' : '',
    isPlaylistActive ? 'lp-card-playing' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const freqCount = Math.max(card.seenDays, card.corpusFreq ?? 1)

  return (
    <article ref={cardRef} className={cardClasses}>
      <div className="lp-card-top">
        <span className={`lp-chip lp-chip-lang-${card.lang}`}>{card.lang === 'ja' ? 'JA 日语' : 'EN 英语'}</span>
        <span className={`lp-chip lp-chip-kind-${card.kind}`}>
          {card.kind === 'grammar' ? t('languagePush.kindGrammar') : t('languagePush.kindVocab')}
        </span>
        {card.levelTag ? <span className="lp-chip lp-chip-level">{card.levelTag}</span> : null}
        {card.isExpansion ? <span className="lp-chip lp-chip-expansion">{t('languagePush.expansionBadge')}</span> : null}
        {freqCount >= 2 ? (
          <span className="lp-chip lp-chip-freq">{t('languagePush.freqBadge', { count: freqCount })}</span>
        ) : null}
        {card.familiarity === 'unfamiliar' ? (
          <span className="lp-fam-mark lp-fam-mark-unfamiliar">{t('languagePush.familiarityUnfamiliar')}</span>
        ) : card.familiarity === 'fuzzy' ? (
          <span className="lp-fam-mark lp-fam-mark-fuzzy">{t('languagePush.familiarityFuzzy')}</span>
        ) : null}
        <span className="lp-meta">
          {card.exposures > 0
            ? t('languagePush.reviewCount', { count: card.exposures })
            : t('languagePush.newBadge')}
        </span>
      </div>

      <div className="lp-hero">
        <div className="lp-hero-copy">
          <h2 className="lp-surface">{card.surface}</h2>
          {card.reading ? <p className="lp-reading">{card.reading}</p> : null}
        </div>
        <button
          type="button"
          className={isSpeakingTerm ? 'lp-speak-btn lp-speak-btn-active' : 'lp-speak-btn'}
          title={t('languagePush.speakWord')}
          aria-label={t('languagePush.speakWord')}
          onClick={() => onSpeak(termKey, card.surface, card.lang, jaHints)}
        >
          <IconInline name="play" />
          <span>{isSpeakingTerm ? t('languagePush.speaking') : t('languagePush.speak')}</span>
        </button>
      </div>

      <p className="lp-meaning">{card.meaning}</p>

      {card.grammarNote ? (
        <div className="lp-note">
          <span className="lp-note-label">{t('languagePush.usageNote')}</span>
          <p className="lp-note-text">{card.grammarNote}</p>
        </div>
      ) : null}

      <div className="lp-example-box">
        <div className="lp-example-head">
          <span className="lp-example-label">{t('languagePush.exampleLabel')}</span>
          <div className="lp-example-tools">
            <button
              type="button"
              className={isSpeakingExample ? 'lp-mini-btn lp-mini-btn-active' : 'lp-mini-btn'}
              onClick={() => onSpeak(exampleKey, card.example.sentence, card.lang, jaHints)}
            >
              <IconInline name="play" />
              <span>{t('languagePush.speakExample')}</span>
            </button>
            {card.example.translation ? (
              <button
                type="button"
                className="lp-mini-btn"
                onClick={() => setShowTranslation((prev) => !prev)}
              >
                {showTranslation ? t('languagePush.hideGloss') : t('languagePush.showGloss')}
              </button>
            ) : null}
            {card.example.sourceDate && onNavigateToJournalAnchor ? (
              <button
                type="button"
                className="lp-anchor-btn"
                title={t('languagePush.jumpJournal')}
                onClick={() => onNavigateToJournalAnchor(card.example.sourceDate, card.example.sourceEntryId || '')}
              >
                {card.example.sourceDate}
              </button>
            ) : null}
          </div>
        </div>
        <p className="lp-example-sentence">{card.example.sentence}</p>
        {showTranslation && card.example.translation ? (
          <p className="lp-example-gloss">{card.example.translation}</p>
        ) : null}
      </div>

      <div className="lp-actions lp-actions-rating" role="group" aria-label={t('languagePush.ratingGroupLabel')}>
        {card.status === 'mastered' ? (
          <button
            type="button"
            className="lp-btn"
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
                  ? 'lp-btn lp-btn-rating lp-btn-unfamiliar lp-btn-rating-selected'
                  : 'lp-btn lp-btn-rating lp-btn-unfamiliar'
              }
              disabled={busy}
              title={t('languagePush.unfamiliarHint')}
              onClick={() => onDecide(card.id, 'unfamiliar')}
            >
              <span>{t('languagePush.actionUnfamiliar')}</span>
            </button>
            <button
              type="button"
              className={
                card.familiarity === 'fuzzy'
                  ? 'lp-btn lp-btn-rating lp-btn-fuzzy lp-btn-rating-selected'
                  : 'lp-btn lp-btn-rating lp-btn-fuzzy'
              }
              disabled={busy}
              title={t('languagePush.fuzzyHint', { days: nextFuzzyDays })}
              onClick={() => onDecide(card.id, 'fuzzy')}
            >
              <span>{t('languagePush.actionFuzzy')}</span>
            </button>
            <button
              type="button"
              className="lp-btn lp-btn-rating lp-btn-familiar"
              disabled={busy}
              title={t('languagePush.familiarHint')}
              onClick={() => onDecide(card.id, 'familiar')}
            >
              <IconInline name="check" />
              <span>{t('languagePush.actionFamiliar')}</span>
            </button>
          </>
        )}
      </div>
    </article>
  )
}
