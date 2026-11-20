import { create } from 'zustand'
import { request, API_ORIGIN, ApiError } from './api/client.js'
import { readPreference, setApiKey, useSettings, writePreference } from './settings.js'
import { openOfficialPage } from './native.js'
import { translate } from '../i18n/index.js'
import {
  applyAccountState, officialAccountRequest, selectOfficialAccount, signInOfficialAccount,
  useOfficialAccount, type AccountBalance, type AccountState,
} from './officialAccount.js'

export const OFFICIAL = {
  keys: 'https://platform.deepseek.com/api_keys',
  topup: 'https://platform.deepseek.com/top_up',
} as const
export type Balance = {
  is_available: boolean
  balance_infos: {
    currency: string
    total_balance: string
    granted_balance: string
    topped_up_balance: string
  }[]
}
export const parseBalance = (data: unknown): Balance => {
  if (
    !data ||
    typeof data !== 'object' ||
    !('is_available' in data) ||
    typeof data.is_available !== 'boolean' ||
    !('balance_infos' in data) ||
    !Array.isArray(data.balance_infos) ||
    !data.balance_infos.every(
      (item: unknown) =>
        !!item &&
        typeof item === 'object' &&
        ['currency', 'total_balance', 'granted_balance', 'topped_up_balance'].every(
          (key) => typeof (item as Record<string, unknown>)[key] === 'string'
        )
    )
  ) {
    throw new Error('暂时无法读取余额，请稍后重试。')
  }
  return data as Balance
}
export const queryBalance = async (apiKey: string, signal?: AbortSignal): Promise<Balance> => {
  const response = await request(`${API_ORIGIN}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ?? AbortSignal.timeout(20000),
  })
  return parseBalance(await response.json())
}

type Step = 'start' | 'paste' | 'balance'
type Away = 'keys' | 'topup' | null
const PROGRESS = 'deepchat:connection-progress'
const readProgress = (): { step: Step; away: Away; open: boolean } => {
  try {
    const saved = JSON.parse(readPreference(PROGRESS) ?? 'null')
    if (saved && ['start', 'paste', 'balance'].includes(saved.step)) {
      return {
        step: saved.step,
        away: ['keys', 'topup'].includes(saved.away) ? saved.away : null,
        open: !!saved.open,
      }
    }
  } catch {
    /* 没有可恢复的向导 */
  }
  return { step: 'start', away: null, open: false }
}
export const useConnection = create(() => ({
  ...readProgress(),
  balance: null as Balance | null,
  busy: false,
  error: '',
}))
useConnection.subscribe(({ step, away, open }) => {
  writePreference(PROGRESS, JSON.stringify({ step, away, open }))
})
let pending: AbortController | null = null
export const openConnection = () =>
  useConnection.setState({
    open: true,
    error: '',
    balance: null,
    step: useOfficialAccount.getState().signedIn && useOfficialAccount.getState().active || useSettings.getState().apiKey
      ? 'balance'
      : useConnection.getState().step === 'paste'
        ? 'paste'
        : 'start',
  })
export const changeConnectionKey = () =>
  useConnection.setState({ open: true, step: 'paste', error: '' })

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
    selectOfficialAccount(false)
    useConnection.setState({ balance, step: 'balance', away: null, open: !balance.is_available })
  } catch (error) {
    useConnection.setState({ error: connectionError(error), step: 'paste' })
  } finally {
    clearTimeout(timer)
    pending = null
    useConnection.setState({ busy: false })
  }
}
export const connectOfficial = async () => {
  if (useConnection.getState().busy) {return}
  useConnection.setState({ busy: true, error: '', open: true, step: 'start' })
  try {
    await signInOfficialAccount()
    useConnection.setState({ balance: null, step: 'balance', away: null, open: false })
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      useConnection.setState({ error: translate('connectionAccountError') })
    }
  } finally {
    useConnection.setState({ busy: false })
  }
  if (useOfficialAccount.getState().active) {void refreshBalance()}
}

export const hasOfficialConnection = () => {
  const { active, signedIn } = useOfficialAccount.getState()
  return active && signedIn
}

async function queryOfficialBalance(): Promise<Balance> {
  const { balance } = await officialAccountRequest<{ balance: AccountBalance | null }>('balance')
  if (!balance) {applyAccountState(await officialAccountRequest<AccountState>('state'))}
  if (balance?.status !== 'ready') {throw new Error('Unavailable account balance')}
  const currencies = new Set([...balance.value, ...balance.bonusWallets].map((wallet) => wallet.currency))
  const balance_infos = [...currencies].map((currency) => {
    const sum = (wallets: typeof balance.value) => wallets.reduce(
      (total, wallet) => wallet.currency === currency ? total + Number(wallet.balance) : total, 0
    )
    const toppedUp = sum(balance.value)
    const granted = sum(balance.bonusWallets)
    return { currency, topped_up_balance: toppedUp.toFixed(2), granted_balance: granted.toFixed(2),
      total_balance: (toppedUp + granted).toFixed(2) }
  })
  return { is_available: balance_infos.some((item) => Number(item.total_balance) > 0), balance_infos }
}

export const refreshBalance = async (finish = false) => {
  const key = useSettings.getState().apiKey
  const official = hasOfficialConnection()
  const readBalance = official ? queryOfficialBalance : key ? () => queryBalance(key) : null
  if (!readBalance || useConnection.getState().busy) {
    return
  }
  useConnection.setState({ busy: true, error: '' })
  try {
    const balance = await readBalance()
    useConnection.setState({ balance, ...(finish && balance.is_available ? { open: false } : {}) })
  } catch (error) {
    useConnection.setState({ balance: null, error: connectionError(error) })
  } finally {
    useConnection.setState({ busy: false })
    if (topupReturned) {
      resumeConnection()
    }
  }
}
let topupReturned = false
export const visitOfficial = async (destination: 'keys' | 'topup', showDialog = true) => {
  useConnection.setState({
    step: destination === 'keys' ? 'paste' : 'balance',
    away: destination,
    open: showDialog,
    error: '',
  })
  try {
    await openOfficialPage(OFFICIAL[destination])
  } catch {
    useConnection.setState({ away: null, error: translate('connectionErrorBrowser') })
  }
}
export const resumeConnection = () => {
  const { away, busy } = useConnection.getState()
  topupReturned = away === 'topup'
  if (!away || (topupReturned && busy)) {
    return
  }
  useConnection.setState({ away: null })
  if (topupReturned) {
    topupReturned = false
    void refreshBalance(true)
  }
}
export const removeConnection = async () => {
  if (useConnection.getState().busy) {
    return
  }
  useConnection.setState({ busy: true, error: '' })
  try {
    if (hasOfficialConnection()) {
      applyAccountState(await officialAccountRequest<AccountState>('signOut'))
    } else {
      await setApiKey(null)
    }
    useConnection.setState({ balance: null, step: 'start', away: null, open: false })
  } catch {
    useConnection.setState({ error: translate('connectionErrorRemoveFailed') })
  } finally {
    useConnection.setState({ busy: false })
  }
}
