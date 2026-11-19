import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { openOfficialPage } from './native.js'

const preference = 'deepchat:official-account'

export type AccountState = {
  status: 'signed-out' | 'credential-stored'
  attempt: { id: string; phase: string; authorizeUrl?: string; expiresAt?: number } | null
}
type Wallet = { currency: string; balance: string }
export type AccountBalance =
  | { status: 'ready'; value: Wallet[]; bonusWallets: Wallet[] }
  | { status: 'error' }
export type AccountChunk =
  | { type: 'search-start'; query: string }
  | { type: 'search-results'; sources: { url: string; title: string; snippet: string }[] }
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: string }

type AccountOperation = 'state' | 'signIn' | 'cancelSignIn' | 'signOut' | 'balance' | 'chat' | 'cancelChat'
const account = registerPlugin<{
  availability(): Promise<{ supported: boolean }>
  request<T>(options: { id: string; method: AccountOperation; params?: object }): Promise<T>
  addListener(name: 'chatChunk', listener: (event: { id: string; chunk: AccountChunk }) => void): Promise<PluginListenerHandle>
}>('DeepSeekAccount')

export const useOfficialAccount = create(() => ({
  available: false,
  active: localStorage.getItem(preference) === 'true' && Capacitor.getPlatform() === 'android',
  signedIn: false,
  authorizing: false,
  browserOpened: false,
}))

export function selectOfficialAccount(active: boolean) {
  if (active) {localStorage.setItem(preference, 'true')}
  else {localStorage.removeItem(preference)}
  useOfficialAccount.setState({ active })
}

export const officialAccountRequest = <T>(method: AccountOperation, params?: object, id = crypto.randomUUID()) =>
  account.request<T>({ id, method, params })

export function applyAccountState(state: AccountState) {
  const signedIn = state.status === 'credential-stored'
  useOfficialAccount.setState({ signedIn })
  if (!signedIn) {selectOfficialAccount(false)}
  return signedIn
}

export async function initializeOfficialAccount() {
  if (Capacitor.getPlatform() !== 'android') {return}
  try {
    const { supported } = await account.availability()
    useOfficialAccount.setState({ available: supported })
    if (supported && useOfficialAccount.getState().active) {
      applyAccountState(await officialAccountRequest<AccountState>('state'))
    } else if (!supported) {
      useOfficialAccount.setState({ active: false })
    }
  } catch {
    // The user can retry through the connection dialog.
  }
}

let pendingSignIn: AbortController | undefined

export async function signInOfficialAccount() {
  const controller = new AbortController()
  pendingSignIn = controller
  const { signal } = controller
  useOfficialAccount.setState({ authorizing: true })
  try {
    let state = await officialAccountRequest<AccountState>('state')
    signal.throwIfAborted()
    if (state.status !== 'credential-stored') {
      state = await officialAccountRequest<AccountState>('signIn')
      let opened = false
      const deadline = Date.now() + 10 * 60_000
      while (state.status !== 'credential-stored') {
        signal.throwIfAborted()
        if (!state.attempt || ['failed', 'cancelled', 'expired'].includes(state.attempt.phase) || Date.now() >= deadline) {
          throw new Error('ACCOUNT_AUTHORIZATION')
        }
        if (!opened && state.attempt.authorizeUrl) {
          await openOfficialPage(state.attempt.authorizeUrl)
          opened = true
          useOfficialAccount.setState({ browserOpened: true })
        }
        await new Promise((resolve) => setTimeout(resolve, 750))
        signal.throwIfAborted()
        state = await officialAccountRequest<AccountState>('state')
      }
    }
    signal.throwIfAborted()
    applyAccountState(state)
    selectOfficialAccount(true)
  } catch (error) {
    await officialAccountRequest('cancelSignIn').catch(() => undefined)
    throw error
  } finally {
    pendingSignIn = undefined
    useOfficialAccount.setState({ authorizing: false, browserOpened: false })
  }
}

export function cancelOfficialSignIn() {
  pendingSignIn?.abort()
}

export async function* officialAccountChunks(body: object, signal: AbortSignal) {
  signal.throwIfAborted()
  const id = crypto.randomUUID()
  let queue: AccountChunk[] = []
  let wake: (() => void) | undefined
  let done = false
  let failure: unknown
  const listener = await account.addListener('chatChunk', (event) => {
    if (event.id === id) {
      queue.push(event.chunk)
      wake?.()
    }
  })
  const abort = () => {
    void officialAccountRequest('cancelChat', { id }).catch(() => undefined)
    wake?.()
  }
  try {
    signal.throwIfAborted()
    signal.addEventListener('abort', abort, { once: true })
    void officialAccountRequest('chat', body, id)
      .catch((error: unknown) => { failure = error })
      .finally(() => { done = true; wake?.() })
    while (!done || queue.length) {
      signal.throwIfAborted()
      if (!queue.length) {
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
      const batch = queue
      queue = []
      for (const chunk of batch) {
        signal.throwIfAborted()
        yield chunk
      }
    }
    if (failure) {throw failure}
  } finally {
    signal.removeEventListener('abort', abort)
    if (!done && !signal.aborted) {abort()}
    await listener.remove()
  }
}
