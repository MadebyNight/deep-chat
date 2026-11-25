import { ActionButton, IconRefreshOutline16, IconShareOutline16, IconWarningOutline16, IconButton, Button, Menu } from "../base/index.js"
import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo } from 'react'

import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply } from '../../services/chat/reply.js'
import { continueReply, regenerateReply } from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { shareText } from '../../services/native.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openConnection, visitOfficial } from '../../services/connection.js'
import { openSettings } from '../settings/settingsDialogState.js'


import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import { showToast } from '../base/toastState.js'
import { openExportDialog } from './exportDialogState.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  return (
    <div className={styles.message}>
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>
            {notice.text}
            {notice.action === 'apiKey' || notice.action === 'signIn' ? (
              <>
                {' '}
                <ActionButton
                  type="button"
                  className={styles.noticeAction}
                  onClick={openConnection}
                >
                  {t(notice.action === 'signIn' ? 'connectionAccountLogin' : 'changeApiKey')}
                </ActionButton>
              </>
            ) : null}
            {notice.action === 'customProvider' ? (
              <>
                {' '}
                <ActionButton type="button" className={styles.noticeAction} onClick={() => openSettings('provider')}>
                  {t('customProviderTitle')}
                </ActionButton>
              </>
            ) : null}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                <ActionButton type="button" className={styles.noticeAction} onClick={() => void visitOfficial('topup')}>
                  {t('topUp')}
                </ActionButton>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            {responseText && !refused ? (
              <Menu
                options={[
                  {
                    key: 'text',
                    label: t('exportMenuText'),
                    onSelect: async () => {
                      try {
                        await shareText(t('appName'), responseText)
                      } catch {
                        showToast({ key: 'shareFailed' })
                      }
                    },
                  },
                  {
                    key: 'markdown',
                    label: t('exportMenuMarkdown'),
                    onSelect: () =>
                      openExportDialog(
                        { kind: 'message', sessionId, messageId: message.id },
                        'markdown'
                      ),
                  },
                  {
                    key: 'image',
                    label: t('exportMenuImage'),
                    onSelect: () =>
                      openExportDialog(
                        { kind: 'message', sessionId, messageId: message.id },
                        'image'
                      ),
                  },
                  {
                    key: 'print',
                    label: t('exportMenuPrint'),
                    onSelect: () =>
                      openExportDialog(
                        { kind: 'message', sessionId, messageId: message.id },
                        'print'
                      ),
                  },
                ]}
              >
                {({ open, toggle }) => (
                  <IconButton
                    icon={<IconShareOutline16 />}
                    tooltip={t('share')}
                    tooltipPlacement="bottom"
                    disabled={busy}
                    aria-expanded={open}
                    onClick={toggle}
                  />
                )}
              </Menu>
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
