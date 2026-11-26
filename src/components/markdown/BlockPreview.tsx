import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  Button,
  IconCheckOutline16,
  IconCopyOutline16,
  Modal,
} from '../base/index.js'
import { showToast } from '../base/toastState.js'
import { triggerHaptic } from '../../services/haptics.js'
import { copyText } from '../../utils/clipboard.js'

/** 块级操作条：触屏常驻，按钮统一由 Markdown 块提供。 */
export const MarkdownBlockActions = ({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) => <div className={clsx('markdown-block-actions', className)}>{children}</div>

/** 块级内容的通用全屏容器；Esc 与 Android 返回键沿用 Modal 的关闭路径。 */
export const MarkdownBlockPreview = ({
  open,
  title,
  onClose,
  children,
  className,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
}) =>
  open ? (
    <Modal
      title={title}
      closable
      fitViewport
      className={clsx('markdown-block-preview', className)}
      mainClassName="markdown-block-preview-main"
      onClose={onClose}
    >
      {children}
    </Modal>
  ) : null

/** 单文本块复制按钮，供公式等块级内容复用。 */
export const MarkdownBlockCopyButton = ({
  text,
  label,
}: {
  text: string
  label: TranslationKey
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <Button
      size="s"
      variant="outlined"
      className="markdown-block-button"
      onClick={async () => {
        if (!(await copyText(text))) {
          showToast({ key: 'copyFailed' })
          return
        }
        triggerHaptic('light')
        setCopied(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      <span>{t(copied ? 'copied' : label)}</span>
    </Button>
  )
}
