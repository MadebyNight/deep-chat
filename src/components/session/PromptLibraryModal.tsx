import { useId, useRef, useState } from 'react'
import {
  ActionButton,
  Button,
  IconButton,
  IconCheckOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
  Input,
  Menu,
  Modal,
  Textarea,
} from '../base/index.js'
import { showToast } from '../base/toastState.js'
import type { TranslationKey } from '../../i18n/index.js'
import { useTranslate } from '../../i18n/index.js'
import { setDraftText, getDraft } from '../../services/chat/drafts.js'
import { setSessionPrompt, useChatStore } from '../../services/chat/store.js'
import { saveArchive } from '../../services/native.js'
import {
  BUILTIN_PROMPT_CATEGORIES,
  BUILTIN_PROMPT_TEMPLATES,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_PRESETS,
  PromptImportError,
  makePromptPreset,
  parsePromptImport,
  readBuiltinPrompt,
  serializePromptLibrary,
  type PromptImportErrorCode,
} from '../../services/promptLibrary.js'
import {
  addPromptPreset,
  getSelectedPrompt,
  setPrompts,
  useSettings,
  type PromptPreset,
} from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import { formatDate } from '../../utils/format.js'
import styles from './PromptPicker.module.css'

const importErrorKeys: Record<PromptImportErrorCode, TranslationKey> = {
  promptImportTooLarge: 'promptImportTooLarge',
  promptImportInvalid: 'promptImportInvalid',
  promptImportUnsupported: 'promptImportUnsupported',
  promptImportEmpty: 'promptImportEmpty',
  promptImportTooMany: 'promptImportTooMany',
}

const categoryKeys: Record<string, TranslationKey> = {
  writing: 'promptCategoryWriting',
  coding: 'promptCategoryCoding',
  learning: 'promptCategoryLearning',
  creative: 'promptCategoryCreative',
  roleplay: 'promptCategoryRoleplay',
}

const presetKey = (preset: Pick<PromptPreset, 'title' | 'body'>) =>
  `${preset.title}\n${preset.body}`

