import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { monthlyChatUsage, useChatUsage } from '../../services/chat/usage.js'
import { formatCostLabel, NANOS_PER_YUAN } from '../../services/api/tokenPricing.js'
import { formatDate } from '../../utils/format.js'
import { ActionButton, IconChevronRightOutline14 } from '../base/index.js'
import styles from './Settings.module.css'

export const UsageChart = ({ onDetails }: { onDetails?: () => void }) => {
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
  const totalCostNanos = elapsed.reduce((sum, day) => sum + day.costNanos, 0)
  const cost = totalCostNanos / NANOS_PER_YUAN
  const costLabel = formatCostLabel(totalCostNanos, locale)
  // Logarithmic bands keep smaller days visible when a few days dominate the month.
  const values = elapsed.map((day) => day[metric]).filter((value) => value > 0)
  const floor = Math.log(Math.min(...values))
  const range = Math.log(Math.max(...values)) - floor
  const firstWeekday = (month[0].date.getDay() + 6) % 7
  const dayDetail = (day: (typeof month)[number]) =>
    t('connectionUsageDay', {
      date: date.format(day.date),
      calls: number.format(day.calls),
      tokens: day.reported ? number.format(day.tokens) : '—',
    })

  const compactNumber = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const compactCost = new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'CNY', currencyDisplay: 'narrowSymbol',
    notation: 'compact', maximumFractionDigits: 1,
  })
  const tokenLabel = totalReported ? number.format(totalTokens) : '—'
  const callsLabel = number.format(totalCalls)

  if (onDetails) {
    return (
      <ActionButton className={styles.usageSummary} onClick={onDetails}>
        <span className={styles.usageSummaryText}>
          <strong>{t('settingsConnectionDetails')}</strong>
          <span className={styles.usageSummaryTotal}>
            <span>
              <b>{totalReported ? number.format(totalTokens) : '—'}</b> Token
            </span>
            <span aria-hidden="true">·</span>
            <b>{costLabel}</b>
          </span>
        </span>
        <IconChevronRightOutline14 aria-hidden="true" />
      </ActionButton>
    )
  }

  return (
    <section className="connection-usage" aria-label={t('connectionLocalUsage')}>
      <div className="connection-usage-heading">
        <h3>{t('connectionMonthlyUsage')}</h3>
        <span>{monthLabel.format(now)}</span>
      </div>
      <div className="connection-usage-metrics">
        <div className="connection-usage-amount">
          <span>{t('connectionUsageAmount')}</span>
          <strong title={costLabel} aria-label={costLabel}>{cost >= 1000 && costLabel.length > 7 ? compactCost.format(cost) : costLabel}</strong>
        </div>
        <ActionButton
          type="button"
          aria-pressed={metric === 'tokens'}
          onClick={() => setMetric('tokens')}
        >
          <span>{t('connectionUsageTokens')}</span>
          <strong title={tokenLabel} aria-label={tokenLabel}>{tokenLabel.length > 7 ? compactNumber.format(totalTokens) : tokenLabel}</strong>
        </ActionButton>
        <ActionButton
          type="button"
          aria-pressed={metric === 'calls'}
          onClick={() => setMetric('calls')}
        >
          <span>{t('connectionUsageCalls')}</span>
          <strong title={callsLabel} aria-label={callsLabel}>{callsLabel.length > 7 ? compactNumber.format(totalCalls) : callsLabel}</strong>
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
          const value = day[metric]
          const level = future || value === 0 ? 0 : range > 0
            ? 1 + Math.round(3 * (Math.log(value) - floor) / range)
            : 2
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
      <p className="connection-usage-detail" aria-live="polite">
        {dayDetail(selected)}
      </p>
    </section>
  )
}
