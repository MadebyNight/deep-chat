import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type PointerEvent,
} from 'react'
import styles from './Slider.module.css'

/** A native button with shared pointer feedback and feature-owned presentation. */
export const ActionButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ActionButton(props, ref) {
    const release = (event: PointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.dataset.pressed === String(event.pointerId)) {
        delete event.currentTarget.dataset.pressed
      }
    }
    return (
      <button
        type="button"
        {...props}
        ref={ref}
        onPointerDown={(event) => {
          props.onPointerDown?.(event)
          const { currentTarget, button, pointerId, isPrimary } = event
          if (
            !event.defaultPrevented &&
            button === 0 &&
            isPrimary &&
            !currentTarget.disabled &&
            currentTarget.getAttribute('aria-disabled') !== 'true'
          ) {
            currentTarget.dataset.pressed = String(pointerId)
          }
        }}
        onPointerUp={(event) => {
          release(event)
          props.onPointerUp?.(event)
        }}
        onPointerCancel={(event) => {
          release(event)
          props.onPointerCancel?.(event)
        }}
        onPointerLeave={(event) => {
          release(event)
          props.onPointerLeave?.(event)
        }}
        onLostPointerCapture={(event) => {
          release(event)
          props.onLostPointerCapture?.(event)
        }}
        onBlur={(event) => {
          delete event.currentTarget.dataset.pressed
          props.onBlur?.(event)
        }}
      />
    )
  }
)

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'>>(
  function Input(props, ref) {
    return <input {...props} ref={ref} />
  }
)

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<'textarea'>>(
  function Textarea(props, ref) {
    return <textarea {...props} ref={ref} />
  }
)

export const Slider = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<'input'>, 'type'> & { track?: string }
>(function Slider({ className, track, style, min = 0, max = 100, value, ...props }, ref) {
  const minimum = Number(min)
  const maximum = Number(max)
  const current = Number(value ?? minimum)
  const progress =
    maximum > minimum
      ? ((Math.min(maximum, Math.max(minimum, current)) - minimum) / (maximum - minimum)) * 100
      : 0
  return (
    <input
      {...props}
      ref={ref}
      type="range"
      min={min}
      max={max}
      value={value}
      className={[styles.slider, className].filter(Boolean).join(' ')}
      style={
        {
          ...style,
          '--slider-progress': `${progress}%`,
          '--slider-track': track,
        } as CSSProperties
      }
    />
  )
})
