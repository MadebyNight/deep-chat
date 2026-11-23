import { create } from 'zustand'
import { credentials, isNative } from './native.js'
import { readModelRates, type TokenRates } from './api/tokenPricing.js'

export type CustomProvider = { id: string; baseUrl: string; apiKey: string; model: string }
type ProviderConfig = Pick<CustomProvider, 'baseUrl' | 'apiKey'>
type ProviderSettings = { version: 2; providers: CustomProvider[]; activeId: string | null }
const emptySettings: ProviderSettings = { version: 2, providers: [], activeId: null }
const slot = 'customProvider' as const
export const useCustomProvider = create<
  ProviderSettings & {
    provider: CustomProvider | null
    enabled: boolean
    rates?: TokenRates
  }
>(() => ({ ...emptySettings, provider: null, enabled: false }))

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

let priceRequest = 0
export const refreshProviderPricing = async () => {
  const { provider } = useCustomProvider.getState()
  if (!provider) {
    return
  }
  const request = ++priceRequest
  let rates: TokenRates | undefined
  try {
    rates = readModelRates(
      await readProviderModels(provider, AbortSignal.timeout(5000)),
      provider.model
    )
  } catch {
    // A price lookup is optional; no reliable price is represented by undefined.
  }
  if (request === priceRequest && provider === useCustomProvider.getState().provider) {
    useCustomProvider.setState({ rates })
  }
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
    provider?: unknown
    enabled?: unknown
  } | null
  if (
    stored?.version === 2 &&
    Array.isArray(stored.providers) &&
    stored.providers.every(isProvider)
  ) {
    const ids = new Set(stored.providers.map(({ id }: CustomProvider) => id))
    const { activeId } = stored
    if (
      ids.size === stored.providers.length &&
      (activeId === null || (typeof activeId === 'string' && ids.has(activeId)))
    ) {
      return { version: 2, providers: stored.providers, activeId }
    }
  }
  if (
    stored?.version === undefined &&
    isProvider(stored?.provider) &&
    typeof stored.enabled === 'boolean'
  ) {
    return {
      version: 2,
      providers: [stored.provider],
      activeId: stored.enabled ? stored.provider.id : null,
    }
  }
  throw new Error('Invalid custom provider settings')
}

const applyProviderSettings = (settings: ProviderSettings) => {
  const previous = useCustomProvider.getState()
  const provider = settings.providers.find((item) => item.id === settings.activeId) ?? null
  useCustomProvider.setState({
    ...settings,
    provider,
    enabled: provider !== null,
    rates: previous.provider === provider ? previous.rates : undefined,
  })
  if (previous.provider !== provider) {
    void refreshProviderPricing()
  }
  return previous.enabled !== (provider !== null) || previous.provider?.id !== provider?.id
}

export const initializeCustomProvider = async () => {
  if (!isNative) {
    return
  }
  try {
    const { value } = await credentials.read({ slot })
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
  const { providers, activeId } = useCustomProvider.getState()
  return persistProviderSettings({
    version: 2,
    providers: previousId
      ? providers.map((item) => (item.id === previousId ? provider : item))
      : [...providers, provider],
    activeId: previousId && activeId === previousId ? provider.id : activeId,
  })
}

export const selectCustomProvider = (id: string | null) => {
  const { providers } = useCustomProvider.getState()
  return persistProviderSettings({ version: 2, providers, activeId: id })
}

export const removeCustomProvider = (id: string) => {
  const { providers, activeId } = useCustomProvider.getState()
  return persistProviderSettings({
    version: 2,
    providers: providers.filter((item) => item.id !== id),
    activeId: activeId === id ? null : activeId,
  })
}

export const matchesChatProvider = (
  sessionProviderId: string | undefined,
  enabled: boolean,
  providerId?: string
) => (enabled ? !!providerId && sessionProviderId === providerId : !sessionProviderId)
