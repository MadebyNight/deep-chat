import { Capacitor } from '@capacitor/core'
import { showToast } from '../components/base/toastState.js'
import { ensureChatConnection } from '../components/settings/settingsDialogState.js'
import { getAttachmentConnection } from './attachments.js'
import { addDraftFiles, getDraft, setDraftText } from './chat/drafts.js'
import { newChat, useChatStore } from './chat/store.js'
import { useCustomProvider } from './customProvider.js'
import { initializeOfficialAccount, useOfficialAccount } from './officialAccount.js'
import {
  describeIntakeError,
  mergeDraftText,
  parseIntake,
  SHARED_INTAKE_MAX_FILE_BYTES,
  SHARED_INTAKE_MAX_TOTAL_BYTES,
  type NativeIntake,
  type SharedIntakeFile,
} from './intakeProtocol.js'
import {
  consumePendingIntake,
  openCameraIntake,
  releaseShareIntake,
  subscribeShareIntake,
} from './native.js'

export type ComposeAction = 'focus' | 'voice' | 'camera'

const composeListeners = new Set<(action: ComposeAction) => void>()
const pendingComposeActions: ComposeAction[] = []

const deliverComposeAction = (action: ComposeAction) => {
  for (const listener of composeListeners) {
    listener(action)
  }
}

export const dispatchComposeAction = (action: ComposeAction) => {
  if (composeListeners.size === 0) {
    pendingComposeActions.push(action)
    return
  }
  deliverComposeAction(action)
}

const dispatchAfterRender = (action: ComposeAction) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => dispatchComposeAction(action))
    })
  } else {
    setTimeout(() => dispatchComposeAction(action), 0)
  }
}

export const subscribeComposeAction = (listener: (action: ComposeAction) => void) => {
  composeListeners.add(listener)
  if (pendingComposeActions.length > 0) {
    const actions = pendingComposeActions.splice(0)
    setTimeout(() => {
      for (const action of actions) {
        listener(action)
      }
    }, 0)
  }
  return () => {
    composeListeners.delete(listener)
  }
}

export const hasNativeCamera = Capacitor.getPlatform() === 'android'

export const captureSharedPhoto = () => {
  if (!hasNativeCamera) {return false}
  void openCameraIntake().catch(() => showToast({ key: 'shareIntakeCameraFailed' }))
  return true
}

const loadSharedFile = async (file: SharedIntakeFile) => {
  const response = await fetch(Capacitor.convertFileSrc(file.uri), { cache: 'no-store' })
  if (!response.ok) {
    throw new Error('Shared intake file request failed')
  }
  const blob = await response.blob()
  if (blob.size > SHARED_INTAKE_MAX_FILE_BYTES) {
    throw new Error('Shared intake file exceeds the limit')
  }
  return new File([blob], file.name, { type: file.mimeType || blob.type })
}

const addSharedFiles = async (files: SharedIntakeFile[]) => {
  if (useCustomProvider.getState().enabled) {
    showToast({ key: 'customProviderTextOnly' })
    return
  }
  const loaded: File[] = []
  let total = 0
  for (const file of files) {
    const localFile = await loadSharedFile(file)
    total += localFile.size
    if (total > SHARED_INTAKE_MAX_TOTAL_BYTES) {
      throw new Error('Shared intake files exceed the total limit')
    }
    loaded.push(localFile)
  }

  if (useCustomProvider.getState().enabled) {
    showToast({ key: 'customProviderTextOnly' })
    return
  }
  let connection = getAttachmentConnection()
  if (!connection && useOfficialAccount.getState().active) {
    await initializeOfficialAccount()
    connection = getAttachmentConnection()
  }
  const error = addDraftFiles(null, loaded, connection)
  if (error) {
    showToast(error)
  } else if (!connection) {
    ensureChatConnection()
  }
}

const activateShortcut = (shortcut: 'new' | 'voice' | 'camera') => {
  if (useChatStore.getState().importingHistory) {
    showToast({ key: 'shareIntakeBusy' })
    return
  }
  newChat()
  dispatchAfterRender(shortcut === 'new' ? 'focus' : shortcut)
}

export const activateIntake = async (intake: NativeIntake) => {
  if (intake.kind === 'error') {
    showToast(describeIntakeError(intake.error))
    return
  }
  if (intake.kind === 'shortcut') {
    activateShortcut(intake.shortcut)
    return
  }
  if (useChatStore.getState().importingHistory) {
    showToast({ key: 'shareIntakeBusy' })
    return
  }

  newChat()
  if (intake.text) {
    setDraftText(null, mergeDraftText(getDraft(null).text, intake.text))
  }
  if (intake.files.length > 0) {
    try {
      await addSharedFiles(intake.files)
    } catch {
      showToast({ key: 'shareIntakeReadFailed' })
    }
  }
  if (intake.kind === 'process-text') {
    dispatchAfterRender('focus')
  }
}

const handled = new Map<string, Promise<void>>()
let intakeQueue = Promise.resolve()
let initialized: Promise<void> | undefined

const processIncoming = async (raw: unknown) => {
  const intake = parseIntake(raw)
  if (!intake) {
    showToast({ key: 'shareIntakeReadFailed' })
    return
  }
  const current = handled.get(intake.id)
  if (current) {
    await current
    return
  }
  const task = (async () => {
    try {
      await activateIntake(intake)
    } catch {
      showToast({ key: 'shareIntakeReadFailed' })
    } finally {
      await releaseShareIntake(intake.id).catch(() => undefined)
    }
  })()
  handled.set(intake.id, task)
  if (handled.size > 64) {
    const oldest = handled.keys().next().value
    if (oldest) {
      handled.delete(oldest)
    }
  }
  await task
}

const enqueueIntake = (raw: unknown) => {
  intakeQueue = intakeQueue.then(() => processIncoming(raw)).catch(() => undefined)
  return intakeQueue
}

const drainPendingIntake = async () => {
  while (true) {
    const intake = await consumePendingIntake()
    if (!intake) {
      return
    }
    await enqueueIntake(intake)
  }
}

export const pullPendingIntake = async () => {
  if (Capacitor.getPlatform() !== 'android') {
    return
  }
  if (!initialized) {
    await initializeSystemIntake()
    return
  }
  await drainPendingIntake()
}

export const initializeSystemIntake = () => {
  if (Capacitor.getPlatform() !== 'android') {
    return Promise.resolve()
  }
  if (initialized) {
    return initialized
  }
  initialized = (async () => {
    await subscribeShareIntake((intake) => {
      void enqueueIntake(intake)
    })
    await drainPendingIntake()
  })().catch((error: unknown) => {
    initialized = undefined
    throw error
  })
  return initialized
}
