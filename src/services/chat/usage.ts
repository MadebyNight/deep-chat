import { create } from 'zustand'
import { formatDate } from '../../utils/format.js'
import type { MessageUsage } from '../api/types.js'

const STORAGE_KEY = 'deepchat:daily-chat-usage'
const RETAINED_DAYS = 62

export type DailyChatUsage = { calls: number; reported: number; tokens: number }
const EMPTY_DAY: DailyChatUsage = { calls: 0, reported: 0, tokens: 0 }
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const retainDays = (days: Record<string, DailyChatUsage>): Record<string, DailyChatUsage> =>
  Object.fromEntries(
    Object.keys(days)
      .sort()
      .slice(-RETAINED_DAYS)
      .map((key) => [key, days[key]])
  )

const load = (): Record<string, DailyChatUsage> | undefined => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return undefined
    }
    const days: Record<string, DailyChatUsage> = {}
    for (const [key, entry] of Object.entries(stored)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !entry || typeof entry !== 'object') {
        continue
      }
      const { calls, reported, tokens } = entry as Partial<DailyChatUsage>
      if (isCount(calls) && isCount(reported) && isCount(tokens) && reported <= calls) {
        days[key] = { calls, reported, tokens }
      }
    }
    return retainDays(days)
  } catch {
    return undefined
  }
}

export const useChatUsage = create(() => ({ days: load() ?? {} }))
let unpersistedUsage = false

export const refreshChatUsage = () => {
  if (unpersistedUsage) {
    return
  }
  const days = load()
  if (days) {
    useChatUsage.setState({ days })
  }
}

const updateDay = (key: string, update: (previous: DailyChatUsage) => DailyChatUsage) => {
  const { days } = useChatUsage.getState()
  const previous = days[key] ?? EMPTY_DAY
  const next = update(previous)
  if (next === previous) {
    return
  }
  const retained = retainDays({ ...days, [key]: next })
  useChatUsage.setState({ days: retained })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useChatUsage.getState().days))
    unpersistedUsage = false
  } catch {
    unpersistedUsage = true
  }
}

/** Counts chat requests on this device and records the final Token totals the API returns. */
export const recordChatRequest = (now = new Date()) => {
  const key = formatDate(now)
  if (!key) {
    return
  }
  updateDay(key, (day) => {
    const calls = day.calls + 1
    return isCount(calls) ? { ...day, calls } : day
  })
  let reported = false
  return (usage: MessageUsage) => {
    if (reported) {
      return
    }
    const {
      input_tokens: input,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
      output_tokens: output,
    } = usage
    if (![input, cached, written, output].every(isCount)) {
      return
    }
    const tokens = input + cached + written + output
    updateDay(key, (day) => {
      const total = day.tokens + tokens
      if (day.reported >= day.calls || !isCount(total)) {
        return day
      }
      reported = true
      return { ...day, reported: day.reported + 1, tokens: total }
    })
  }
}

export const monthlyChatUsage = (days: Record<string, DailyChatUsage>, now = new Date()) =>
  Array.from({ length: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), index + 1)
    const key = formatDate(date) ?? ''
    return { date, ...(days[key] ?? EMPTY_DAY) }
  })
