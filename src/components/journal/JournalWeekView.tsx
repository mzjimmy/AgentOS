/**
 * 周视图（周一至周日 7 栏概览）：展示每日摘要片段与缩略图，点击日期跳转至对应日散页视图。
 * 7-column Mon–Sun week overview showing time, snippets, and photo thumbnails; clicking jumps to that day.
 */

import { useI18n } from '../../i18n/i18n'
import type { JournalWeekDay } from '../../journal-contract'
import {
  formatCalendarDayNumber,
  formatShortWeekday,
  getJournalCategorySlug,
  summarizeEntrySnippet,
} from './journal-ui-helpers'

type JournalWeekViewProps = {
  days: JournalWeekDay[]
  selectedDate: string
  todayDate: string
  imageCache: Record<string, string>
  onSelectDay: (date: string) => void
}

export function JournalWeekView({
  days,
  selectedDate,
  todayDate,
  imageCache,
  onSelectDay,
}: JournalWeekViewProps) {
  const { locale, t } = useI18n()

  return (
    <div className="journal-week-grid" role="grid" aria-label={t('journal.weekViewLabel')}>
      {days.map((day) => {
        const isSelected = day.date === selectedDate
        const isToday = day.date === todayDate
        const count = day.entries.length
        return (
          <section
            key={day.date}
            className={`journal-week-col${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}`}
          >
            <button
              type="button"
              className="journal-week-col-head"
              onClick={() => onSelectDay(day.date)}
            >
              <span className="journal-week-col-weekday">
                {formatShortWeekday(day.date, locale)}
              </span>
              <span className="journal-week-col-num">
                {formatCalendarDayNumber(day.date)}
              </span>
              {count > 0 ? (
                <span className="journal-week-col-count">{count}</span>
              ) : null}
            </button>

            <div className="journal-week-col-list">
              {count === 0 ? (
                <button
                  type="button"
                  className="journal-week-empty-slot"
                  onClick={() => onSelectDay(day.date)}
                >
                  {t('journal.weekDayEmpty')}
                </button>
              ) : (
                day.entries.map((entry) => {
                  const thumb = entry.images[0] ? imageCache[entry.images[0].relativePath] : undefined
                  const snippet = summarizeEntrySnippet(
                    entry.momentTitle || entry.body,
                    44,
                  )
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`journal-week-item${entry.kind === 'ai' ? ' is-ai' : ''}`}
                      onClick={() => onSelectDay(day.date)}
                    >
                      <div className="journal-week-item-meta">
                        <span className="journal-week-item-time">{entry.time}</span>
                        <span
                          className={`journal-week-cat-dot journal-cat-dot--${getJournalCategorySlug(entry.category)}`}
                          title={entry.category}
                        />
                      </div>
                      {thumb ? (
                        <div className="journal-week-item-thumb-wrap">
                          <img
                            src={thumb}
                            alt={entry.images[0]?.caption || entry.images[0]?.fileName || ''}
                            className="journal-week-item-thumb"
                            loading="lazy"
                          />
                        </div>
                      ) : null}
                      {snippet ? (
                        <p className="journal-week-item-text">{snippet}</p>
                      ) : entry.images.length > 0 ? (
                        <p className="journal-week-item-text">
                          {t('journal.photoCount', { n: entry.images.length })}
                        </p>
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
