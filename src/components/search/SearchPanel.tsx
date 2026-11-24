import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconCloseOutline16, IconButton } from "../base/index.js"
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import clsx from 'clsx'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板；移动端为底部弹层（支持下拉跟手关闭） */
export const SearchPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  const panelRef = useRef<HTMLElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    lastY: number
    lastTime: number
    prevY: number
    prevTime: number
    fromHeader: boolean
    mode: 'pending' | 'locked' | 'ignored'
    offset: number
  } | null>(null)

  if (!entry) {
    return null
  }

  const resetSheet = () => {
    const panel = panelRef.current
    const mask = maskRef.current
    if (panel) {
      panel.style.removeProperty('transition')
      panel.style.removeProperty('transform')
    }
    if (mask) {
      mask.style.removeProperty('transition')
      mask.style.removeProperty('opacity')
    }
    dragRef.current = null
  }

  const onTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    if (!isMobile || event.touches.length !== 1) {
      return
    }
    const touch = event.touches[0]
    const now = performance.now()
    const target = event.target as Node | null
    const fromHeader = Boolean(target && headerRef.current?.contains(target))
    dragRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      lastTime: now,
      prevY: touch.clientY,
      prevTime: now,
      fromHeader,
      mode: 'pending',
      offset: 0,
    }
  }

  const onTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || !isMobile || event.touches.length !== 1) {
      return
    }
    const touch = event.touches[0]
    const dx = touch.clientX - drag.startX
    const dy = touch.clientY - drag.startY
    if (drag.mode === 'ignored') {
      return
    }
    if (drag.mode === 'pending') {
      if (Math.hypot(dx, dy) < 8) {
        return
      }
      const atTop = (contentRef.current?.scrollTop ?? 0) <= 0
      if (dy <= 0 || Math.abs(dx) >= dy || (!drag.fromHeader && !atTop)) {
        drag.mode = 'ignored'
        return
      }
      drag.mode = 'locked'
      if (panelRef.current) {
        panelRef.current.style.transition = 'none'
      }
      if (maskRef.current) {
        maskRef.current.style.transition = 'none'
      }
    }
    const offset = Math.max(0, dy)
    drag.prevY = drag.lastY
    drag.prevTime = drag.lastTime
    drag.lastY = touch.clientY
    drag.lastTime = performance.now()
    drag.offset = offset
    const panel = panelRef.current
    const mask = maskRef.current
    if (panel) {
      panel.style.transform = `translate3d(0, ${offset}px, 0)`
      if (mask) {
        const height = Math.max(1, panel.offsetHeight)
        mask.style.opacity = String(Math.max(0, 1 - offset / height))
      }
    }
  }

  const onTouchEnd = () => {
    const drag = dragRef.current
    if (!drag) {
      return
    }
    if (drag.mode !== 'locked') {
      dragRef.current = null
      return
    }
    const vy = (drag.lastY - drag.prevY) / Math.max(1, drag.lastTime - drag.prevTime)
    const shouldClose = drag.offset > 85 || vy > 0.4
    resetSheet()
    if (shouldClose) {
      closeSearchPanel()
    }
  }

  return (
    <>
      {isMobile ? <div ref={maskRef} className={styles.panelMask} onClick={closeSearchPanel} /> : null}
      <aside
        ref={panelRef}
        className={clsx(styles.panel, isMobile && entry.startsWith('citation:') && styles.single)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={resetSheet}
      >
        <div ref={headerRef} className={styles.header}>
          {isMobile ? <span className={styles.grabber} aria-hidden="true" /> : null}
          <div role="heading" className={styles.title}>
            {t('searchResult')}
          </div>
          <IconButton
            icon={<IconCloseOutline16 />}
            aria-label={t('close')}
            onClick={closeSearchPanel}
          />
        </div>
        <div ref={contentRef} className={styles.content}>
          {sources.map((source) => (
            <SourceCard key={source.url} source={source} className={styles.item} />
          ))}
        </div>
      </aside>
    </>
  )
}
