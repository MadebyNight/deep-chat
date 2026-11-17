import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { buildReplyView } from '../../services/chat/view.js'
import { useSettings } from '../../services/settings.js'
import {
  describeReadAloudError,
  toggleReadAloud,
} from '../../services/speech/readAloud.js'
import { showToast } from '../base/toastState.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
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

  // 自动朗读：本轮生成结束时朗读最后一条回答的正文
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      const last = getVisibleMessages(session).at(-1)
      if (last?.role === 'assistant' && useSettings.getState().autoReadAloud) {
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
            <div className={styles.inputContainer}>
              <ChatInput sessionId={session.id} />
            </div>
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}
