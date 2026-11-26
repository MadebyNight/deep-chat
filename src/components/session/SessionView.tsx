import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { getVisibleMessages, getVisibleTurns } from '../../services/chat/branches.js'
import {
  cancelSummaryHandoff,
  createSummaryHandoff,
  removeTurns,
} from '../../services/chat/store.js'
import { buildReplyView } from '../../services/chat/view.js'
import { triggerHaptic } from '../../services/haptics.js'
import { useSettings } from '../../services/settings.js'
import { describeReadAloudError, stopReadAloud, toggleReadAloud } from '../../services/speech/readAloud.js'
import { ActionButton, Button, IconEllipsisOutline16, IconTrashOutline16, IconButton, Menu, Modal } from '../base/index.js'
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
  const mounted = useRef(false)
  const summaryRequest = useRef<object | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryPending, setSummaryPending] = useState(false)
  const [handoffExpanded, setHandoffExpanded] = useState(false)
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
  const summaryBusy = streaming || selectionActive
  const summaryDisabled = summaryBusy || summaryPending
  const longConversation = turns.length >= 20 || session.contextCheckpoint !== undefined

  useEffect(() => {
    if (!selectionActive) {
      setConfirmDeleteOpen(false)
    }
  }, [selectionActive])

  useEffect(() => {
    mounted.current = true
    summaryRequest.current = null
    setSummaryOpen(false)
    setSummaryPending(false)
    setHandoffExpanded(false)
    return () => {
      mounted.current = false
      summaryRequest.current = null
      cancelSummaryHandoff(session.id)
    }
  }, [session.id])

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

  const startSummaryHandoff = async () => {
    if (summaryDisabled) {
      return
    }
    const sessionId = session.id
    const token = {}
    summaryRequest.current = token
    setSummaryPending(true)
    setSummaryOpen(true)
    const result = await createSummaryHandoff(sessionId)
    if (!mounted.current || summaryRequest.current !== token) {
      return
    }
    summaryRequest.current = null
    setSummaryPending(false)
    setSummaryOpen(false)
    if (result.ok) {
      showToast({ key: 'summaryHandoffCreated' })
      return
    }
    const errorKeys = {
      empty: 'summaryHandoffEmpty',
      busy: 'summaryHandoffBusy',
      connection: 'summaryHandoffConnection',
      tooLong: 'summaryHandoffTooLong',
      summaryFailed: 'summaryHandoffFailed',
    } as const
    if (result.reason in errorKeys) {
      showToast({
        key: errorKeys[result.reason as keyof typeof errorKeys],
        type: 'error',
      })
    }
  }
  const closeSummary = () => {
    if (summaryPending) {
      cancelSummaryHandoff(session.id)
    }
    summaryRequest.current = null
    setSummaryPending(false)
    setSummaryOpen(false)
  }

  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader
          title={title}
          onSummaryHandoff={() => void startSummaryHandoff()}
          summaryDisabled={summaryDisabled}
        />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          <Menu
            options={[
              {
                key: 'summary',
                label: t('summaryHandoffAction'),
                disabled: summaryDisabled,
                onSelect: () => void startSummaryHandoff(),
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      )}
      {session.handoff ? (
        <section className={styles.handoffBanner}>
          <div className={styles.bannerText}>
            <strong>{t('handoffBannerTitle')}</strong>
          </div>
          <ActionButton
            type="button"
            className={styles.bannerAction}
            aria-expanded={handoffExpanded}
            onClick={() => setHandoffExpanded((value) => !value)}
          >
            {t(handoffExpanded ? 'handoffHideSummary' : 'handoffShowSummary')}
          </ActionButton>
          {handoffExpanded ? (
            <p className={styles.handoffSummary}>{session.handoff.summary}</p>
          ) : null}
        </section>
      ) : null}
      {longConversation ? (
        <section className={styles.longContextBanner}>
          <Button
            size="s"
            variant="outlined"
            disabled={summaryDisabled}
            aria-busy={summaryPending}
            onClick={() => void startSummaryHandoff()}
          >
            {t('summaryHandoffAction')}
          </Button>
        </section>
      ) : null}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.footer}>
            {selectionActive ? (
              <div className={styles.selectionBar}>
                <ActionButton
                  type="button"
                  className={styles.selectionCancel}
                  onClick={() => {
                    triggerHaptic('light')
                    clearTurnSelection()
                  }}
                >
                  {t('cancel')}
                </ActionButton>
                <span className={styles.selectionCount}>
                  {t('selectedTurnsCount', { count: activeSelectedIds.length })}
                </span>
                <div className={styles.selectionActions}>
                  <ActionButton
                    type="button"
                    className={styles.selectionToggleAll}
                    disabled={allTurnIds.length === 0}
                    onClick={() => {
                      triggerHaptic('light')
                      selectAllTurns(session.id, allSelected ? [] : allTurnIds)
                    }}
                  >
                    {t(allSelected ? 'deselectAll' : 'selectAll')}
                  </ActionButton>
                  <ActionButton
                    type="button"
                    className={styles.selectionDelete}
                    disabled={activeSelectedIds.length === 0}
                    onClick={() => {
                      triggerHaptic('light')
                      setConfirmDeleteOpen(true)
                    }}
                  >
                    <IconTrashOutline16 />
                    <span>{t('delete')}</span>
                  </ActionButton>
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
          layout="confirm"
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
      {summaryOpen ? (
        <Modal
          title={t('summaryHandoffTitle')}
          onClose={closeSummary}
          footer={
            <Button variant="outlined" onClick={closeSummary}>
              {t('cancel')}
            </Button>
          }
        >
          <p className={styles.summaryStatus} role="status" aria-live="polite">
            {t('summaryHandoffRunning')}
          </p>
        </Modal>
      ) : null}
    </div>
  )
}
