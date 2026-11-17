import { create } from 'zustand'
import { request, API_ORIGIN, ApiError } from './api/client.js'
import { setApiKey, useSettings } from './settings.js'
import { openOfficialPage, readPastedText } from './native.js'
import { translate } from '../i18n/index.js'

export const OFFICIAL = {
  keys: 'https://platform.deepseek.com/api_keys',
  platform: 'https://platform.deepseek.com/',
  topup: 'https://platform.deepseek.com/top_up',
} as const
export type Balance = {
  is_available: boolean
  balance_infos: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]
}
export const parseBalance = (data: unknown): Balance => {
  if (!data || typeof data !== 'object' || !('is_available' in data) ||
      typeof data.is_available !== 'boolean' || !('balance_infos' in data) || !Array.isArray(data.balance_infos) ||
      !data.balance_infos.every((item: unknown) => !!item && typeof item === 'object' &&
        ['currency', 'total_balance', 'granted_balance', 'topped_up_balance'].every(key =>
          typeof (item as Record<string, unknown>)[key] === 'string'))) {
    throw new Error('暂时无法读取余额，请稍后重试。')
  }
  return data as Balance
}
export const queryBalance = async (apiKey: string, signal?: AbortSignal): Promise<Balance> => {
  const response = await request(`${API_ORIGIN}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: signal ?? AbortSignal.timeout(20000),
  })
  return parseBalance(await response.json())
}

type Step = 'start' | 'paste' | 'balance'
type Away = 'keys' | 'topup' | null
const PROGRESS = 'deepchat:connection-progress'
const readProgress = (): { step: Step; away: Away; open: boolean } => {
  try {
    const saved = JSON.parse(localStorage.getItem(PROGRESS) ?? 'null')
    if (saved && ['start', 'paste', 'balance'].includes(saved.step)) {
      return { step: saved.step, away: ['keys', 'topup'].includes(saved.away) ? saved.away : null, open: !!saved.open }
    }
  } catch { /* 没有可恢复的向导 */ }
  return { step: 'start', away: null, open: false }
}
export const useConnection = create(() => ({
  ...readProgress(), balance: null as Balance | null, busy: false, error: '',
}))
useConnection.subscribe(({ step, away, open }) => {
  localStorage.setItem(PROGRESS, JSON.stringify({ step, away, open }))
})
let pending: AbortController | null = null
export const openConnection = () => useConnection.setState({
  open: true, error: '', step: useSettings.getState().apiKey ? 'balance' : useConnection.getState().step,
})
export const closeConnection = () => {
  if (useConnection.getState().busy) {
    return
  }
  useConnection.setState({ open: false, away: null, error: '' })
}
export const connectionError = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return translate('connectionErrorInvalid')
    }
    if (error.status === 429) {
      return translate('connectionErrorRateLimit')
    }
    if (error.status && error.status >= 500) {
      return translate('connectionErrorServer')
    }
    if (error.kind === 'network') {
      return translate('connectionErrorNetwork')
    }
  }
  return translate('connectionErrorGeneric')
}
export const connect = async (input: string) => {
  if (useConnection.getState().busy) {
    return
  }
  const key = input.trim()
  if (!key) {
    useConnection.setState({ step: 'paste', error: translate('connectionErrorEmpty') })
    return
  }
  pending = new AbortController()
  const timer = setTimeout(() => pending?.abort(), 20000)
  useConnection.setState({ busy: true, error: '' })
  try {
    const balance = await queryBalance(key, pending.signal)
    await setApiKey(key)
    useConnection.setState({ balance, step: 'balance', away: null, open: !balance.is_available })
  } catch (error) {
    useConnection.setState({ error: connectionError(error), step: 'paste' })
  } finally {
    clearTimeout(timer)
    pending = null
    useConnection.setState({ busy: false })
  }
}
export const pasteAndConnect = async () => {
  try { await connect(await readPastedText()) }
  catch { useConnection.setState({ error: translate('connectionErrorClipboard'), step: 'paste' }) }
}
export const refreshBalance = async (finish = false) => {
  const key = useSettings.getState().apiKey
  if (!key || useConnection.getState().busy) {
    return
  }
  useConnection.setState({ busy: true, error: '' })
  try {
    const balance = await queryBalance(key)
    useConnection.setState({ balance, ...(finish && balance.is_available ? { open: false } : {}) })
  } catch (error) {
    useConnection.setState({ balance: null, error: connectionError(error) })
  } finally {
    useConnection.setState({ busy: false })
  }
}
export const visitOfficial = async (destination: 'keys' | 'topup') => {
  useConnection.setState({ step: destination === 'keys' ? 'paste' : 'balance', away: destination, open: true, error: '' })
  try { await openOfficialPage(OFFICIAL[destination]) }
  catch { useConnection.setState({ away: null, error: translate('connectionErrorBrowser') }) }
}
export const resumeConnection = () => {
  const { away } = useConnection.getState()
  if (!away) {
    return
  }
  useConnection.setState({ away: null, open: true, step: away === 'keys' ? 'paste' : 'balance' })
  if (away === 'topup') {
    void refreshBalance(true)
  }
}
export const removeConnection = async () => {
  await setApiKey(null)
  useConnection.setState({ balance: null, step: 'start', error: '' })
}
