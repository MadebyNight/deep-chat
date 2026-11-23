import type { ChatModel, MessageUsage } from './types.js'

export type TokenRates = { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export const NANOS_PER_YUAN = 1_000_000_000

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

// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
export const deepSeekRates = (
  origin: string,
  model: ChatModel,
  now: Date
): TokenRates | undefined => {
  if (origin !== 'https://api.deepseek.com') {
    return undefined
  }
  const beijing = new Date(now.getTime() + 8 * 3600_000)
  const day = beijing.getUTCDay(),
    hour = beijing.getUTCHours()
  // A weekday in a peak window may be a public holiday; there is no billing calendar in the app.
  if (day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))) {
    return undefined
  }
  if (model === 'deepseek-flash') {
    return { input: 1e-6, output: 4e-6, cacheRead: 0.02e-6 }
  }
  if (model === 'deepseek-v4-pro') {
    return { input: 4.5e-6, output: 13.5e-6, cacheRead: 0.15e-6 }
  }
  return undefined
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
