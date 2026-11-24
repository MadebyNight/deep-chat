import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMobileViewport } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronRightOutline14, IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  backLabel,
  className,
  mainClassName,
  fitViewport = false,
  layout = 'default',
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  backLabel?: string
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  fitViewport?: boolean
  layout?: 'default' | 'confirm'
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const viewportRef = useMobileViewport(fitViewport)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const token = {}
    openModals.push(token)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && openModals.at(-1) === token) {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(token), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return createPortal(
    <div
      ref={viewportRef}
      className={clsx(styles.overlay, fitViewport && styles.fitViewport)}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={clsx(styles.content, layout === 'confirm' && styles.confirm, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={clsx(styles.header, backLabel && styles.backHeader)}>
          {backLabel ? (
            <IconButton
              size="xl"
              className={styles.back}
              tone="primary"
              icon={<IconChevronRightOutline14 />}
              aria-label={backLabel}
              onClick={onClose}
            />
          ) : null}
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable && !backLabel ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
