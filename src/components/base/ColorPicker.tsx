import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import {
  colorToHsv,
  hsvToHex,
  hsvToRgb,
  parseCssColor,
  rgbaToHex,
  rgbToHsv,
  type HsvColor,
} from '../../services/color.js'
import { useTranslate } from '../../i18n/index.js'
import { ActionButton, Input, Slider } from './Control.js'
import { Button } from './Button.js'
import { Modal } from './Modal.js'
import styles from './ColorPicker.module.css'

const PRESETS = [
  '#ffffff',
  '#0f172a',
  '#2e66ce',
  '#4b8bff',
  '#0ea5e9',
  '#14b8a6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#64748b',
]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export type ColorPickerProps = {
  title: string
  value: string
  presets?: string[]
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}

/** HSV 选色弹层：二维选区、色相、透明度、预设和 HEX 输入。 */
export const ColorPicker = ({
  title,
  value,
  presets = PRESETS,
  onChange,
  onCancel,
  onConfirm,
}: ColorPickerProps) => {
  const t = useTranslate()
  const initial = colorToHsv(value) ?? { hsv: { h: 0, s: 0, v: 0 }, alpha: 100 }
  const [hsv, setHsv] = useState<HsvColor>(initial.hsv)
  const [alpha, setAlpha] = useState(initial.alpha)
  const [hex, setHex] = useState(value)
  const [hexInvalid, setHexInvalid] = useState(false)
  const areaRef = useRef<HTMLDivElement>(null)
  const dragPointer = useRef<number | null>(null)
  const rgb = useMemo(() => hsvToRgb(hsv, alpha / 100), [hsv, alpha])
  const normalizedHex = useMemo(() => rgbaToHex(rgb), [rgb])

  const commit = (next: HsvColor, nextAlpha = alpha) => {
    const nextHsv = {
      h: ((next.h % 360) + 360) % 360,
      s: clamp(next.s, 0, 100),
      v: clamp(next.v, 0, 100),
    }
    setHsv(nextHsv)
    setAlpha(clamp(nextAlpha, 0, 100))
    const color = hsvToHex(nextHsv, nextAlpha / 100)
    setHex(color)
    setHexInvalid(false)
    onChange(color)
  }

  const updateFromPoint = (clientX: number, clientY: number) => {
    const area = areaRef.current
    if (!area) {
      return
    }
    const rect = area.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return
    }
    commit({
      ...hsv,
      s: clamp(((clientX - rect.left) / rect.width) * 100, 0, 100),
      v: clamp(100 - ((clientY - rect.top) / rect.height) * 100, 0, 100),
    })
  }

  const onAreaPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragPointer.current = event.pointerId
    updateFromPoint(event.clientX, event.clientY)
  }

  const onAreaPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current === event.pointerId) {
      updateFromPoint(event.clientX, event.clientY)
    }
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragPointer.current === event.pointerId) {
      dragPointer.current = null
    }
  }

  const onAreaKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2
    const next = { ...hsv }
    if (event.key === 'ArrowLeft') {
      next.s = clamp(next.s - step, 0, 100)
    } else if (event.key === 'ArrowRight') {
      next.s = clamp(next.s + step, 0, 100)
    } else if (event.key === 'ArrowUp') {
      next.v = clamp(next.v + step, 0, 100)
    } else if (event.key === 'ArrowDown') {
      next.v = clamp(next.v - step, 0, 100)
    } else {
      return
    }
    event.preventDefault()
    commit(next)
  }

  const updateHex = (next: string) => {
    setHex(next)
    const parsed = parseCssColor(next)
    if (!parsed) {
      setHexInvalid(next.trim().length > 0)
      return
    }
    setHexInvalid(false)
    setHsv(rgbToHsv(parsed))
    setAlpha(Math.round(parsed.a * 100))
    onChange(next.trim())
  }

  const normalizeHex = () => {
    const parsed = parseCssColor(hex)
    if (!parsed) {
      return
    }
    const color = rgbaToHex(parsed)
    setHex(color)
    setHexInvalid(false)
    onChange(color)
  }

  const selectPreset = (preset: string) => {
    const parsed = parseCssColor(preset)
    if (!parsed) {
      return
    }
    commit(rgbToHsv(parsed), Math.round(parsed.a * 100))
  }

  const hueTrack =
    'linear-gradient(90deg, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)'
  const alphaTrack = `linear-gradient(90deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0), rgb(${rgb.r}, ${rgb.g}, ${rgb.b})), repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%) 0 0 / 12px 12px`

  return (
    <Modal
      title={title}
      closable
      className={styles.dialog}
      onClose={onCancel}
      footer={
        <>
          <Button variant="outlined" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button disabled={hexInvalid} onClick={onConfirm}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div
          ref={areaRef}
          className={styles.area}
          style={{
            background: `linear-gradient(to top, #000000, transparent), linear-gradient(to right, #ffffff, hsl(${hsv.h} 100% 50%))`,
          }}
          role="slider"
          tabIndex={0}
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.v)}
          aria-valuetext={`S ${Math.round(hsv.s)}% V ${Math.round(hsv.v)}%`}
          onPointerDown={onAreaPointerDown}
          onPointerMove={onAreaPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onAreaKeyDown}
        >
          <span className={styles.thumb} style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }} />
        </div>
        <label className={styles.sliderRow}>
          <span>{t('colorPickerHue')}</span>
          <Slider
            min={0}
            max={360}
            step={1}
            value={Math.round(hsv.h)}
            track={hueTrack}
            aria-label={t('colorPickerHue')}
            onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
          />
          <output>{Math.round(hsv.h)}°</output>
        </label>
        <label className={styles.sliderRow}>
          <span>{t('colorPickerAlpha')}</span>
          <Slider
            min={0}
            max={100}
            step={1}
            value={Math.round(alpha)}
            track={alphaTrack}
            aria-label={t('colorPickerAlpha')}
            onChange={(event) => commit(hsv, Number(event.target.value))}
          />
          <output>{Math.round(alpha)}%</output>
        </label>
        <div className={styles.valueRow}>
          <span
            className={styles.valueSwatch}
            style={{ '--swatch-color': normalizedHex } as CSSProperties}
          />
          <Input
            value={hex}
            aria-label={t('colorPickerHex')}
            aria-invalid={hexInvalid}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => updateHex(event.target.value)}
            onBlur={normalizeHex}
          />
        </div>
        {hexInvalid ? (
          <p className={styles.error} role="alert">
            {t('colorPickerInvalid')}
          </p>
        ) : null}
        <div className={styles.presets}>
          {presets.map((preset) => (
            <ActionButton
              key={preset}
              className={styles.preset}
              style={{ backgroundColor: preset }}
              aria-label={preset}
              aria-pressed={normalizedHex.toLowerCase() === preset.toLowerCase()}
              onClick={() => selectPreset(preset)}
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}
