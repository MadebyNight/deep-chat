import { useRef, useState, type CSSProperties } from 'react'
import { parseCssColor, rgbaToHex } from '../../services/color.js'
import { ColorPicker } from './ColorPicker.js'
import { ActionButton } from './Control.js'
import styles from './ColorField.module.css'

export type ColorFieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  compact?: boolean
}

/** 色块行：显示当前颜色值，点击打开 HSV 选色弹层。 */
export const ColorField = ({ label, value, onChange, compact = false }: ColorFieldProps) => {
  const [open, setOpen] = useState(false)
  const original = useRef(value)
  const parsed = parseCssColor(value)
  const display = parsed ? rgbaToHex(parsed) : value

  return (
    <div className={compact ? styles.compactField : styles.field}>
      {compact ? null : <span className={styles.label}>{label}</span>}
      <ActionButton
        type="button"
        className={compact ? styles.compactButton : styles.button}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => {
          original.current = value
          setOpen(true)
        }}
      >
        <span className={styles.swatch} style={{ '--swatch-color': display } as CSSProperties} />
        <span className={styles.value}>{display}</span>
      </ActionButton>
      {open ? (
        <ColorPicker
          title={label}
          value={value}
          onChange={onChange}
          onCancel={() => {
            onChange(original.current)
            setOpen(false)
          }}
          onConfirm={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}
