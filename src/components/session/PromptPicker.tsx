import { useRef, useState } from 'react'
import {
  ActionButton,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '../base/index.js'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { getSelectedPrompt, useSettings } from '../../services/settings.js'
import { PromptLibraryModal } from './PromptLibraryModal.js'
import styles from './PromptPicker.module.css'

/** 未传 sessionId 时使用新对话的全局选择；传入时读取该会话的独立绑定。 */
export const PromptPicker = ({
  sessionId,
  variant = 'inline',
}: {
  sessionId?: string
  variant?: 'inline' | 'bar'
}) => {
  const t = useTranslate()
  const prompts = useSettings((state) => state.prompts)
  const sessionPromptId = useChatStore((state) =>
    sessionId === undefined ? undefined : state.sessionCache[sessionId]?.systemPromptId
  )
  const sessionPromptSnapshot = useChatStore((state) =>
    sessionId === undefined ? undefined : state.sessionCache[sessionId]?.systemPromptSnapshot
  )
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const globalPrompt = getSelectedPrompt(prompts)
  const sessionPreset =
    sessionId === undefined || sessionPromptId === undefined || sessionPromptId === null
      ? undefined
      : prompts.presets.find((preset) => preset.id === sessionPromptId)
  const selectedPreset = sessionId === undefined ? globalPrompt : sessionPreset
  const explicitDefault =
    sessionId === undefined
      ? !globalPrompt
      : sessionPromptId === null ||
        (sessionPromptId === undefined && !globalPrompt)
  const missingSnapshot =
    sessionId !== undefined &&
    typeof sessionPromptId === 'string' &&
    !sessionPreset &&
    !!sessionPromptSnapshot?.trim()
  const title = explicitDefault
    ? t('promptDefaultAssistant')
    : selectedPreset?.title ??
      (missingSnapshot ? t('promptDeletedPreset') : t('promptDefaultAssistant'))

  const close = () => {
    setOpen(false)
    requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }))
  }

  return (
    <>
      {variant === 'bar' ? (
        <div className={styles.bar}>
          <ActionButton
            ref={toggleRef}
            type="button"
            className={styles.barButton}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t('promptOpenLibrary', { name: title })}
            onClick={() => setOpen(true)}
          >
            <span className={styles.promptTitle}>{title}</span>
            <IconChevronRightOutline14 />
          </ActionButton>
        </div>
      ) : (
        <section className={styles.inline}>
          <ActionButton
            ref={toggleRef}
            className={styles.promptToggle}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t('promptOpenLibrary', { name: title })}
            onClick={() => setOpen(true)}
          >
            <span className={styles.promptTitle}>{title}</span>
            <span className={styles.promptChevron}>
              <IconChevronDownOutline14 />
            </span>
          </ActionButton>
        </section>
      )}
      {open ? <PromptLibraryModal sessionId={sessionId} onClose={close} /> : null}
    </>
  )
}
