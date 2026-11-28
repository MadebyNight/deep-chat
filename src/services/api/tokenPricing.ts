import type { ChatModel, MessageUsage } from './types.js'

export type TokenRates = { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export type UsageCost = { costNanos: number; cacheSavedNanos: number }
export const NANOS_PER_YUAN = 1_000_000_000
export const OFFICIAL_API_ORIGIN = 'https://api.deepseek.com'

const DEEPSEEK_RATES: Record<ChatModel, { offPeak: TokenRates; peak: TokenRates }> = {
  'deepseek-flash': {
    offPeak: { input: 1e-6, output: 4e-6, cacheRead: 0.02e-6 },
    peak: { input: 2e-6, output: 8e-6, cacheRead: 0.04e-6 },
  },
  'deepseek-v4-pro': {
    offPeak: { input: 4.5e-6, output: 13.5e-6, cacheRead: 0.15e-6 },
    peak: { input: 9e-6, output: 27e-6, cacheRead: 0.3e-6 },
  },
}

export const formatCostLabel = (costNanos: number, locale: string): string => {
  const cost = costNanos / NANOS_PER_YUAN
  const displayedCost = costNanos > 0 && costNanos < NANOS_PER_YUAN / 100 ? 0 : cost
  return `¥${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(displayedCost)}`
}

export const tokenCost = (usage: MessageUsage, rates?: TokenRates) => {
  if (!rates) {
    return undefined
  }
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    usage
  if (
    (cache_read_input_tokens && rates.cacheRead === undefined) ||
    (cache_creation_input_tokens && rates.cacheWrite === undefined)
  ) {
    return undefined
  }
  const cost = Math.round(
    NANOS_PER_YUAN *
      (input_tokens * rates.input +
        output_tokens * rates.output +
        cache_read_input_tokens * (rates.cacheRead ?? 0) +
        cache_creation_input_tokens * (rates.cacheWrite ?? 0))
  )
  return Number.isSafeInteger(cost) && cost >= 0 ? cost : undefined
}

/**
 * 缓存节省 = 命中 Token ×（未命中的输入单价 - 缓存读取单价）。
 * 缓存读取单价未知时无法可靠估算，返回 undefined；没有命中时节省为 0。
 */
export const tokenCacheSavings = (usage: MessageUsage, rates?: TokenRates) => {
  if (!rates) {
    return undefined
  }
  const cacheRead = usage.cache_read_input_tokens
  if (cacheRead > 0 && rates.cacheRead === undefined) {
    return undefined
  }
  const savings = Math.round(
    NANOS_PER_YUAN * cacheRead * Math.max(0, rates.input - (rates.cacheRead ?? 0))
  )
  return Number.isSafeInteger(savings) && savings >= 0 ? savings : undefined
}

/** 单轮估算费用与缓存节省必须来自同一套费率，缺任一项时不展示不完整金额。 */
export const tokenUsageCost = (usage: MessageUsage, rates?: TokenRates): UsageCost | undefined => {
  const costNanos = tokenCost(usage, rates)
  const cacheSavedNanos = tokenCacheSavings(usage, rates)
  return costNanos === undefined || cacheSavedNanos === undefined
    ? undefined
    : { costNanos, cacheSavedNanos }
}

// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
export const deepSeekRates = (
  origin: string,
  model: ChatModel,
  now: Date
): TokenRates | undefined => {
  if (origin !== OFFICIAL_API_ORIGIN) {
    return undefined
  }
  const table = Object.hasOwn(DEEPSEEK_RATES, model) ? DEEPSEEK_RATES[model] : undefined
  if (!table) {
    return undefined
  }
  const beijing = new Date(now.getTime() + 8 * 3600_000)
  const day = beijing.getUTCDay(),
    hour = beijing.getUTCHours()
  // Peak windows on weekdays (CST); without a holiday calendar, apply peak rates rather than dropping to 0.
  const peak = day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
  return peak ? table.peak : table.offPeak
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const decimal = (value: unknown) => {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(value.trim()))
  ) {
    return undefined
  }
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

/** Supported /models extension: pricing with explicit currency, unit and token rates. */
export const readModelRates = (response: unknown, model: string): TokenRates | undefined => {
  const data = asRecord(response)?.data
  if (!Array.isArray(data)) {
    return undefined
  }
  const entry = data.map(asRecord).find((item) => item?.id === model)
  const price = asRecord(entry?.pricing)
  if (!price) {
    return undefined
  }
  const unit =
    price.unit === 'per_token' ? 1 : price.unit === 'per_million_tokens' ? 1e6 : undefined
  const toCny = price.currency === 'CNY' ? 1 : undefined
  if (unit === undefined || toCny === undefined) {
    return undefined
  }
  const input = decimal(price.prompt ?? price.input),
    output = decimal(price.completion ?? price.output)
  if (input === undefined || output === undefined) {
    return undefined
  }
  const read = decimal(price.input_cache_read ?? price.cache_read)
  const write = decimal(price.input_cache_write ?? price.cache_write)
  const scale = toCny / unit
  return {
    input: input * scale,
    output: output * scale,
    cacheRead: read === undefined ? undefined : read * scale,
    cacheWrite: write === undefined ? undefined : write * scale,
  }
}
