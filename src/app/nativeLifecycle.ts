import { App as NativeApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { isNative } from '../services/native.js'
import { resumeConnection } from '../services/connection.js'
import { initializeOfficialAccount } from '../services/officialAccount.js'
import { newChat, useChatStore } from '../services/chat/store.js'
import { backMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { clearTurnSelection, useTurnSelection } from '../components/messages/turnSelectionState.js'
import { flushDrafts } from '../services/chat/drafts.js'
import { initializeSystemIntake, pullPendingIntake } from '../services/systemIntake.js'
import { requestAutoSync, scheduleInitialAutoSync } from '../services/sync/engine.js'

export const initializeNative = () => {
  const onReturn = () => {
    if (document.visibilityState === 'visible') {
      resumeConnection()
      requestAutoSync('foreground')
    }
  }
  onReturn()
  if (!isNative) {
    document.addEventListener('visibilitychange', onReturn)
    return
  }
  const run = (operation: () => unknown) => {
    void Promise.resolve().then(operation).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('Deep Chat native lifecycle operation failed', error)
    })
  }
  run(initializeOfficialAccount)
  run(initializeSystemIntake)
  run(() => Browser.addListener('browserFinished', resumeConnection))
  run(() => NativeApp.addListener('resume', () => {
    resumeConnection()
    run(pullPendingIntake)
    requestAutoSync('foreground')
  }))
  run(() => NativeApp.addListener('pause', () => {
    run(flushDrafts)
    requestAutoSync('background')
  }))
  run(() => NativeApp.addListener('backButton', () => {
    if (document.body.classList.contains('keyboard-open')) {
      void Keyboard.hide().catch(() => {})
    } else if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-attachment-panel]')) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    } else if (useSearchPanel.getState().entry) {
      closeSearchPanel()
    } else if (useMobileSider.getState().open) {
      backMobileSider()
    } else if (useTurnSelection.getState().sessionId) {
      clearTurnSelection()
    } else if (useChatStore.getState().activeId) {
      newChat()
    } else {
      run(() => NativeApp.minimizeApp())
    }
  }))
  run(() => Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open')))
  run(() => Keyboard.addListener('keyboardWillHide', () => document.body.classList.remove('keyboard-open')))
  const systemUi =
    Capacitor.getPlatform() === 'android'
      ? registerPlugin<{ setSystemBarAppearance(options: { dark: boolean; background?: string }): Promise<void> }>(
          'StartupRecovery'
        )
      : null
  const updateBars = () => {
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    const background = getComputedStyle(document.body).backgroundColor.match(/\d+/g)
    const color = background
      ? '#' +
        background
          .slice(0, 3)
          .map((channel) => Number(channel).toString(16).padStart(2, '0'))
          .join('')
      : undefined
    if (systemUi) {
      run(() => systemUi.setSystemBarAppearance({ dark, background: color }))
    } else {
      run(() => StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }))
    }
  }
  updateBars()
  new MutationObserver(updateBars).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-ds-dark-theme'],
  })
  scheduleInitialAutoSync()
}
