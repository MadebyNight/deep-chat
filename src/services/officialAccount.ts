import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { openOfficialPage } from './native.js'
import { readPreference, writePreference } from './settings.js'

const preference = 'deepchat:official-account'

export type AccountState = {
  status: 'signed-out' | 'credential-stored'
  attempt: { id: string; phase: string; authorizeUrl?: string; expiresAt?: number } | null
}
type Wallet = { currency: string; balance: string }
export type AccountBalance =
  | { status: 'ready'; value: Wallet[]; bonusWallets: Wallet[] }
  | { status: 'error' }
type AccountChunk = { type: 'bytes'; data: string }

type AccountProfile = { name: string | null; avatarUrl: string | null }
type AccountOperation = 'state' | 'signIn' | 'cancelSignIn' | 'signOut' | 'balance' | 'profile' | 'cancelChat' | 'transcribe' | 'upload' | 'messages' | 'synthesize'
let profileRevision = 0
const account = registerPlugin<{
  availability(): Promise<{ supported: boolean }>
  request<T>(options: { id: string; method: AccountOperation; params?: object }): Promise<T>
  addListener(name: 'chatChunk', listener: (event: { id: string; chunk: AccountChunk }) => void): Promise<PluginListenerHandle>
}>('DeepSeekAccount')

export const useOfficialAccount = create(() => ({
  available: false,
  active: readPreference(preference) === 'true' && Capacitor.getPlatform() === 'android',
  signedIn: false,
  fileScope: readPreference('deepchat:account-file-scope'),
  profile: null as AccountProfile | null,
  authorizing: false,
  browserOpened: false,
}))

export function selectOfficialAccount(active: boolean) {
  writePreference(preference, active ? 'true' : null)
  if (!active) {profileRevision++}
  useOfficialAccount.setState(active ? { active } : { active, profile: null })
}

export const officialAccountRequest = <T>(method: AccountOperation, params?: object, id = crypto.randomUUID()) =>
  account.request<T>({ id, method, params })

async function refreshOfficialProfile() {
  const revision = ++profileRevision
  try {
    const { profile } = await officialAccountRequest<{ profile: AccountProfile | null }>('profile')
    const { active, signedIn } = useOfficialAccount.getState()
    if (revision === profileRevision && active && signedIn) {
      useOfficialAccount.setState({ profile })
    }
  } catch {
    // Profile display is optional and does not affect the connection.
  }
}

const encodeBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      } else {
        reject(new Error('Could not encode recording'))
      }
    }
    reader.onerror = () => reject(reader.error)
    if (blob.size) {reader.readAsDataURL(blob)}
    else {resolve('')}
  })

export async function uploadOfficialFile(file: File, purpose: string | null, signal: AbortSignal) {
  const id = crypto.randomUUID()
  const path = `deepchat-upload-${id}`
  const cancel = () => void officialAccountRequest('cancelChat', { id }).catch(() => undefined)
  const chunkSize = 256 * 1024
  try {
    for (let offset = 0; offset < Math.max(1, file.size); offset += chunkSize) {
      signal.throwIfAborted()
      const data = await encodeBlob(file.slice(offset, offset + chunkSize))
      signal.throwIfAborted()
      const options = { path, directory: Directory.Cache, data }
      if (offset === 0) {await Filesystem.writeFile(options)}
      else {await Filesystem.appendFile(options)}
    }
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    const result = await officialAccountRequest<{ id: string }>('upload', {
      name: file.name, mimeType: file.type, purpose,
    }, id)
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined)
  }
}

export async function transcribeOfficialRecording(audio: Blob, signal: AbortSignal) {
  const id = crypto.randomUUID()
  const path = `deepchat-asr-${id}.wav`
  const data = await encodeBlob(audio)
  signal.throwIfAborted()
  const cancel = () => {
    void officialAccountRequest('cancelChat', { id }).catch(() => undefined)
  }
  try {
    await Filesystem.writeFile({ path, directory: Directory.Cache, data })
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    const result = await officialAccountRequest<{ text: string }>('transcribe', undefined, id)
    signal.throwIfAborted()
    return result.text
  } finally {
    signal.removeEventListener('abort', cancel)
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined)
  }
}

export function applyAccountState(state: AccountState) {
  const signedIn = state.status === 'credential-stored'
  const previous = useOfficialAccount.getState().fileScope
  const fileScope = signedIn ? previous ?? `account-${crypto.randomUUID()}` : null
  if (fileScope !== previous) {
    writePreference('deepchat:account-file-scope', fileScope)
  }
  useOfficialAccount.setState({ signedIn, fileScope })
  if (!signedIn) {selectOfficialAccount(false)}
  return signedIn
}

let accountInitialization: Promise<void> | undefined

export function initializeOfficialAccount() {
  accountInitialization ??= (async () => {
    if (Capacitor.getPlatform() !== 'android') {return}
    try {
      const { supported } = await account.availability()
      useOfficialAccount.setState({ available: supported })
      if (supported && useOfficialAccount.getState().active) {
        if (applyAccountState(await officialAccountRequest<AccountState>('state'))) {
          void refreshOfficialProfile()
        }
      } else if (!supported) {
        selectOfficialAccount(false)
      }
    } catch {
      // The user can retry through the connection dialog.
    }
  })()
  return accountInitialization
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
    void refreshOfficialProfile()
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

async function* officialAccountChunks(method: 'messages' | 'synthesize', body: object, signal: AbortSignal) {
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
    void officialAccountRequest(method, body, id)
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

export function officialAccountStream(method: 'messages' | 'synthesize', body: object, signal: AbortSignal) {
  const cancellation = new AbortController()
  const abort = () => cancellation.abort(signal.reason)
  signal.throwIfAborted()
  signal.addEventListener('abort', abort, { once: true })
  const chunks = officialAccountChunks(method, body, cancellation.signal)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next()
        if (next.done) {
          signal.removeEventListener('abort', abort)
          controller.close()
        } else if (next.value.type === 'bytes') {
          controller.enqueue(Uint8Array.from(atob(next.value.data), (byte) => byte.charCodeAt(0)))
        }
      } catch (error) {
        signal.removeEventListener('abort', abort)
        controller.error(error)
      }
    },
    async cancel() {
      signal.removeEventListener('abort', abort)
      cancellation.abort()
      await chunks.return(undefined)
    },
  })
}
