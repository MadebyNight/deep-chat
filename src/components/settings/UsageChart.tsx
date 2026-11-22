import { ActionButton } from "../base/index.js"
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { monthlyChatUsage, useChatUsage } from '../../services/chat/usage.js'
import { formatDate } from '../../utils/format.js'

export const UsageChart = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const days = useChatUsage((state) => state.days)
  const now = new Date()
  const month = monthlyChatUsage(days, now)
  const today = now.getDate()
  const [metric, setMetric] = useState<'calls' | 'tokens'>('calls')
  const [selectedDay, setSelectedDay] = useState(today)
  const selected = month[Math.min(selectedDay, today) - 1]
  const number = new Intl.NumberFormat(locale)
  const date = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' })
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' })
  const elapsed = month.slice(0, today)
  const totalCalls = elapsed.reduce((sum, day) => sum + day.calls, 0)
  const totalReported = elapsed.reduce((sum, day) => sum + day.reported, 0)
  const totalTokens = elapsed.reduce((sum, day) => sum + day.tokens, 0)
  const peak = Math.max(1, ...elapsed.map((day) => day[metric]))
  const firstWeekday = (month[0].date.getDay() + 6) % 7
  const dayDetail = (day: (typeof month)[number]) =>
    t('connectionUsageDay', {
      date: date.format(day.date),
      calls: number.format(day.calls),
      tokens: day.reported ? number.format(day.tokens) : '—',
    })

  return (
    <section className="connection-usage" aria-label={t('connectionLocalUsage')}>
      <div className="connection-usage-heading">
        <h3>{t('connectionMonthlyUsage')}</h3>
        <span>{monthLabel.format(now)}</span>
      </div>
      <div className="connection-usage-metrics">
        <ActionButton type="button" aria-pressed={metric === 'calls'} onClick={() => setMetric('calls')}>
          <span>{t('connectionUsageCalls')}</span>
          <strong>{number.format(totalCalls)}</strong>
        </ActionButton>
        <ActionButton type="button" aria-pressed={metric === 'tokens'} onClick={() => setMetric('tokens')}>
          <span>{t('connectionUsageTokens')}</span>
          <strong>{totalReported ? number.format(totalTokens) : '—'}</strong>
        </ActionButton>
      </div>
      <div className="connection-usage-weekdays" aria-hidden>
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index}>{weekday.format(new Date(2026, 10, 16 + index))}</span>
        ))}
      </div>
      <div className="connection-usage-chart">
        {month.map((day, index) => {
          const future = index >= today
          const level = !future && day[metric] > 0 ? Math.ceil((day[metric] / peak) * 4) : 0
          return (
            <ActionButton
              key={day.date.getTime()}
              type="button"
              data-date={formatDate(day.date)}
              data-level={level}
              disabled={future}
              aria-pressed={day.date.getDate() === selected.date.getDate()}
              aria-current={index === today - 1 ? 'date' : undefined}
              aria-label={future ? date.format(day.date) : dayDetail(day)}
              style={index === 0 ? { gridColumnStart: firstWeekday + 1 } : undefined}
              onClick={() => setSelectedDay(day.date.getDate())}
            >
              {day.date.getDate()}
            </ActionButton>
          )
        })}
      </div>
      <p className="connection-usage-detail" aria-live="polite">{dayDetail(selected)}</p>
    </section>
  )
}
