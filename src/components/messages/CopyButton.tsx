import { useEffect, useRef, useState, type PointerEvent } from 'react'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconCopyOutline16,
  IconButton,
  Menu,
} from '../base/index.js'
import { useTranslate } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { triggerHaptic } from '../../services/haptics.js'
import { useSettings, type CopyFormat } from '../../services/settings.js'
import { copyText } from '../../utils/clipboard.js'
import { markdownToPlainText } from '../../utils/markdownAstText.js'
import styles from './CopyButton.module.css'

/** 点击复制默认格式；长按主按钮或右侧箭头打开格式菜单。 */
export const CopyButton = ({ text, plainText }: { text: string; plainText?: string }) => {
  const t = useTranslate()
  const copyFormat = useSettings((state) => state.copyFormat)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const holdPointRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const copyingRef = useRef(false)
  useEffect(
    () => () => {
      clearTimeout(timerRef.current)
      clearTimeout(holdTimerRef.current)
    },
    []
  )

  const clearHold = () => {
    clearTimeout(holdTimerRef.current)
    holdPointRef.current = null
  }

  const copyAs = async (format: CopyFormat) => {
    if (copyingRef.current) {
      return
    }
    copyingRef.current = true
    let succeeded = false
    try {
      succeeded = await copyText(
        format === 'plain' ? plainText ?? markdownToPlainText(text) : text
      )
    } catch {
      succeeded = false
    } finally {
      copyingRef.current = false
    }
    if (!succeeded) {
      showToast({ key: 'copyFailed' })
      return
    }
    triggerHaptic('light')
    setCopied(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1000)
  }

  const cancelHoldOnMove = (event: PointerEvent<HTMLButtonElement>) => {
    const point = holdPointRef.current
    if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > 8) {
      clearHold()
    }
  }

  return (
    <Menu
      options={[
        {
          key: 'markdown',
          label: t('copyMarkdown'),
          icon: <IconCopyOutline16 />,
          onSelect: () => void copyAs('markdown'),
        },
        {
          key: 'plain',
          label: t('copyPlainText'),
          icon: <IconCopyOutline16 />,
          onSelect: () => void copyAs('plain'),
        },
      ]}
    >
      {({ open, toggle }) => (
        <span className={styles.group}>
          <IconButton
            icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
            tooltip={t('copy')}
            tooltipPlacement="bottom"
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) {
                return
              }
              suppressClickRef.current = false
              clearHold()
              holdPointRef.current = { x: event.clientX, y: event.clientY }
              holdTimerRef.current = setTimeout(() => {
                suppressClickRef.current = true
                triggerHaptic('light')
                toggle()
              }, 450)
            }}
            onPointerMove={cancelHoldOnMove}
            onPointerUp={clearHold}
            onPointerCancel={clearHold}
            onPointerLeave={clearHold}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              void copyAs(copyFormat)
            }}
          />
          <IconButton
            icon={<IconChevronDownOutline14 />}
            tooltip={t('copyFormat')}
            tooltipPlacement="bottom"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          />
        </span>
      )}
    </Menu>
  )
}
