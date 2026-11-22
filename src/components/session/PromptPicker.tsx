import { ActionButton, Input, Textarea, Button, IconButton, Modal, IconCheckOutline16, IconChevronDownOutline14, IconCopyOutline16, IconEditOutline16, IconTrashOutline16 } from "../base/index.js"
import { useId, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getSelectedPrompt,
  setPrompts,
  useSettings,
  type PromptPreset,
} from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import { showToast } from '../base/toastState.js'
import styles from './Welcome.module.css'

function firstSentence(body: string, locale: string) {
  const text = body.trim()
  if (typeof Intl.Segmenter === 'function') {
    const [first] = new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)
    return first?.segment.trim() || text
  }
  return text.match(/^.+?(?:[。！？!?]+|\.(?=\s|$)|$)/u)?.[0] ?? text.split(/\r?\n/, 1)[0]
}

export function PromptPicker() {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const prompts = useSettings((state) => state.prompts)
  const selected = getSelectedPrompt(prompts)
  const [expanded, setExpanded] = useState(false)
  const [editor, setEditor] = useState<PromptPreset | null>(null)
  const [deleting, setDeleting] = useState<PromptPreset | null>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const listId = useId()
  const helpId = useId()
  const formId = useId()

  function restoreFocus() {
    const opener = openerRef.current
    requestAnimationFrame(() => {
      ;(opener?.isConnected ? opener : toggleRef.current)?.focus({ preventScroll: true })
    })
  }

  function closeEditor() {
    setEditor(null)
    restoreFocus()
  }

  function closeDelete() {
    setDeleting(null)
    restoreFocus()
  }

  function persist(next: typeof prompts) {
    if (!setPrompts(next)) {
      showToast({ key: 'promptSaveFailed', type: 'error' })
      return false
    }
    return true
  }

  function choose(selectedId: string | null) {
    if (selectedId === prompts.selectedId || persist({ ...prompts, selectedId })) {
      setExpanded(false)
      toggleRef.current?.focus({ preventScroll: true })
    }
  }

  function save(draft: PromptPreset) {
    if (!draft.body.trim()) {
      return
    }
    const existing = prompts.presets.some(({ id }) => id === draft.id)
    const entry = { ...draft, title: draft.title.trim() || firstSentence(draft.body, locale) }
    const presets = existing
      ? prompts.presets.map((preset) => (preset.id === draft.id ? entry : preset))
      : [...prompts.presets, entry]
    if (persist({ presets, selectedId: existing ? prompts.selectedId : entry.id })) {
      closeEditor()
    }
  }

  return (
    <section className={styles.prompt}>
      <ActionButton
        ref={toggleRef}
        className={styles.promptToggle}
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={styles.promptTitle}>{selected?.title ?? t('prompt')}</span>
        <IconChevronDownOutline14 />
      </ActionButton>
      <div id={listId} className={styles.promptList} hidden={!expanded}>
        <div className={styles.promptRow}>
          <ActionButton
            type="button"
            className={styles.promptChoice}
            aria-pressed={!selected}
            onClick={() => choose(null)}
          >
            <span className={styles.promptTitle}>{t('promptDefault')}</span>
            {!selected && <IconCheckOutline16 />}
          </ActionButton>
        </div>
        {prompts.presets.map((preset) => (
          <div className={styles.promptRow} key={preset.id}>
            <ActionButton
              type="button"
              className={styles.promptChoice}
              title={preset.title}
              aria-pressed={preset.id === selected?.id}
              onClick={() => choose(preset.id)}
            >
              <span className={styles.promptTitle}>{preset.title}</span>
              {preset.id === selected?.id && <IconCheckOutline16 />}
            </ActionButton>
            <IconButton
              size="xl"
              aria-label={t('promptEditItem', { name: preset.title })}
              icon={<IconEditOutline16 />}
              onClick={(event) => {
                openerRef.current = event.currentTarget
                setEditor(preset)
              }}
            />
            <IconButton
              size="xl"
              aria-label={t('promptDuplicateItem', { name: preset.title })}
              icon={<IconCopyOutline16 />}
              onClick={(event) => {
                openerRef.current = event.currentTarget
                setEditor({
                  ...preset,
                  id: createId(),
                  title: t('promptCopyTitle', { name: preset.title }),
                })
              }}
            />
            <IconButton
              size="xl"
              aria-label={t('promptDeleteItem', { name: preset.title })}
              icon={<IconTrashOutline16 />}
              onClick={(event) => {
                openerRef.current = event.currentTarget
                setDeleting(preset)
              }}
            />
          </div>
        ))}
        <Button
          size="s"
          variant="outlined"
          className={styles.promptNew}
          onClick={(event) => {
            openerRef.current = event.currentTarget
            setEditor({ id: createId(), title: '', body: '' })
          }}
        >
          {t('promptNew')}
        </Button>
      </div>
      {editor && (
        <Modal
          title={t(prompts.presets.some(({ id }) => id === editor.id) ? 'promptEdit' : 'promptNew')}
          closable
          fitViewport
          className={styles.promptEditor}
          mainClassName={styles.promptEditorMain}
          onClose={closeEditor}
          footer={
            <div className={styles.promptActions}>
              <Button size="m" variant="outlined" onClick={closeEditor} autoFocus>
                {t('cancel')}
              </Button>
              <Button
                size="m"
                type="submit"
                form={formId}
                disabled={!editor.body.trim()}
              >
                {t('promptSave')}
              </Button>
            </div>
          }
        >
          <form
            id={formId}
            className={styles.promptForm}
            onSubmit={(event) => {
              event.preventDefault()
              save(editor)
            }}
          >
            <label className={styles.promptField}>
              {t('promptName')}
              <Input
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                placeholder={t('promptNamePlaceholder')}
              />
            </label>
            <label className={styles.promptField}>
              {t('promptBody')}
              <Textarea
                rows={10}
                aria-describedby={helpId}
                value={editor.body}
                onChange={(event) => setEditor({ ...editor, body: event.target.value })}
                required
              />
            </label>
            <p className={styles.promptHelp} id={helpId}>
              {t('promptHelp')}
            </p>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={t('promptDeleteItem', { name: deleting.title })}
          onClose={closeDelete}
          footer={
            <>
              <Button size="m" variant="outlined" onClick={closeDelete} autoFocus>
                {t('cancel')}
              </Button>
              <Button
                size="m"
                variant="danger"
                onClick={() => {
                  const presets = prompts.presets.filter(({ id }) => id !== deleting.id)
                  const selectedId = prompts.selectedId === deleting.id ? null : prompts.selectedId
                  if (persist({ presets, selectedId })) {
                    closeDelete()
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('promptDeleteConfirm')}
        </Modal>
      )}
    </section>
  )
}
