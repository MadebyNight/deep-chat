import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initializeCredentials } from './services/settings.js'
import { initializeDrafts } from './services/chat/drafts.js'
import { initializeNative } from './app/nativeLifecycle.js'
import { showToast } from './components/base/toastState.js'
import './app/theme.css'
import './app/global.css'
import './app/mobile.css'

ensureKatex()
setupTheme()

const start = async () => {
  let storageError = false
  try { await initializeCredentials() } catch { storageError = true }
  try { await initializeDrafts() } catch { storageError = true }
  await initializeNative()
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
  if (storageError) {
    showToast('部分本机配置或草稿未能恢复，请检查保存状态。')
  }
}
void start()
