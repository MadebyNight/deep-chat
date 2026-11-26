import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ConnectionDialog } from '../components/settings/ConnectionDialog.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { ToolConfirmationDialog } from '../components/messages/ToolConfirmationDialog.js'
import { UpdateDialog } from '../components/settings/UpdateDialog.js'
import { ExportDialog } from '../components/messages/ExportDialog.js'
import { initializeUpdates } from '../services/updates.js'
import { Toast, Button } from "../components/base/index.js"
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import {
  closeMobileSider,
  openMobileSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'
import { useTurnSelection } from '../components/messages/turnSelectionState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  const chatFontSize = useSettings((state) => state.chatFontSize)
  useEffect(() => {
    if (chatFontSize === null) {
      document.body.style.removeProperty('--chat-font-size')
    } else {
      document.body.style.setProperty('--chat-font-size', `${chatFontSize / 16}rem`)
    }
  }, [chatFontSize])
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const mobileSiderOpen = useMobileSider((state) => state.open)
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const suppressClickUntilRef = useRef(0)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !isMobile) {
      return
    }
    const drawerWidth = () => Math.min(window.innerWidth * 0.8, window.innerWidth - 48)
    let state: {
      startX: number
      startY: number
      lastX: number
      lastTime: number
      prevX: number
      prevTime: number
      wasOpen: boolean
      mode: 'pending' | 'locked' | 'ignored'
      progress: number
    } | null = null

    const clearDrag = () => {
      frame.removeAttribute('data-drawer-dragging')
      frame.style.removeProperty('--drawer-progress')
      state = null
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        clearDrag()
        return
      }
      const touch = event.touches[0]
      const { open, mode } = useMobileSider.getState()
      if (
        (open && mode === 'search') ||
        useSearchPanel.getState().entry ||
        useTurnSelection.getState().sessionId ||
        document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')
      ) {
        return
      }
      // 打开手势避开左侧系统边缘返回热区与输入控件
      const target = event.target as HTMLElement | null
      if (!open && (touch.clientX < 28 || target?.closest('input, textarea'))) {
        return
      }
      const scrollable = target?.closest<HTMLElement>('pre, code, table, [data-no-swipe]')
      if (scrollable && scrollable.scrollWidth > scrollable.clientWidth) {
        return
      }
      for (let node = target; node && node !== frame; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1) {
          const ox = getComputedStyle(node).overflowX
          if (ox === 'auto' || ox === 'scroll') {
            return
          }
        }
      }
      const now = performance.now()
      state = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastTime: now,
        prevX: touch.clientX,
        prevTime: now,
        wasOpen: open,
        mode: 'pending',
        progress: open ? 1 : 0,
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!state || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - state.startX
      const dy = touch.clientY - state.startY
      if (state.mode === 'ignored') {
        return
      }
      if (state.mode === 'pending') {
        if (Math.hypot(dx, dy) < 10) {
          return
        }
        // 纵向滑动优先交还给列表滚动，不打断滚动惯性
        if (Math.abs(dy) >= Math.abs(dx) * 0.9) {
          state.mode = 'ignored'
          return
        }
        if ((state.wasOpen && dx >= 0) || (!state.wasOpen && dx <= 0)) {
          state.mode = 'ignored'
          return
        }
        state.mode = 'locked'
        frame.setAttribute('data-drawer-dragging', 'true')
      }
      const width = Math.max(1, drawerWidth())
      const progress = Math.max(0, Math.min(1, state.wasOpen ? 1 + dx / width : dx / width))
      state.prevX = state.lastX
      state.prevTime = state.lastTime
      state.lastX = touch.clientX
      state.lastTime = performance.now()
      state.progress = progress
      frame.style.setProperty('--drawer-progress', progress.toFixed(4))
    }

    const onTouchEnd = () => {
      if (!state) {
        return
      }
      const finished = state
      clearDrag()
      if (finished.mode !== 'locked') {
        return
      }
      suppressClickUntilRef.current = Date.now() + 300
      const vx = (finished.lastX - finished.prevX) / Math.max(1, finished.lastTime - finished.prevTime)
      const shouldOpen = finished.wasOpen
        ? finished.progress >= 0.72 && vx >= -0.35
        : finished.progress >= 0.28 || vx > 0.35
      if (shouldOpen) {
        openMobileSider()
      } else {
        closeMobileSider()
      }
    }

    frame.addEventListener('touchstart', onTouchStart, { passive: true })
    frame.addEventListener('touchmove', onTouchMove, { passive: true })
    frame.addEventListener('touchend', onTouchEnd, { passive: true })
    frame.addEventListener('touchcancel', clearDrag, { passive: true })
    return () => {
      clearDrag()
      frame.removeEventListener('touchstart', onTouchStart)
      frame.removeEventListener('touchmove', onTouchMove)
      frame.removeEventListener('touchend', onTouchEnd)
      frame.removeEventListener('touchcancel', clearDrag)
    }
  }, [frameRef, isMobile])
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  useEffect(closeMobileSider, [isMobile])

  useEffect(() => {
    void initChat()
    initializeUpdates()
    // 首次发送时进入连接向导，首页始终可浏览。
  }, [])

  return (
    <>
      <div
        ref={frameRef}
        className={clsx(styles.frame, isMobile && mobileSiderOpen && styles.frameDrawerOpen)}
        onClickCapture={(event) => {
          if (Date.now() < suppressClickUntilRef.current) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main className={clsx(styles.main, isMobile && mobileSiderOpen && styles.mainShifted)}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <ToolConfirmationDialog />
      <ConnectionDialog />
      <ExportDialog />
      <UpdateDialog allowAutomatic={ready && !streaming && !importingHistory && !mobileSiderOpen} />
      <Toast />
    </>
  )
}
