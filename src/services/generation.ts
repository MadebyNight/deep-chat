import type { ChatModel, CreateMessageRequest } from './api/types.js'

export type GenerationPreset = 'precise' | 'balanced' | 'creative'

/** 全局默认与会话覆盖共用的生成参数；preset 为 null 表示手动组合。 */
export type GenerationParams = {
  model: ChatModel
  maxTokens: number
  temperature: number
  topP: number
  preset: GenerationPreset | null
}

type GenerationPresetValues = Pick<GenerationParams, 'maxTokens' | 'temperature' | 'topP'>

export const CHAT_MODELS = [
  'deepseek-flash',
  'deepseek-v4-pro',
] as const satisfies readonly ChatModel[]

export const GENERATION_LIMITS = {
  maxTokens: { min: 1, max: 393_216 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
} as const

export const GENERATION_PRESETS: Record<GenerationPreset, GenerationPresetValues> = {
  precise: { maxTokens: 65_536, temperature: 0.2, topP: 0.8 },
  balanced: { maxTokens: 65_536, temperature: 1, topP: 1 },
  creative: { maxTokens: 65_536, temperature: 1.5, topP: 1 },
}

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  model: 'deepseek-flash',
  ...GENERATION_PRESETS.balanced,
  preset: 'balanced',
}

export const isChatModel = (value: unknown): value is ChatModel =>
  CHAT_MODELS.includes(value as ChatModel)

const inRange = (value: unknown, limits: { min: number; max: number }): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= limits.min &&
  value <= limits.max

export const generationPresetFor = (
  params: Pick<GenerationParams, 'maxTokens' | 'temperature' | 'topP'>
): GenerationPreset | null =>
  (Object.entries(GENERATION_PRESETS) as [GenerationPreset, GenerationPresetValues][]).find(
    ([, values]) =>
      values.maxTokens === params.maxTokens &&
      values.temperature === params.temperature &&
      values.topP === params.topP
  )?.[0] ?? null

/** 只接受完整合法值；存储损坏或外部输入不能把无效参数送进请求。 */
export const parseGenerationParams = (value: unknown): GenerationParams | undefined => {
  if (!value || typeof value !== 'object') {
    return
  }
  const params = value as Partial<GenerationParams>
  const { maxTokens, temperature, topP, model } = params
  if (
    !isChatModel(model) ||
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < GENERATION_LIMITS.maxTokens.min ||
    maxTokens > GENERATION_LIMITS.maxTokens.max ||
    !inRange(temperature, GENERATION_LIMITS.temperature) ||
    !inRange(topP, GENERATION_LIMITS.topP)
  ) {
    return
  }
  const values = {
    maxTokens,
    temperature,
    topP,
  }
  return {
    model,
    ...values,
    preset: generationPresetFor(values),
  }
}

export const normalizeGenerationParams = (
  value: unknown,
  fallback: GenerationParams = DEFAULT_GENERATION_PARAMS
): GenerationParams => parseGenerationParams(value) ?? fallback

export const applyGenerationPreset = (
  params: GenerationParams,
  preset: GenerationPreset
): GenerationParams => ({
  ...params,
  ...GENERATION_PRESETS[preset],
  preset,
})

export type AnthropicGenerationFields = {
  model: ChatModel
  max_tokens: number
  temperature?: number
  top_p?: number
}

/**
 * 官方账号协议与 DeepSeek 思考模式不接受采样参数。
 * 其它官方 API Key 请求在关闭思考时发送完整参数；不在收到 400 后静默降级。
 */
export const anthropicGenerationFields = (
  params: GenerationParams,
  capabilities: { officialAccount: boolean; thinking: boolean }
): AnthropicGenerationFields => ({
  model: params.model,
  max_tokens: params.maxTokens,
  ...(capabilities.officialAccount || capabilities.thinking
    ? {}
    : { temperature: params.temperature, top_p: params.topP }),
})

type AnthropicRequestBase = Omit<
  CreateMessageRequest,
  'model' | 'max_tokens' | 'temperature' | 'top_p'
>

/** Anthropic 兼容请求的唯一参数拼装入口，供聊天与后续多轮工具调用复用。 */
export const createAnthropicRequest = (
  base: AnthropicRequestBase,
  params: GenerationParams,
  capabilities: { officialAccount: boolean; thinking: boolean }
): CreateMessageRequest => ({
  ...base,
  ...anthropicGenerationFields(params, capabilities),
})

export type CustomGenerationFields = {
  max_tokens: number
  temperature: number
  top_p: number
}

/** 自定义供应商按 OpenAI Chat Completions 协议完整透传生成参数。 */
export const customGenerationFields = (
  params: Pick<GenerationParams, 'maxTokens' | 'temperature' | 'topP'>
): CustomGenerationFields => ({
  max_tokens: params.maxTokens,
  temperature: params.temperature,
  top_p: params.topP,
})
