import { Component, useLayoutEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initializeCredentials } from './services/settings.js'
import { initializeCustomProvider } from './services/customProvider.js'
import { initializeDrafts } from './services/chat/drafts.js'
import { initializeNative } from './app/nativeLifecycle.js'
import { showToast } from './components/base/toastState.js'
import './app/theme.css'
import './app/global.css'
import { translate } from './i18n/index.js'
import './app/mobile.css'

const startupFailed = (error: unknown, stage = document.documentElement.dataset.startupStage) =>
  window.dispatchEvent(new CustomEvent('deepchat:startup-failed', {
    detail: { stage, errorType: error instanceof Error ? error.name : undefined },
  }))

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('Deep Chat render failed', error)
    startupFailed(error, 'REACT_RENDER')
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}

function StartedApp({ storageError }: { storageError: boolean }) {
  useLayoutEffect(() => {
    window.dispatchEvent(new Event('deepchat:startup-ready'))
    if (storageError) {
      showToast(translate('startupStorageError'))
    }
  }, [storageError])
  return <App />
}

const withStorageDeadline = async <T,>(load: (deadline: Promise<never>) => Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Startup storage timed out')), 3000)
  })
  try {
    return await load(deadline)
  } finally {
    clearTimeout(timer)
  }
}

const start = async () => {
  const startup = document.documentElement.dataset
  startup.startupStage = 'THEME_SETUP'
  setupTheme()
  startup.startupStage = 'CREDENTIAL_STORAGE'
  const credentials = await withStorageDeadline((deadline) => Promise.allSettled([
    initializeCredentials(deadline),
    initializeCustomProvider(deadline),
  ]))
  let storageError = credentials.some((result) => result.status === 'rejected')
  startup.startupStage = 'DRAFT_STORAGE'
  try {
    await withStorageDeadline(initializeDrafts)
  } catch {
    storageError = true
  }
  startup.startupStage = 'REACT_RENDER'
  createRoot(document.getElementById('root') as HTMLElement).render(
    <AppBoundary><StartedApp storageError={storageError} /></AppBoundary>
  )
  initializeNative()
  void Promise.resolve(ensureKatex()).catch(() => {})
}
void start().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Deep Chat startup failed', error)
  startupFailed(error)
})
