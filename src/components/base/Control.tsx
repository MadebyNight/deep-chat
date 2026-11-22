import { forwardRef, type ButtonHTMLAttributes, type ComponentPropsWithoutRef, type PointerEvent } from 'react'

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
          if (!event.defaultPrevented && button === 0 && isPrimary && !currentTarget.disabled &&
              currentTarget.getAttribute('aria-disabled') !== 'true') {
            currentTarget.dataset.pressed = String(pointerId)
          }
        }}
        onPointerUp={(event) => { release(event); props.onPointerUp?.(event) }}
        onPointerCancel={(event) => { release(event); props.onPointerCancel?.(event) }}
        onPointerLeave={(event) => { release(event); props.onPointerLeave?.(event) }}
        onLostPointerCapture={(event) => { release(event); props.onLostPointerCapture?.(event) }}
        onBlur={(event) => { delete event.currentTarget.dataset.pressed; props.onBlur?.(event) }}
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
