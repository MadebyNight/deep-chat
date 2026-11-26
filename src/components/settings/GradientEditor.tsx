import { Button, ColorField, IconButton, IconTrashOutline16, Modal, Slider } from '../base/index.js'
import { useTranslate } from '../../i18n/index.js'
import {
  gradientToCss,
  type ThemeGradientStop,
  type ThemeLinearGradient,
} from '../../services/themePackages.js'
import styles from './Settings.module.css'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const GradientEditor = ({
  title,
  value,
  onChange,
  onCancel,
  onConfirm,
  onClear,
}: {
  title: string
  value: ThemeLinearGradient
  onChange: (value: ThemeLinearGradient) => void
  onCancel: () => void
  onConfirm: () => void
  onClear?: () => void
}) => {
  const t = useTranslate()
  const preview = gradientToCss(value)

  const updateStop = (index: number, next: Partial<ThemeGradientStop>) => {
    onChange({
      ...value,
      stops: value.stops.map((stop, stopIndex) =>
        stopIndex === index ? { ...stop, ...next } : stop
      ),
    })
  }

  const addStop = () => {
    if (value.stops.length >= 4) {
      return
    }
    const ordered = [...value.stops].sort((left, right) => left.position - right.position)
    const last = ordered[ordered.length - 1]
    const previous = ordered[ordered.length - 2] ?? last
    onChange({
      ...value,
      stops: [
        ...value.stops,
        {
          color: last.color,
          position: Math.round(((previous.position + last.position) / 2) * 10) / 10,
        },
      ].sort((left, right) => left.position - right.position),
    })
  }

  const removeStop = (index: number) => {
    if (value.stops.length <= 2) {
      return
    }
    onChange({ ...value, stops: value.stops.filter((_, stopIndex) => stopIndex !== index) })
  }

  return (
    <Modal
      title={title}
      closable
      className={styles.gradientDialog}
      onClose={onCancel}
      footer={
        <>
          <Button variant="outlined" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm}>{t('confirm')}</Button>
        </>
      }
    >
      <div className={styles.gradientForm}>
        <div
          className={styles.gradientPreview}
          style={{ backgroundImage: preview ?? 'none' }}
          aria-label={title}
        >
          {value.stops.map((stop, index) => (
            <span
              key={index}
              className={styles.gradientMarker}
              style={{ left: `${clamp(stop.position, 0, 100)}%`, backgroundColor: stop.color }}
            />
          ))}
        </div>
        <label className={styles.gradientSliderRow}>
          <span>{t('themeStudioGradientAngle')}</span>
          <Slider
            min={0}
            max={360}
            step={1}
            value={value.angle}
            aria-label={t('themeStudioGradientAngle')}
            onChange={(event) =>
              onChange({ ...value, angle: clamp(Number(event.target.value), 0, 360) })
            }
          />
          <output>{Math.round(value.angle)}°</output>
        </label>
        <div className={styles.gradientStops}>
          {value.stops.map((stop, index) => (
            <div key={index} className={styles.gradientStop}>
              <ColorField
                compact
                label={`${t('themeStudioGradientStop')} ${index + 1}`}
                value={stop.color}
                onChange={(color) => updateStop(index, { color })}
              />
              <Slider
                min={0}
                max={100}
                step={1}
                value={stop.position}
                aria-label={t('themeStudioGradientStopPosition')}
                onChange={(event) =>
                  updateStop(index, { position: clamp(Number(event.target.value), 0, 100) })
                }
              />
              <output>{Math.round(stop.position)}%</output>
              <IconButton
                size="m"
                icon={<IconTrashOutline16 />}
                aria-label={t('themeStudioGradientRemoveStop')}
                disabled={value.stops.length <= 2}
                onClick={() => removeStop(index)}
              />
            </div>
          ))}
        </div>
        <div className={styles.gradientActions}>
          <Button size="m" variant="outlined" disabled={value.stops.length >= 4} onClick={addStop}>
            {t('themeStudioGradientAddStop')}
          </Button>
          {onClear ? (
            <Button size="m" variant="dangerOutlined" onClick={onClear}>
              {t('themeStudioGradientClear')}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
