import {
  Button,
  IconButton,
  IconCheckOutline16,
  IconCloseOutline16,
  IconEditOutline16,
  IconFolderOutline16,
  IconTrashOutline16,
  Input,
  Modal,
} from '../base/index.js'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createFolder,
  deleteFolder,
  renameFolder,
  useChatStore,
  type FolderMutationResult,
} from '../../services/chat/store.js'
import type { Folder } from '../../services/chat/types.js'
import { showToast } from '../base/toastState.js'
import styles from './FolderDialog.module.css'

const mutationToast = (result: FolderMutationResult) => {
  if (result === 'empty') {
    showToast({ key: 'folderNameRequired', type: 'error' })
  } else if (result === 'duplicate') {
    showToast({ key: 'folderNameExists', type: 'error' })
  } else if (result !== 'ok') {
    showToast({ key: 'folderSaveFailed', type: 'error' })
  }
  return result
}

export const FolderDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const folders = useChatStore((state) => state.folders)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Folder | null>(null)
  const [editName, setEditName] = useState('')
  const [deleting, setDeleting] = useState<Folder | null>(null)
  const [pending, setPending] = useState(false)
  if (!open) {
    return null
  }
  const add = async () => {
    if (pending) {
      return
    }
    setPending(true)
    try {
      const result = await createFolder(name)
      mutationToast(result)
      if (result === 'ok') {
        setName('')
        showToast({ key: 'folderCreated' })
      }
    } finally {
      setPending(false)
    }
  }
  const rename = async () => {
    if (!editing || pending) {
      return
    }
    setPending(true)
    try {
      const result = await renameFolder(editing.id, editName)
      mutationToast(result)
      if (result === 'ok') {
        setEditing(null)
        showToast({ key: 'folderRenamed' })
      }
    } finally {
      setPending(false)
    }
  }
  const remove = async () => {
    if (!deleting || pending) {
      return
    }
    setPending(true)
    try {
      if (await deleteFolder(deleting.id)) {
        setDeleting(null)
        showToast({ key: 'folderDeleted' })
      } else {
        showToast({ key: 'folderDeleteFailed', type: 'error' })
      }
    } finally {
      setPending(false)
    }
  }

  if (deleting) {
    return (
      <Modal
        layout="confirm"
        title={t('deleteFolderConfirmTitle', { name: deleting.name })}
        onClose={() => {
          if (!pending) {
            setDeleting(null)
          }
        }}
        footer={
          <>
            <Button variant="outlined" disabled={pending} onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" disabled={pending} onClick={() => void remove()}>
              {t('delete')}
            </Button>
          </>
        }
      >
      </Modal>
    )
  }

  return (
    <Modal
      title={t('manageFolders')}
      closable
      onClose={onClose}
      className={styles.dialog}
      footer={
        <Button variant="outlined" onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      <div className={styles.create}>
        <Input
          value={name}
          maxLength={40}
          placeholder={t('folderNamePlaceholder')}
          aria-label={t('folderNamePlaceholder')}
          disabled={pending}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void add()
            }
          }}
        />
        <Button size="m" disabled={pending || !name.trim()} onClick={() => void add()}>
          {t('newFolder')}
        </Button>
      </div>
      {folders.length ? (
        <ul className={styles.list}>
          {folders.map((folder) => (
            <li key={folder.id} className={styles.item}>
              {editing?.id === folder.id ? (
                <>
                  <Input
                    className={styles.rename}
                    value={editName}
                    autoFocus
                    maxLength={40}
                    aria-label={t('renameFolder')}
                    disabled={pending}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setEditName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) {
                        return
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void rename()
                      } else if (event.key === 'Escape') {
                        setEditing(null)
                      }
                    }}
                  />
                  <IconButton
                    icon={<IconCheckOutline16 />}
                    aria-label={t('confirm')}
                    disabled={pending || !editName.trim()}
                    onClick={() => void rename()}
                  />
                  <IconButton
                    icon={<IconCloseOutline16 />}
                    aria-label={t('cancel')}
                    disabled={pending}
                    onClick={() => setEditing(null)}
                  />
                </>
              ) : (
                <>
                  <span className={styles.folderIcon} aria-hidden="true">
                    <IconFolderOutline16 />
                  </span>
                  <span className={styles.name}>{folder.name}</span>
                  <IconButton
                    icon={<IconEditOutline16 />}
                    tooltip={t('renameFolder')}
                    disabled={pending}
                    onClick={() => {
                      setEditing(folder)
                      setEditName(folder.name)
                    }}
                  />
                  <IconButton
                    icon={<IconTrashOutline16 />}
                    tooltip={t('deleteFolder')}
                    disabled={pending}
                    onClick={() => setDeleting(folder)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  )
}