export const PromptLibraryModal = ({
  sessionId,
  onClose,
}: {
  sessionId?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const prompts = useSettings((state) => state.prompts)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const sessionPromptId = useChatStore((state) =>
    sessionId === undefined ? undefined : state.sessionCache[sessionId]?.systemPromptId
  )
  const sessionPromptSnapshot = useChatStore((state) =>
    sessionId === undefined ? undefined : state.sessionCache[sessionId]?.systemPromptSnapshot
  )
  const [filter, setFilter] = useState<string | null>(null)
  const [editor, setEditor] = useState<PromptPreset | null>(null)
  const [deleting, setDeleting] = useState<PromptPreset | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const formId = useId()
  const categories = [
    ...new Set<string>([
      ...BUILTIN_PROMPT_CATEGORIES,
      ...prompts.presets.flatMap((preset) => (preset.category ? [preset.category] : [])),
    ]),
  ]
  const activeFilter = filter && categories.includes(filter) ? filter : null
  const visiblePresets =
    activeFilter === null
      ? prompts.presets
      : prompts.presets.filter((preset) => preset.category === activeFilter)
  const visibleTemplates =
    activeFilter === null
      ? BUILTIN_PROMPT_TEMPLATES
      : BUILTIN_PROMPT_TEMPLATES.filter((template) => template.category === activeFilter)
  const selectedId =
    sessionId === undefined
      ? prompts.selectedId
      : sessionPromptId === undefined
        ? prompts.selectedId
        : sessionPromptId
  const defaultSelected =
    sessionId === undefined
      ? !getSelectedPrompt(prompts)
      : sessionPromptId === null ||
        (sessionPromptId === undefined && !getSelectedPrompt(prompts))
  const missingSnapshot =
    sessionId !== undefined &&
    typeof sessionPromptId === 'string' &&
    !prompts.presets.some((preset) => preset.id === sessionPromptId) &&
    !!sessionPromptSnapshot?.trim()

  const categoryLabel = (category: string) => {
    const key = categoryKeys[category]
    return key ? t(key) : category
  }

  const restoreFocus = () => {
    const opener = openerRef.current
    requestAnimationFrame(() => {
      ;(opener?.isConnected ? opener : undefined)?.focus({ preventScroll: true })
    })
  }

  const persist = (next: typeof prompts) => {
    if (!setPrompts(next)) {
      showToast({ key: 'promptSaveFailed', type: 'error' })
      return false
    }
    return true
  }

  const bind = (preset: PromptPreset | null) => {
    if (importingHistory) {
      return false
    }
    if (sessionId !== undefined) {
      if (!setSessionPrompt(sessionId, preset)) {
        showToast({ key: 'promptSaveFailed', type: 'error' })
        return false
      }
      return true
    }
    return persist({
      ...useSettings.getState().prompts,
      selectedId: preset?.id ?? null,
    })
  }

  const choose = (preset: PromptPreset | null) => {
    if (bind(preset)) {
      onClose()
    }
  }

  const closeEditor = () => {
    setEditor(null)
    restoreFocus()
  }

  const closeDelete = () => {
    setDeleting(null)
    restoreFocus()
  }

  const saveEditor = () => {
    if (!editor?.body.trim() || importingHistory) {
      return
    }
    const existing = prompts.presets.some((preset) => preset.id === editor.id)
    if (!existing && prompts.presets.length >= MAX_PROMPT_PRESETS) {
      showToast({ key: 'promptImportTooMany', type: 'error' })
      return
    }
    let entry: PromptPreset
    try {
      entry = makePromptPreset(editor, { id: editor.id })
    } catch (error) {
      showToast({
        key: error instanceof PromptImportError ? 'promptImportInvalid' : 'promptSaveFailed',
        type: 'error',
      })
      return
    }
    const presets = existing
      ? prompts.presets.map((preset) => (preset.id === entry.id ? entry : preset))
      : [...prompts.presets, entry]
    const selectedId = existing
      ? prompts.selectedId
      : sessionId === undefined
        ? entry.id
        : prompts.selectedId
    if (!persist({ presets, selectedId })) {
      return
    }
    if (
      sessionId !== undefined &&
      (!existing || sessionPromptId === entry.id) &&
      !setSessionPrompt(sessionId, entry)
    ) {
      showToast({ key: 'promptSaveFailed', type: 'error' })
      return
    }
    closeEditor()
  }

  const addTemplate = (template: (typeof BUILTIN_PROMPT_TEMPLATES)[number], useStarter: boolean) => {
    if (importingHistory) {
      return
    }
    const draft = readBuiltinPrompt(template, locale)
    let preset = prompts.presets.find(
      (item) => item.title === draft.title && item.body === draft.body
    )
    let added = false
    if (!preset) {
      if (prompts.presets.length >= MAX_PROMPT_PRESETS) {
        showToast({ key: 'promptImportTooMany', type: 'error' })
        return
      }
      preset = draft
      if (!addPromptPreset(preset, sessionId === undefined)) {
        showToast({ key: 'promptSaveFailed', type: 'error' })
        return
      }
      added = true
    }
    if ((!added || sessionId !== undefined) && !bind(preset)) {
      return
    }
    if (added) {
      showToast({ key: 'promptTemplateAdded' })
    }
    if (useStarter && preset.starterPrompt) {
      const current = getDraft(sessionId ?? null).text.trimEnd()
      setDraftText(
        sessionId ?? null,
        current ? `${current}\n${preset.starterPrompt}` : preset.starterPrompt
      )
    }
    onClose()
  }

  const importFile = async (file: File) => {
    if (busy || importingHistory) {
      return
    }
    if (file.size > MAX_PROMPT_FILE_BYTES) {
      showToast({ key: 'promptImportTooLarge', type: 'error' })
      return
    }
    setBusy(true)
    try {
      const result = parsePromptImport(await file.text())
      const existing = new Set(prompts.presets.map(presetKey))
      const imported = result.presets.filter((preset) => {
        const key = presetKey(preset)
        if (existing.has(key)) {
          return false
        }
        existing.add(key)
        return true
      })
      if (imported.length === 0) {
        showToast({ key: 'promptImportDuplicates' })
        return
      }
      if (prompts.presets.length + imported.length > MAX_PROMPT_PRESETS) {
        showToast({ key: 'promptImportTooMany', type: 'error' })
        return
      }
      if (
        persist({
          presets: [...prompts.presets, ...imported],
          selectedId: prompts.selectedId,
        })
      ) {
        showToast({
          key: result.truncated ? 'promptImportSuccessTruncated' : 'promptImportSuccess',
          params: { count: imported.length },
        })
      }
    } catch (error) {
      showToast({
        key:
          error instanceof PromptImportError
            ? importErrorKeys[error.code]
            : 'promptImportInvalid',
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const exportPrompts = async () => {
    if (busy || prompts.presets.length === 0) {
      return
    }
    setBusy(true)
    try {
      const date = formatDate(new Date()) ?? 'export'
      const blob = new Blob([serializePromptLibrary(prompts.presets)], {
        type: 'application/json;charset=utf-8',
      })
      await saveArchive(`deepchat-prompts-${date}.json`, blob, t('promptExport'))
      showToast({ key: 'promptExportSuccess' })
    } catch {
      showToast({ key: 'promptExportFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title={t('promptLibraryTitle')}
        closable
        fitViewport
        className={styles.modal}
        mainClassName={styles.modalMain}
        onClose={onClose}
        footer={
          <div className={styles.toolbar}>
            <Button
              size="s"
              variant="primary"
              disabled={busy || importingHistory}
              onClick={() => {
                openerRef.current = null
                setEditor({
                  id: createId(),
                  title: '',
                  body: '',
                  ...(activeFilter ? { category: activeFilter } : {}),
                  createdAt: Date.now(),
                })
              }}
            >
              {t('promptNew')}
            </Button>
            <Button
              size="s"
              variant="outlined"
              disabled={busy || importingHistory}
              onClick={() => fileInputRef.current?.click()}
            >
              <IconUploadOutline14 />
              <span>{t('promptImport')}</span>
            </Button>
            <Button
              size="s"
              variant="outlined"
              disabled={busy || importingHistory || prompts.presets.length === 0}
              onClick={() => void exportPrompts()}
            >
              <IconDownloadOutline16 />
              <span>{t('promptExport')}</span>
            </Button>
            <Input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) {
                  void importFile(file)
                }
              }}
            />
          </div>
        }
      >
        {missingSnapshot ? (
          <div className={styles.notice} role="status">
            {t('promptSnapshotNotice')}
          </div>
        ) : null}
        <div className={styles.filterRow} role="group" aria-label={t('promptCategoryFilter')}>
          <ActionButton
            type="button"
            className={styles.chip}
            aria-pressed={activeFilter === null}
            onClick={() => setFilter(null)}
          >
            {t('promptCategoryAll')}
          </ActionButton>
          {categories.map((category) => (
            <ActionButton
              key={category}
              type="button"
              className={styles.chip}
              aria-pressed={activeFilter === category}
              onClick={() => setFilter(category)}
            >
              {categoryLabel(category)}
            </ActionButton>
          ))}
        </div>
        <section className={styles.section} aria-labelledby={`${formId}-mine`}>
          <div className={styles.sectionHeader}>
            <h3 id={`${formId}-mine`}>{t('promptMyPresets')}</h3>
          </div>
          <div className={styles.list}>
            <div className={styles.row}>
              <ActionButton
                type="button"
                className={styles.choice}
                aria-pressed={defaultSelected}
                onClick={() => choose(null)}
              >
                <span className={styles.choiceBody}>
                  <span className={styles.choiceTitle}>{t('promptDefaultAssistant')}</span>
                </span>
                {defaultSelected ? <IconCheckOutline16 /> : null}
              </ActionButton>
            </div>
            {visiblePresets.map((preset) => (
              <div className={styles.row} key={preset.id}>
                <ActionButton
                  type="button"
                  className={styles.choice}
                  aria-pressed={preset.id === selectedId}
                  onClick={() => choose(preset)}
                >
                  <span className={styles.choiceBody}>
                    <span className={styles.choiceTitleRow}>
                      <span className={styles.choiceTitle}>{preset.title}</span>
                      {preset.category ? (
                        <span className={styles.categoryChip}>
                          {categoryLabel(preset.category)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {preset.id === selectedId ? <IconCheckOutline16 /> : null}
                </ActionButton>
                <div className={styles.rowActions}>
                  <Menu
                    options={[
                      {
                        key: 'edit',
                        label: t('promptEdit'),
                        icon: <IconEditOutline16 />,
                        onSelect: () => setEditor(preset),
                      },
                      {
                        key: 'duplicate',
                        label: t('promptDuplicate'),
                        icon: <IconCopyOutline16 />,
                        onSelect: () =>
                          setEditor({
                            ...preset,
                            id: createId(),
                            title: t('promptCopyTitle', { name: preset.title }),
                            createdAt: Date.now(),
                          }),
                      },
                      {
                        key: 'delete',
                        label: t('delete'),
                        icon: <IconTrashOutline16 />,
                        danger: true,
                        onSelect: () => setDeleting(preset),
                      },
                    ]}
                  >
                    {({ open, toggle }) => (
                      <IconButton
                        size="xs"
                        aria-label={t('promptActionsItem', { name: preset.title })}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        icon={<IconEllipsisOutline16 />}
                        onClick={(event) => {
                          openerRef.current = event.currentTarget
                          toggle()
                        }}
                      />
                    )}
                  </Menu>
                </div>
              </div>
            ))}
          </div>
        </section>
        {visibleTemplates.length > 0 ? (
          <section className={styles.section} aria-labelledby={`${formId}-builtin`}>
            <div className={styles.sectionHeader}>
              <h3 id={`${formId}-builtin`}>{t('promptBuiltinTemplates')}</h3>
            </div>
            <div className={styles.list}>
              {visibleTemplates.map((template) => {
                const localized = readBuiltinPrompt(template, locale)
                const existing = prompts.presets.find(
                  (preset) =>
                    preset.title === localized.title && preset.body === localized.body
                )
                return (
                  <div className={styles.row} key={template.id}>
                    <div className={styles.builtinCopy}>
                      <span className={styles.choiceTitleRow}>
                        <span className={styles.choiceTitle}>{localized.title}</span>
                        <span className={styles.categoryChip}>
                          {categoryLabel(template.category)}
                        </span>
                      </span>
                    </div>
                    <div className={styles.builtinActions}>
                      <Button
                        size="s"
                        variant="outlined"
                        disabled={busy || importingHistory}
                        onClick={() => addTemplate(template, false)}
                      >
                        {existing ? t('promptUse') : t('promptAdd')}
                      </Button>
                      {localized.starterPrompt ? (
                        <Button
                          size="s"
                          variant="outlined"
                          disabled={busy || importingHistory}
                          onClick={() => addTemplate(template, true)}
                        >
                          {t('promptTry')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}
      </Modal>
      {editor ? (
        <Modal
          title={t(
            prompts.presets.some((preset) => preset.id === editor.id)
              ? 'promptEdit'
              : 'promptNew'
          )}
          closable
          fitViewport
          className={styles.editorModal}
          mainClassName={styles.editorMain}
          onClose={closeEditor}
          footer={
            <div className={styles.editorActions}>
              <Button size="m" variant="outlined" onClick={closeEditor} autoFocus>
                {t('cancel')}
              </Button>
              <Button
                size="m"
                type="submit"
                form={formId}
                disabled={!editor.body.trim() || importingHistory}
              >
                {t('promptSave')}
              </Button>
            </div>
          }
        >
          <form
            id={formId}
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault()
              saveEditor()
            }}
          >
            <label className={styles.field}>
              <span>{t('promptName')}</span>
              <Input
                value={editor.title}
                maxLength={120}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>{t('promptCategoryField')}</span>
              <Input
                value={editor.category ?? ''}
                maxLength={40}
                onChange={(event) =>
                  setEditor({ ...editor, category: event.target.value || undefined })
                }
              />
            </label>
            <label className={styles.field}>
              <span>{t('promptBody')}</span>
              <Textarea
                rows={10}
                maxLength={30_000}
                value={editor.body}
                onChange={(event) => setEditor({ ...editor, body: event.target.value })}
                required
              />
            </label>
            <label className={styles.field}>
              <span>{t('promptStarterPrompt')}</span>
              <Textarea
                rows={3}
                maxLength={4_000}
                value={editor.starterPrompt ?? ''}
                onChange={(event) =>
                  setEditor({ ...editor, starterPrompt: event.target.value || undefined })
                }
              />
            </label>
          </form>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={t('promptDeleteItem', { name: deleting.title })}
          layout="confirm"
          onClose={closeDelete}
          footer={
            <>
              <Button size="m" variant="outlined" onClick={closeDelete} autoFocus>
                {t('cancel')}
              </Button>
              <Button
                size="m"
                variant="danger"
                disabled={importingHistory}
                onClick={() => {
                  const presets = prompts.presets.filter(({ id }) => id !== deleting.id)
                  const selectedId =
                    prompts.selectedId === deleting.id ? null : prompts.selectedId
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
      ) : null}
    </>
  )
}
