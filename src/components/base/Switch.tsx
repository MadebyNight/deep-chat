import { ActionButton } from "./Control.js"
import clsx from 'clsx'
import type { ButtonHTMLAttributes } from 'react'
import styles from './Switch.module.css'

/** 开关：用于设置项的布尔值切换，样式对齐官方 Material 风格开关 */
export const Switch = ({
  checked,
  className,
  ...props
}: { checked: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <ActionButton
    type="button"
    role="switch"
    aria-checked={checked}
    className={clsx(styles.switch, checked && styles.on, className)}
    {...props}
  />
)
