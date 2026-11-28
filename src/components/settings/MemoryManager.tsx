import { useEffect, useState } from 'react'
import type { LinkedMessage } from '../../i18n/index.js'
import { useTranslate } from '../../i18n/index.js'
import { memoryErrorMessage } from '../../services/memory/messages.js'
import {
  clearMemories,
  forgetMemory,
  listMemories,
  rememberMemory,
  updateMemory,
} from '../../services/memory/store.js'
import type { MemoryEntry } from '../../services/memory/types.js'
import {
  Button,
  IconEditOutline16,
  IconTrashOutline16,
  IconButton,
  Modal,
  Textarea,
} from '../base/index.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

type Confirmation = { kind: 'one'; entry: MemoryEntry } | { kind: 'all' }

const sortByUpdatedAt = (entries: MemoryEntry[]) =>
  [...entries].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

export const MemoryManagerModal = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LinkedMessage | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  useEffect(() => {
    let active = true
    void listMemories()
      .then((items) => {
        if (active) {
          setEntries(items)
        }
      })
      .catch(() => {
        if (active) {
          setError({ key: 'settingsMemoryLoadFailed', type: 'error' })
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [])

  const showError = (
    failure: unknown,
    fallback: 'settingsMemorySaveFailed' | 'settingsMemoryForgetFailed'
  ) => setError(memoryErrorMessage(failure, fallback))

  const add = async () => {
    if (busy || loading || !draft.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await rememberMemory(draft)
      setEntries((items) =>
        sortByUpdatedAt([result.entry, ...items.filter((item) => item.id !== result.entry.id)])
      )
      setDraft('')
      setEditingId(null)
      showToast({
        key: result.duplicate ? 'settingsMemoryAlreadySaved' : 'settingsMemorySaved',
      })
    } catch (failure) {
      showError(failure, 'settingsMemorySaveFailed')
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    if (busy || !editingId || !editingDraft.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const updated = await updateMemory(editingId, editingDraft)
      setEntries((items) =>
        sortByUpdatedAt(items.map((item) => (item.id === updated.id ? updated : item)))
      )
      setEditingId(null)
      setEditingDraft('')
      showToast({ key: 'settingsMemorySaved' })
    } catch (failure) {
      showError(failure, 'settingsMemorySaveFailed')
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (busy || !confirmation) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (confirmation.kind === 'all') {
        await clearMemories()
        setEntries([])
        setEditingId(null)
        setEditingDraft('')
      } else {
        await forgetMemory(confirmation.entry.id)
        setEntries((items) => items.filter((item) => item.id !== confirmation.entry.id))
      }
      setConfirmation(null)
    } catch (failure) {
      setConfirmation(null)
      showError(failure, 'settingsMemoryForgetFailed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title={t('settingsMemory')}
        className={styles.memoryDialog}
        closable
        onClose={() => {
          if (!busy) {
            onClose()
          }
        }}
        footer={
          <div className={styles.memoryFooter}>
            {entries.length > 0 ? (
              <Button
                size="m"
                variant="dangerOutlined"
                disabled={busy}
                onClick={() => setConfirmation({ kind: 'all' })}
              >
                {t('settingsMemoryClearAll')}
              </Button>
            ) : null}
            <Button size="m" variant="outlined" disabled={busy} onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        }
      >
        <form
          className={styles.memoryForm}
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <label className={styles.memoryField}>
            <span>{t('settingsMemoryAddLabel')}</span>
            <Textarea
              className={styles.memoryInput}
              rows={3}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className={styles.memoryFormActions}>
            <Button size="s" type="submit" disabled={busy || loading || !draft.trim()}>
              {t('promptAdd')}
            </Button>
          </div>
        </form>
        {error ? (
          <p role="alert" className={styles.memoryError}>
            {t(error.key, error.params)}
          </p>
        ) : null}
        {!loading && entries.length === 0 && !error ? (
          <p className={styles.memoryEmpty}>{t('settingsMemoryEmpty')}</p>
        ) : null}
        <ul className={styles.memoryList} aria-busy={busy || loading}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.memoryItem}>
              {editingId === entry.id ? (
                <div className={styles.memoryEdit}>
                  <Textarea
                    className={styles.memoryInput}
                    rows={3}
                    aria-label={t('settingsMemoryAddLabel')}
                    autoFocus
                    value={editingDraft}
                    disabled={busy}
                    onChange={(event) => setEditingDraft(event.target.value)}
                  />
                  <div className={styles.memoryActions}>
                    <Button
                      size="s"
                      variant="outlined"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null)
                        setEditingDraft('')
                        setError(null)
                      }}
                    >
                      {t('cancel')}
                    </Button>
                    <Button
                      size="s"
                      disabled={busy || !editingDraft.trim()}
                      onClick={() => void saveEdit()}
                    >
                      {t('promptSave')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className={styles.memoryContent}>{entry.content}</p>
                  <div className={styles.memoryActions}>
                    <IconButton
                      icon={<IconEditOutline16 />}
                      tooltip={t('settingsMemoryEdit')}
                      disabled={busy || editingId !== null}
                      onClick={() => {
                        setEditingId(entry.id)
                        setEditingDraft(entry.content)
                        setError(null)
                      }}
                    />
                    <IconButton
                      icon={<IconTrashOutline16 />}
                      tooltip={t('delete')}
                      disabled={busy || editingId !== null}
                      onClick={() => setConfirmation({ kind: 'one', entry })}
                    />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </Modal>
      {confirmation ? (
        <Modal
          layout="confirm"
          title={t(
            confirmation.kind === 'all' ? 'settingsMemoryClearTitle' : 'settingsMemoryDeleteTitle'
          )}
          onClose={() => {
            if (!busy) {
              setConfirmation(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={() => setConfirmation(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void confirm()}>
                {t(confirmation.kind === 'all' ? 'settingsMemoryClearConfirm' : 'delete')}
              </Button>
            </>
          }
        >
          <p>
            {t(
              confirmation.kind === 'all'
                ? 'settingsMemoryClearDescription'
                : 'settingsMemoryDeleteDescription'
            )}
          </p>
        </Modal>
      ) : null}
    </>
  )
}
