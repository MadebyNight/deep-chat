import {
  Textarea,
  IconBookmarkOutline16,
  IconEditOutline16,
  IconForkOutline16,
  IconTrashOutline16,
  Button,
  IconButton,
} from '../base/index.js'
import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { editMessage, forkSession, retryUpload } from '../../services/chat/store.js'
import { memoryErrorMessage } from '../../services/memory/messages.js'
import { rememberMemory } from '../../services/memory/store.js'
import { useSettings } from '../../services/settings.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { UserMessage as UserMessageType } from '../../services/chat/types.js'
import { ensureChatConnection } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageFile } from './MessageFile.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  selecting = false,
  onStartTurnDeletion,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  selecting?: boolean
  onStartTurnDeletion?: (userId: string) => void
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [remembering, setRemembering] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isMobile = useIsMobile()
  const memoryEnabled = useSettings((state) => state.memoryEnabled)
  const canSend = !busy && (draft.trim() !== '' || message.files.length > 0)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  const sendEdit = () => {
    if (canSend && ensureChatConnection() && editMessage(sessionId, message.id, draft.trim())) {
      stopReadAloud()
      setEditing(false)
    }
  }

  const remember = async () => {
    if (remembering || !message.content) {
      return
    }
    setRemembering(true)
    try {
      const result = await rememberMemory(message.content, { sourceSessionId: sessionId })
      showToast({
        key: result.duplicate ? 'settingsMemoryAlreadySaved' : 'settingsMemorySaved',
      })
    } catch (failure) {
      showToast(memoryErrorMessage(failure, 'settingsMemorySaveFailed'))
    } finally {
      setRemembering(false)
    }
  }

  return (
    <div className={clsx(styles.container, isFirst && styles.isFirst)}>
      {message.files.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            message.files.some((file) => !file.isImage) && styles.filesWithDocuments
          )}
        >
          {message.files.map((file) => (
            <MessageFile
              key={file.id}
              file={file}
              onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
            />
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className={styles.editor}>
          <Textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            autoFocus
            rows={1}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                setEditing(false)
              } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !isMobile) {
                event.preventDefault()
                sendEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={sendEdit}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? <div className={styles.bubble}>{message.content}</div> : null}
          <div className={styles.bottom}>
            <div className={clsx(styles.actions, (isMobile || isLast) && styles.alwaysShow)}>
              {message.content ? (
                <CopyButton text={message.content} plainText={message.content} />
              ) : null}
              {memoryEnabled && message.content ? (
                <IconButton
                  icon={<IconBookmarkOutline16 />}
                  tooltip={t('rememberThisMessage')}
                  tooltipPlacement="bottom"
                  disabled={busy || selecting || remembering}
                  aria-busy={remembering}
                  onClick={() => void remember()}
                />
              ) : null}
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy || selecting}
                onClick={() => {
                  setDraft(message.content)
                  setEditing(true)
                }}
              />
              <IconButton
                icon={<IconForkOutline16 />}
                tooltip={t('forkChatAction')}
                tooltipPlacement="bottom"
                disabled={busy || selecting}
                onClick={() => forkSession(sessionId, message.id)}
              />
              {onStartTurnDeletion && !selecting ? (
                <IconButton
                  icon={<IconTrashOutline16 />}
                  tooltip={t('deleteTurn')}
                  tooltipPlacement="bottom"
                  disabled={busy}
                  onClick={() => onStartTurnDeletion(message.id)}
                />
              ) : null}
            </div>
            <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          </div>
        </>
      )}
    </div>
  )
})
