import { ActionButton, Input, Textarea, IconCloseOutline16, IconGlobeLanguageOutline14, IconPaperclipOutline16, IconSendOutline16, IconStopFill16, IconThinkOutline14, IconButton, Tooltip } from "../base/index.js"
import clsx from 'clsx'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { triggerHaptic } from '../../services/haptics.js'
import { useCustomProvider } from '../../services/customProvider.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  prepareDraftUploads,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { ensureChatConnection } from '../settings/settingsDialogState.js'
import { GenerationEntryButton } from '../settings/GenerationSettings.js'
import { PromptPicker } from '../session/PromptPicker.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import {
  ACCEPT,
  getAttachmentConnection,
  useAttachmentScope,
  useUploads,
} from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'
import promptStyles from '../session/Welcome.module.css'

/** 输入框：框外提示词/参数入口 + 自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({
  sessionId,
  showPrompt = false,
}: {
  sessionId: string | null
  showPrompt?: boolean
}) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return (
    <Composer
      key={sessionId === null ? 'new' : `session:${sessionId}`}
      sessionId={sessionId}
      showPrompt={showPrompt}
    />
  )
})

const Composer = ({ sessionId, showPrompt }: { sessionId: string | null; showPrompt: boolean }) => {
  const t = useTranslate()
  const attachmentScope = useAttachmentScope()
  const custom = useCustomProvider((state) => state.enabled)
  const scope = custom ? undefined : attachmentScope
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks, scope) !== null)
  useEffect(() => {
    const connection = getAttachmentConnection()
    if (!useCustomProvider.getState().enabled && connection?.scope === scope && connection) {
      prepareDraftUploads(attachments, connection)
    }
  }, [attachments, scope])
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const [attachmentPicker, setAttachmentPicker] = useState(false)
  const showAttachmentPicker = isMobile && attachmentPicker && !importingHistory && !custom
  const attachmentPanelId = useId()
  const composerRef = useRef<HTMLDivElement>(null)
  const attachmentPanelRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showAttachmentPicker) {
      return
    }
    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !composerRef.current?.contains(event.target) &&
        !attachmentPanelRef.current?.contains(event.target)
      ) {
        setAttachmentPicker(false)
      }
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setAttachmentPicker(false)
      }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [showAttachmentPicker])

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (isMobile || !toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [isMobile, t])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory) {
      return
    }
    if (useCustomProvider.getState().enabled) {
      showToast({ key: 'customProviderTextOnly' })
      return
    }
    if (!ensureChatConnection()) {
      return
    }
    const connection = getAttachmentConnection()
    if (!connection) {
      return
    }
    const error = addDraftFiles(sessionId, files, connection)
    if (error) {
      showToast(error)
      return
    }
    setAttachmentPicker(false)
  }
  const retryFile = useCallback(
    (id: string) => {
      if (useChatStore.getState().importingHistory || useCustomProvider.getState().enabled || !ensureChatConnection()) {
        return
      }
      const connection = getAttachmentConnection()
      if (connection) {
        retryDraftAttachment(sessionId, id, connection)
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = () => {
    if (useChatStore.getState().importingHistory || voice.status !== 'idle') {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureChatConnection() || !sendMessage(sessionId)) {
      return
    }
    triggerHaptic('medium')
    stopReadAloud()
    setAttachmentPicker(false)
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div className={styles.composer}>
      <div className={styles.composerTools}>
        <div className={styles.promptSlot}>
          {showPrompt && !custom ? <PromptPicker /> : null}
        </div>
        <GenerationEntryButton
          sessionId={sessionId}
          className={promptStyles.promptToggle}
          labelClassName={promptStyles.promptTitle}
          disabled={importingHistory}
        />
      </div>
      <div
        ref={composerRef}
        className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            textareaRef.current?.focus({ preventScroll: true })
          }
        }}
      >
        <DraftAttachments
          items={attachments}
          scope={scope}
          onRetry={retryFile}
          onRemove={removeFile}
        />
        <div className={styles.textareaWrapper}>
          <Textarea
            ref={textareaRef}
            className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
            placeholder={t('chatInputPlaceholderChat')}
            rows={2}
            // 移动端不自动聚焦，避免一打开就弹出键盘
            autoFocus={!isMobile}
            disabled={importingHistory}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setAttachmentPicker(false)}
            onMouseDown={(event) => {
              // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
              if (
                isMobile &&
                event.button === 0 &&
                document.activeElement !== event.currentTarget
              ) {
                event.preventDefault()
                event.currentTarget.focus({ preventScroll: true })
              }
            }}
            onKeyDown={(event) => {
              if (
                !isMobile &&
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                send()
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (files.length > 0) {
                event.preventDefault()
                acceptFiles(files)
              }
            }}
          />
          {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
          <div className={styles.mirror} aria-hidden>
            {`${text}\n`}
          </div>
        </div>
        <div
          className={styles.functionRow}
          onMouseDown={(event) => {
            if (
              isMobile &&
              document.activeElement === textareaRef.current &&
              event.target instanceof Element &&
              event.target.closest('button')
            ) {
              event.preventDefault()
            }
          }}
        >
          {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
          <div ref={togglesRef} className={styles.toggles}>
            <Tooltip content={t('deactivatedThinkTooltip')}>
              <ActionButton
                type="button"
                className={clsx(styles.toggle, thinking && styles.selected)}
                aria-label={t('thinkingSwitch')}
                aria-pressed={thinking}
                onClick={() => {
                  triggerHaptic('light')
                  setThinking(!thinking)
                }}
              >
                <IconThinkOutline14 />
                <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
              </ActionButton>
            </Tooltip>
            <Tooltip content={t(custom ? 'customProviderSearchUnavailable' : 'deactivatedSearchTooltip')}>
              <ActionButton
                type="button"
                className={clsx(styles.toggle, !custom && search && styles.selected)}
                aria-label={t('search')}
                aria-pressed={!custom && search}
                onClick={() => {
                  if (useCustomProvider.getState().enabled) {
                    showToast({ key: 'customProviderSearchUnavailable' })
                    return
                  }
                  triggerHaptic('light')
                  setSearch(!search)
                }}
              >
                <IconGlobeLanguageOutline14 />
                <span className={styles.toggleLabel}>{t('search')}</span>
              </ActionButton>
            </Tooltip>
          </div>
          <div className={styles.right}>
            {!isMobile ||
            (!text.trim() && attachments.length === 0 && !streaming) ||
            voice.status !== 'idle' ? (
              <VoiceButton
                className={isMobile ? styles.voiceButton : undefined}
                status={voice.status}
                disabled={!voice.available}
                seconds={voice.seconds}
                onClick={() => {
                  if (voice.status !== 'idle' || !useChatStore.getState().importingHistory) {
                    void voice.toggle()
                  }
                }}
              />
            ) : null}
            {!custom ? <IconButton
              size="m"
              tone="primary"
              className={clsx(isMobile && styles.addButton)}
              icon={
                showAttachmentPicker ? (
                  <IconCloseOutline16 />
                ) : isMobile ? (
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v10M7 12h10" />
                  </svg>
                ) : (
                  <IconPaperclipOutline16 />
                )
              }
              tooltip={t(showAttachmentPicker ? 'close' : 'uploadFile')}
              aria-expanded={isMobile ? showAttachmentPicker : undefined}
              aria-controls={showAttachmentPicker ? attachmentPanelId : undefined}
              disabled={importingHistory}
              onClick={() => {
                if (showAttachmentPicker) {
                  setAttachmentPicker(false)
                  return
                }
                if (!ensureChatConnection()) {
                  return
                }
                if (isMobile) {
                  textareaRef.current?.blur()
                  setAttachmentPicker(true)
                } else {
                  fileInputRef.current?.click()
                }
              }}
            /> : null}
            <Input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={ACCEPT}
              onChange={(event) => {
                acceptFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            {streaming && sessionId ? (
              <ActionButton
                type="button"
                className={styles.sendButton}
                aria-label={t('chatInputStopButtonTooltip')}
                onClick={() => {
                  stopReadAloud()
                  stopReply(sessionId)
                }}
              >
                <IconStopFill16 />
              </ActionButton>
            ) : !isMobile || !!text.trim() || attachments.length > 0 ? (
              <ActionButton
                type="button"
                className={clsx(styles.sendButton, !canSend && styles.disabled)}
                aria-label={t('send')}
                aria-disabled={!canSend}
                onClick={send}
              >
                <IconSendOutline16 />
              </ActionButton>
            ) : null}
          </div>
        </div>
        {isMobile ? (
          <>
            <Input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                acceptFiles(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ''
              }}
            />
            <Input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                acceptFiles(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ''
              }}
            />
          </>
        ) : null}
        {dragging ? <DragMask /> : null}
      </div>
      {showAttachmentPicker ? (
        <div
          ref={attachmentPanelRef}
          id={attachmentPanelId}
          role="group"
          aria-label={t('uploadFile')}
          data-attachment-panel
          className={styles.attachmentChoices}
        >
          {(
            [
              [
                'attachCamera',
                cameraInputRef,
                'M4 7h4l2-3h4l2 3h4a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM15.5 13a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z',
              ],
              ['attachPhotos', photoInputRef, 'M4 4h16v16H4zM4 17l5-5 4 4 3-3 4 4M15.5 8.5h.01'],
              ['attachFiles', fileInputRef, 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6'],
            ] as const
          ).map(([label, input, path]) => (
            <ActionButton
              key={label}
              type="button"
              onClick={() => input.current?.click()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.65"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={path} />
              </svg>
              {t(label)}
            </ActionButton>
          ))}
        </div>
      ) : null}
    </div>
  )
}
