import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { getVisibleMessages, getVisibleTurns } from '../../services/chat/branches.js'
import { removeTurns } from '../../services/chat/store.js'
import { buildReplyView } from '../../services/chat/view.js'
import { triggerHaptic } from '../../services/haptics.js'
import { useSettings } from '../../services/settings.js'
import { describeReadAloudError, stopReadAloud, toggleReadAloud } from '../../services/speech/readAloud.js'
import { Button, Modal } from '../base/index.js'
import { showToast } from '../base/toastState.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import {
  clearTurnSelection,
  selectAllTurns,
  useTurnSelection,
} from '../messages/turnSelectionState.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  const wasStreaming = useRef(streaming)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const selectionSessionId = useTurnSelection((state) => state.sessionId)
  const selectedUserIds = useTurnSelection((state) => state.selectedUserIds)
  const selectionActive = selectionSessionId === session.id && !streaming
  const turns = useMemo(() => getVisibleTurns(getVisibleMessages(session)), [session])
  const allTurnIds = useMemo(() => turns.map((turn) => turn.userId), [turns])
  const activeSelectedIds = useMemo(
    () => (selectionActive ? selectedUserIds.filter((id) => allTurnIds.includes(id)) : []),
    [selectionActive, selectedUserIds, allTurnIds]
  )
  const allSelected = allTurnIds.length > 0 && activeSelectedIds.length === allTurnIds.length

  useEffect(() => {
    if (!selectionActive) {
      setConfirmDeleteOpen(false)
    }
  }, [selectionActive])

  // 自动朗读：本轮生成结束时朗读最后一条回答的正文
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      const last = getVisibleMessages(session).at(-1)
      if (
        last?.role === 'assistant' &&
        last.status === 'done' &&
        useSettings.getState().autoReadAloud
      ) {
        const view = buildReplyView(last, false)
        if (view.answer?.text) {
          toggleReadAloud(last.id, view.answer.text, (error) =>
            showToast(describeReadAloudError(error))
          )
        }
      }
    }
    wasStreaming.current = streaming
  }, [streaming, session])

  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.footer}>
            {selectionActive ? (
              <div className={styles.selectionBar}>
                <Button
                  variant="outlined"
                  size={isMobile ? 's' : 'm'}
                  className={styles.selectionButton}
                  onClick={clearTurnSelection}
                >
                  {t('cancel')}
                </Button>
                <span className={styles.selectionCount}>
                  {t('selectedTurnsCount', { count: activeSelectedIds.length })}
                </span>
                <div className={styles.selectionActions}>
                  <Button
                    variant="outlined"
                    size={isMobile ? 's' : 'm'}
                    className={styles.selectionButton}
                    disabled={allTurnIds.length === 0}
                    onClick={() =>
                      selectAllTurns(session.id, allSelected ? [] : allTurnIds)
                    }
                  >
                    {t(allSelected ? 'deselectAll' : 'selectAll')}
                  </Button>
                  <Button
                    variant="danger"
                    size={isMobile ? 's' : 'm'}
                    className={styles.selectionButton}
                    disabled={activeSelectedIds.length === 0}
                    onClick={() => setConfirmDeleteOpen(true)}
                  >
                    {t('delete')}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className={styles.inputContainer}>
                  <ChatInput sessionId={session.id} />
                </div>
                <div className={styles.caveat}>{t('contentCaveat')}</div>
              </>
            )}
          </div>
        }
      />
      {confirmDeleteOpen ? (
        <Modal
          title={t('deleteTurnsConfirmTitle')}
          onClose={() => setConfirmDeleteOpen(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setConfirmDeleteOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const count = activeSelectedIds.length
                  triggerHaptic('confirm')
                  stopReadAloud()
                  const deleted = removeTurns(session.id, activeSelectedIds)
                  setConfirmDeleteOpen(false)
                  clearTurnSelection()
                  if (deleted) {
                    showToast({ key: 'turnDeleted', params: { count } })
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteTurnsConfirmDescription', { count: activeSelectedIds.length })}
        </Modal>
      ) : null}
    </div>
  )
}
