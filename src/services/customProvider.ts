import { create } from 'zustand'
import { credentials, isNative } from './native.js'
import { readModelRates, type TokenRates } from './api/tokenPricing.js'

export type CustomProvider = { id: string; baseUrl: string; apiKey: string; model: string }
type ProviderConfig = Pick<CustomProvider, 'baseUrl' | 'apiKey'>
export type ProviderSettings = {
  version: 3
  providers: CustomProvider[]
  activeId: string | null
  /** 按尝试顺序排列的备用线路；不含当前主线路 */
  fallbackProviderIds: string[]
  /** 是否让同一会话继续优先使用上次成功的线路 */
  stickyProvider: boolean
}
const emptySettings: ProviderSettings = {
  version: 3,
  providers: [],
  activeId: null,
  fallbackProviderIds: [],
  stickyProvider: true,
}
const slot = 'customProvider' as const
export const useCustomProvider = create<
  ProviderSettings & {
    provider: CustomProvider | null
    enabled: boolean
    rates?: TokenRates
    /** 每个已配置供应商的费率缓存；备用线路也使用自己的费率。 */
    ratesById: Partial<Record<string, TokenRates>>
  }
>(() => ({ ...emptySettings, provider: null, enabled: false, ratesById: {} }))

export const normalizeProviderUrl = (value: string): string | undefined => {
  try {
    const input = value.trim()
    if (/[?#\\]/.test(input)) {
      return undefined
    }
    const url = new URL(input)
    if (!/^https:\/\//i.test(input) || url.username || url.password || url.protocol !== 'https:') {
      return undefined
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

export const isValidProviderKey = (value: string) => /^[\x21-\x7e]+$/.test(value)

export const providerRequest = (
  provider: ProviderConfig,
  path: 'models' | 'chat/completions',
  init: RequestInit
) =>
  fetch(`${provider.baseUrl}/${path}`, {
    ...init,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'no-store',
    headers: { ...init.headers, Authorization: `Bearer ${provider.apiKey}` },
  })

const readProviderModels = async (provider: ProviderConfig, signal: AbortSignal) => {
  const response = await providerRequest(provider, 'models', { signal })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('Model request failed')
  }
  return (await response.json()) as { data?: { id?: unknown }[] } | null
}

export const fetchProviderModels = async (provider: ProviderConfig, signal: AbortSignal) => {
  const result = await readProviderModels(provider, signal)
  if (!Array.isArray(result?.data)) {
    throw new Error('Invalid model list')
  }
  return [
    ...new Set(
      result.data.flatMap((item) =>
        typeof item?.id === 'string' && item.id.trim() ? [item.id] : []
      )
    ),
  ].sort((a, b) => a.localeCompare(b))
}

const pricingRequests = new Map<string, number>()
export const refreshProviderPricing = async (providerId?: string) => {
  const state = useCustomProvider.getState()
  const provider = providerId
    ? (state.providers.find((item) => item.id === providerId) ??
      (state.provider?.id === providerId ? state.provider : undefined))
    : state.provider
  if (!provider) {
    return
  }
  const request = (pricingRequests.get(provider.id) ?? 0) + 1
  pricingRequests.set(provider.id, request)
  let rates: TokenRates | undefined
  try {
    rates = readModelRates(
      await readProviderModels(provider, AbortSignal.timeout(5000)),
      provider.model
    )
  } catch {
    // A price lookup is optional; no reliable price is represented by undefined.
  }
  const current = useCustomProvider.getState()
  const currentProvider =
    current.providers.find((item) => item.id === provider.id) ??
    (current.provider?.id === provider.id ? current.provider : undefined)
  if (
    pricingRequests.get(provider.id) !== request ||
    !currentProvider ||
    currentProvider.baseUrl !== provider.baseUrl ||
    currentProvider.model !== provider.model
  ) {
    return
  }
  const ratesById = rates
    ? { ...current.ratesById, [provider.id]: rates }
    : Object.fromEntries(
        Object.entries(current.ratesById).filter(([id]) => id !== provider.id)
      )
  useCustomProvider.setState({
    ratesById,
    ...(current.provider?.id === provider.id ? { rates } : {}),
  })
}

const isProvider = (value: unknown): value is CustomProvider => {
  const item = value as Partial<CustomProvider> | null
  return (
    !!item &&
    typeof item.id === 'string' &&
    !!item.id &&
    typeof item.baseUrl === 'string' &&
    normalizeProviderUrl(item.baseUrl) === item.baseUrl &&
    typeof item.model === 'string' &&
    !!item.model.trim() &&
    typeof item.apiKey === 'string' &&
    isValidProviderKey(item.apiKey)
  )
}

export const readProviderSettings = (value: unknown): ProviderSettings => {
  const stored = value as {
    version?: unknown
    providers?: unknown
    activeId?: unknown
    fallbackProviderIds?: unknown
    stickyProvider?: unknown
    provider?: unknown
    enabled?: unknown
  } | null
  const fallbackIds = (providers: CustomProvider[], activeId: string | null) => {
    if (!Array.isArray(stored?.fallbackProviderIds)) {
      return []
    }
    const ids = new Set(providers.map(({ id }) => id))
    return [
      ...new Set(
        stored.fallbackProviderIds.filter(
          (id): id is string => typeof id === 'string' && id !== activeId && ids.has(id)
        )
      ),
    ]
  }
  if (
    (stored?.version === 2 || stored?.version === 3) &&
    Array.isArray(stored.providers) &&
    stored.providers.every(isProvider)
  ) {
    const ids = new Set(stored.providers.map(({ id }: CustomProvider) => id))
    const { activeId } = stored
    if (
      ids.size === stored.providers.length &&
      (activeId === null || (typeof activeId === 'string' && ids.has(activeId)))
    ) {
      return {
        version: 3,
        providers: stored.providers,
        activeId,
        fallbackProviderIds: fallbackIds(stored.providers, activeId),
        stickyProvider:
          stored.version === 3 && typeof stored.stickyProvider === 'boolean'
            ? stored.stickyProvider
            : true,
      }
    }
  }
  if (
    stored?.version === undefined &&
    isProvider(stored?.provider) &&
    typeof stored.enabled === 'boolean'
  ) {
    return {
      version: 3,
      providers: [stored.provider],
      activeId: stored.enabled ? stored.provider.id : null,
      fallbackProviderIds: [],
      stickyProvider: true,
    }
  }
  throw new Error('Invalid custom provider settings')
}

const applyProviderSettings = (settings: ProviderSettings) => {
  const previous = useCustomProvider.getState()
  const provider = settings.providers.find((item) => item.id === settings.activeId) ?? null
  const ratesById: Partial<Record<string, TokenRates>> = {}
  for (const item of settings.providers) {
    const previousProvider = previous.providers.find(({ id }) => id === item.id)
    const rates = previous.ratesById[item.id]
    if (
      rates &&
      previousProvider?.baseUrl === item.baseUrl &&
      previousProvider.model === item.model
    ) {
      ratesById[item.id] = rates
    }
  }
  useCustomProvider.setState({
    ...settings,
    provider,
    enabled: provider !== null,
    rates: provider ? ratesById[provider.id] : undefined,
    ratesById,
  })
  if (previous.provider !== provider) {
    void refreshProviderPricing()
  }
  const previousFallbacks = new Set(previous.fallbackProviderIds)
  for (const id of settings.fallbackProviderIds) {
    const item = settings.providers.find((candidate) => candidate.id === id)
    const previousProvider = previous.providers.find(({ id: previousId }) => previousId === id)
    if (
      item &&
      (!previousFallbacks.has(id) ||
        !previousProvider ||
        previousProvider.baseUrl !== item.baseUrl ||
        previousProvider.model !== item.model)
    ) {
      void refreshProviderPricing(id)
    }
  }
  return previous.enabled !== (provider !== null) || previous.provider?.id !== provider?.id
}

export const initializeCustomProvider = async (deadline: Promise<never>) => {
  if (!isNative) {
    return
  }
  try {
    const { value } = await Promise.race([credentials.read({ slot }), deadline])
    if (!value) {
      return
    }
    applyProviderSettings(readProviderSettings(JSON.parse(value)))
  } catch (error) {
    // Do not silently reroute a request when the selected credential cannot be opened.
    useCustomProvider.setState({ enabled: true, provider: null })
    throw error
  }
}

let saving = false
const persistProviderSettings = async (settings: ProviderSettings) => {
  if (saving) {
    throw new Error('Provider settings are busy')
  }
  saving = true
  try {
    if (isNative) {
      await credentials.write({ slot, value: JSON.stringify(settings) })
    }
    return applyProviderSettings(settings)
  } finally {
    saving = false
  }
}

export const saveCustomProvider = (provider: CustomProvider, previousId?: string) => {
  const { providers, activeId, fallbackProviderIds, stickyProvider } = useCustomProvider.getState()
  return persistProviderSettings({
    version: 3,
    providers: previousId
      ? providers.map((item) => (item.id === previousId ? provider : item))
      : [...providers, provider],
    activeId: previousId && activeId === previousId ? provider.id : activeId,
    fallbackProviderIds: fallbackProviderIds.map((id) =>
      previousId && id === previousId ? provider.id : id
    ),
    stickyProvider,
  })
}

export const selectCustomProvider = (id: string | null) => {
  const { providers, fallbackProviderIds, stickyProvider } = useCustomProvider.getState()
  return persistProviderSettings({
    version: 3,
    providers,
    activeId: id,
    fallbackProviderIds: fallbackProviderIds.filter((providerId) => providerId !== id),
    stickyProvider,
  })
}

export const removeCustomProvider = (id: string) => {
  const { providers, activeId, fallbackProviderIds, stickyProvider } = useCustomProvider.getState()
  return persistProviderSettings({
    version: 3,
    providers: providers.filter((item) => item.id !== id),
    activeId: activeId === id ? null : activeId,
    fallbackProviderIds: fallbackProviderIds.filter((providerId) => providerId !== id),
    stickyProvider,
  })
}

export const setFallbackProviders = (fallbackProviderIds: string[]) => {
  const { providers, activeId, stickyProvider } = useCustomProvider.getState()
  const ids = new Set(providers.map(({ id }) => id))
  return persistProviderSettings({
    version: 3,
    providers,
    activeId,
    fallbackProviderIds: [
      ...new Set(fallbackProviderIds.filter((id) => id !== activeId && ids.has(id))),
    ],
    stickyProvider,
  })
}

export const setStickyProvider = (stickyProvider: boolean) => {
  const { providers, activeId, fallbackProviderIds } = useCustomProvider.getState()
  return persistProviderSettings({
    version: 3,
    providers,
    activeId,
    fallbackProviderIds,
    stickyProvider,
  })
}

/**
 * 稳定的通道路由顺序：粘性会话优先上次成功线路，否则主线路优先；
 * 之后严格按用户配置的备用顺序尝试。主线路始终作为备用线路失败后的恢复项。
 */
export const providerRoute = (
  settings: Pick<ProviderSettings, 'providers' | 'activeId' | 'fallbackProviderIds' | 'stickyProvider'>,
  pinnedProviderId?: string | null
) => {
  const byId = new Map(settings.providers.map((provider) => [provider.id, provider]))
  const orderedIds: string[] = []
  const add = (id: string | null | undefined) => {
    if (id && !orderedIds.includes(id) && byId.has(id)) {
      orderedIds.push(id)
    }
  }
  if (settings.stickyProvider) {
    add(pinnedProviderId)
  }
  add(settings.activeId)
  for (const id of settings.fallbackProviderIds) {
    add(id)
  }
  return orderedIds.flatMap((id) => {
    const provider = byId.get(id)
    return provider ? [provider] : []
  })
}

export const matchesChatProvider = (
  sessionProviderId: string | undefined,
  enabled: boolean,
  providerId?: string
) => (enabled ? !!providerId && sessionProviderId === providerId : !sessionProviderId)
