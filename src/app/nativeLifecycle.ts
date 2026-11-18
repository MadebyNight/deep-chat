import { App as NativeApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Keyboard } from '@capacitor/keyboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNative } from '../services/native.js'
import { resumeConnection } from '../services/connection.js'
import { newChat, useChatStore } from '../services/chat/store.js'
import { backMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { flushDrafts } from '../services/chat/drafts.js'

export const initializeNative = async () => {
  const onReturn = () => {
    if (document.visibilityState === 'visible') {
      resumeConnection()
    }
  }
  document.addEventListener('visibilitychange', onReturn)
  onReturn()
  if (!isNative) {
    return
  }
  await Browser.addListener('browserFinished', resumeConnection)
  await NativeApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      resumeConnection()
    } else {
      void flushDrafts()
    }
  })
  await NativeApp.addListener('backButton', () => {
    if (document.body.classList.contains('keyboard-open')) {
      void Keyboard.hide().catch(() => {})
    } else if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    } else if (useSearchPanel.getState().entry) {
      closeSearchPanel()
    } else if (useMobileSider.getState().open) {
      backMobileSider()
    } else if (useChatStore.getState().activeId) {
      newChat()
    } else {
      void NativeApp.minimizeApp()
    }
  })
  await Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open'))
  await Keyboard.addListener('keyboardWillHide', () =>
    document.body.classList.remove('keyboard-open')
  )
  const updateBars = () => {
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    const background = getComputedStyle(document.body).backgroundColor.match(/\d+/g)
    if (background) {
      const color =
        '#' +
        background
          .slice(0, 3)
          .map((channel) => Number(channel).toString(16).padStart(2, '0'))
          .join('')
      void StatusBar.setBackgroundColor({ color }).catch(() => {})
    }
  }
  updateBars()
  new MutationObserver(updateBars).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-ds-dark-theme'],
  })
}
