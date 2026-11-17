import { App as NativeApp } from '@capacitor/app'
import { Keyboard } from '@capacitor/keyboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNative } from '../services/native.js'
import { resumeConnection } from '../services/connection.js'
import { newChat, useChatStore } from '../services/chat/store.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { flushDrafts } from '../services/chat/drafts.js'

export const initializeNative = async () => {
  const onReturn = () => { if (document.visibilityState === 'visible') { resumeConnection() } }
  document.addEventListener('visibilitychange', onReturn)
  if (!isNative) {
    return
  }
  await NativeApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      resumeConnection()
    } else {
      void flushDrafts()
    }
  })
  await NativeApp.addListener('backButton', () => {
    if (document.querySelector('[role="dialog"]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    } else if (useMobileSider.getState().open) {
      closeMobileSider()
    } else if (useChatStore.getState().activeId) {
      newChat()
    } else {
      void NativeApp.minimizeApp()
    }
  })
  await Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open'))
  await Keyboard.addListener('keyboardWillHide', () => document.body.classList.remove('keyboard-open'))
  const updateBars = () => {
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    void StatusBar.setBackgroundColor({ color: dark ? '#0f0f0f' : '#ffffff' })
  }
  updateBars()
  new MutationObserver(updateBars).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
}
