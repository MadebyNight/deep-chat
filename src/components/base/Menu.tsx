import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { ActionButton } from './Control.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
  className,
}: {
  options: MenuOption[]
  className?: string
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  // Align to the action at the trailing edge of the chat row.
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'end', offset: 4, maxHeight: 320 }
  )
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={clsx(styles.menu, className)}
              style={position ?? undefined}
              role="menu"
            >
              {options.map((option) => (
                <ActionButton
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  disabled={option.disabled}
                  onClick={() => {
                    setOpen(false)
                    option.onSelect()
                  }}
                >
                  {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
                  {option.label}
                </ActionButton>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
