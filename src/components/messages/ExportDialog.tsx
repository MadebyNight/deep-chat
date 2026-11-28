import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, Select, Switch } from '../base/index.js'
import { showToast } from '../base/toastState.js'
import { useTheme } from '../../app/theme.js'
import { useTranslate } from '../../i18n/index.js'
import { normalizeSession } from '../../services/chat/branches.js'
import { loadSession } from '../../services/chat/db.js'
import {
  createExportContent,
  exportFileBase,
  markdownFileName,
  serializeExportMarkdown,
  type ExportContent,
  type MarkdownLabels,
} from '../../services/chat/exportFormats.js'
import {
  buildImageHtml,
  buildPrintableHtml,
  captureShareCard,
  SHARE_CARD_WIDTH,
  ShareImageRenderTimeoutError,
  ShareImageTooLargeError,
} from '../../services/chat/shareImage.js'
import { buildReplyView } from '../../services/chat/view.js'
import type { Session } from '../../services/chat/types.js'
import {
  isAndroid,
  printHtml,
  saveHtmlImagesToGallery,
  saveImagesToGallery,
  saveTextFile,
  shareHtmlImages,
  shareFile,
  shareFiles,
} from '../../services/native.js'
import { useChatStore } from '../../services/chat/store.js'
import { Markdown } from '../markdown/Markdown.js'
import { MarkdownThemeContext } from '../markdown/MarkdownThemeContext.js'
import { closeExportDialog, useExportDialog, type ExportFormat } from './exportDialogState.js'
import styles from './ExportDialog.module.css'

type ExportTheme = 'light' | 'dark'
type ExportAction = 'save' | 'share' | 'print'

export const ShareCard = forwardRef<
  HTMLElement,
  {
    content: ExportContent
    includeQuestion: boolean
    includeModel: boolean
    includeThinking: boolean
    theme: ExportTheme
  }
>(function ShareCard({ content, includeQuestion, includeModel, includeThinking, theme }, ref) {
  const t = useTranslate()
  return (
    <MarkdownThemeContext.Provider value={theme}>
      <article ref={ref} className={styles.card} data-export-theme={theme}>
        <header className={styles.cardHeader}>
          <div className={styles.brand}>Deep Chat</div>
          <h1 className={styles.cardTitle}>{content.title}</h1>
        </header>
        <div className={styles.turns}>
          {content.turns.map((turn, turnIndex) => (
            <section className={styles.turn} key={turn.user?.id ?? `turn-${turnIndex}`}>
              {includeQuestion && turn.user ? (
                <section className={styles.question}>
                  <h2 className={styles.sectionLabel}>{t('exportQuestion')}</h2>
                  {turn.user.content ? (
                    <Markdown
                      content={turn.user.content}
                      loading={false}
                      cacheKey={`${turn.user.id}-export-question`}
                      disableLink={false}
                    />
                  ) : null}
                  {turn.user.files.length > 0 ? (
                    <ul className={styles.attachments}>
                      {turn.user.files.map((file) => (
                        <li key={file.id}>{file.name}</li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
              {turn.replies.map((reply, replyIndex) => {
                const view = buildReplyView(reply, false)
                const thinking = view.steps
                  .flatMap((step) =>
                    step.type === 'thinking'
                      ? step.blocks.map((block) => block.thinking.trim())
                      : []
                  )
                  .filter(Boolean)
                  .join('\n\n')
                return (
                  <section className={styles.reply} key={reply.id}>
                    {includeModel && reply.model ? (
                      <div className={styles.model} data-export-model>
                        <span>{t('exportModel')}</span>
                        <code>{reply.model}</code>
                      </div>
                    ) : null}
                    {includeThinking && thinking ? (
                      <section className={styles.thinking}>
                        <h2 className={styles.sectionLabel}>{t('exportThinking')}</h2>
                        <Markdown
                          content={thinking}
                          loading={false}
                          cacheKey={`${reply.id}-export-thinking-${replyIndex}`}
                          disableLink={false}
                        />
                      </section>
                    ) : null}
                    {view.answer?.markdown ? (
                      <>
                        <h2 className={styles.sectionLabel}>{t('exportAnswer')}</h2>
                        <Markdown
                          content={view.answer.markdown}
                          loading={false}
                          cacheKey={`${reply.id}-export-answer`}
                          disableLink={false}
                          sources={view.sources}
                        />
                      </>
                    ) : null}
                    {view.sources.length > 0 ? (
                      <section className={styles.sources}>
                        <h2 className={styles.sectionLabel}>{t('exportSources')}</h2>
                        <ol>
                          {view.sources.map((source) => (
                            <li key={source.url}>
                              <a href={source.url}>{source.title}</a>
                            </li>
                          ))}
                        </ol>
                      </section>
                    ) : null}
                  </section>
                )
              })}
            </section>
          ))}
        </div>
      </article>
    </MarkdownThemeContext.Provider>
  )
})

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

export const ExportDialog = () => {
  const t = useTranslate()
  const pageTheme = useTheme()
  const pageThemeRef = useRef(pageTheme)
  pageThemeRef.current = pageTheme
  const target = useExportDialog((state) => state.target)
  const initialFormat = useExportDialog((state) => state.initialFormat)
  const cachedSession = useChatStore((state) =>
    target ? state.sessionCache[target.sessionId] : undefined
  )
  const [loadedSession, setLoadedSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [format, setFormat] = useState<ExportFormat>(initialFormat)
  const [theme, setTheme] = useState<ExportTheme>(pageTheme)
  const [includeQuestion, setIncludeQuestion] = useState(true)
  const [includeModel, setIncludeModel] = useState(true)
  const [includeThinking, setIncludeThinking] = useState(true)
  const [includeSources, setIncludeSources] = useState(true)
  const [busy, setBusy] = useState<ExportAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [previewHeight, setPreviewHeight] = useState(0)
  const cardRef = useRef<HTMLElement>(null)
  const previewViewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!target) {
      setLoadedSession(null)
      setLoading(false)
      setLoadFailed(false)
      return
    }
    setFormat(initialFormat)
    setTheme(pageThemeRef.current)
    setIncludeQuestion(true)
    setIncludeModel(true)
    setIncludeThinking(true)
    setIncludeSources(true)
    setBusy(null)
    setError(null)
    const cached = useChatStore.getState().sessionCache[target.sessionId]
    if (cached) {
      setLoadedSession(cached)
      setLoading(false)
      setLoadFailed(false)
      return
    }
    let active = true
    setLoadedSession(null)
    setLoading(true)
    setLoadFailed(false)
    void loadSession(target.sessionId)
      .then((stored) => {
        if (!active) {
          return
        }
        if (!stored) {
          throw new Error('Session not found')
        }
        setLoadedSession(normalizeSession(stored))
      })
      .catch(() => {
        if (active) {
          setLoadFailed(true)
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
  }, [initialFormat, target])

  const session = cachedSession ?? loadedSession
  const labels = useMemo<MarkdownLabels>(
    () => ({
      question: t('exportQuestion'),
      answer: t('exportAnswer'),
      model: t('exportModel'),
      thinking: t('exportThinking'),
      sources: t('exportSources'),
      attachments: t('exportAttachments'),
    }),
    [t]
  )
  const content = useMemo(() => {
    if (!session || !target) {
      return null
    }
    try {
      const withQuestion = format === 'markdown' ? target.kind !== 'message' : includeQuestion
      return createExportContent(session, target, {
        includeQuestion: withQuestion,
        fallbackTitle: t('untitledChat'),
      })
    } catch {
      return null
    }
  }, [format, includeQuestion, session, t, target])
  const markdown = useMemo(
    () =>
      content
        ? serializeExportMarkdown(content, {
            labels,
            includeThinking,
            includeSources,
          })
        : '',
    [content, includeSources, includeThinking, labels]
  )
  const ready = !!content && !!markdown.trim()

  useLayoutEffect(() => {
    if (format === 'markdown' || !content) {
      return
    }
    const viewport = previewViewportRef.current
    const card = cardRef.current
    if (!viewport || !card) {
      return
    }
    const measure = () => {
      const scale = Math.min(1, viewport.clientWidth / SHARE_CARD_WIDTH)
      setPreviewScale(scale)
      setPreviewHeight(card.offsetHeight * scale)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(card)
    return () => observer.disconnect()
  }, [content, format, includeModel, includeQuestion, includeThinking, theme])

  if (!target) {
    return null
  }

  const close = () => {
    if (!busy) {
      closeExportDialog()
    }
  }
  const fail = (cause: unknown) => {
    if (!isAbortError(cause)) {
      setError(
        cause instanceof ShareImageTooLargeError
          ? t('exportTooLarge')
          : cause instanceof ShareImageRenderTimeoutError
            ? t('exportRenderTimeout')
            : t('exportFailed')
      )
    }
  }
  const run = async (action: ExportAction, task: () => Promise<void>) => {
    if (busy || !ready) {
      return
    }
    setBusy(action)
    setError(null)
    try {
      await task()
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(null)
    }
  }
  const shareMarkdown = () =>
    run('share', async () => {
      if (!content) {
        return
      }
      await shareFile(
        content.title,
        markdownFileName(content),
        new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      )
      closeExportDialog()
    })
  const saveMarkdown = () =>
    run('save', async () => {
      if (!content) {
        return
      }
      await saveTextFile(markdownFileName(content), markdown, 'text/markdown')
      showToast({ key: 'exportSaved' })
      closeExportDialog()
    })
  const generateImages = async () => {
    if (!content || !cardRef.current) {
      throw new Error('Share card is not ready')
    }
    return captureShareCard(cardRef.current, {
      fileBase: exportFileBase(content),
    })
  }
  const buildNativeImage = async () => {
    if (!content || !cardRef.current) {
      throw new Error('Share card is not ready')
    }
    const { html, background } = await buildImageHtml(cardRef.current, content.title)
    return {
      html,
      background,
      heightCss: Math.max(cardRef.current.offsetHeight, cardRef.current.scrollHeight),
      fileBase: exportFileBase(content),
    }
  }
  const saveImage = () =>
    run('save', async () => {
      if (isAndroid) {
        const image = await buildNativeImage()
        await saveHtmlImagesToGallery(
          image.fileBase,
          image.html,
          image.heightCss,
          image.background
        )
        showToast({ key: 'exportSaved' })
        closeExportDialog()
        return
      }
      const images = await generateImages()
      await saveImagesToGallery(
        images.map((image) => ({ fileName: image.fileName, blob: image.blob }))
      )
      showToast({ key: 'exportSaved' })
      closeExportDialog()
    })
  const shareImage = () =>
    run('share', async () => {
      if (isAndroid) {
        const image = await buildNativeImage()
        await shareHtmlImages(
          content?.title ?? t('appName'),
          image.fileBase,
          image.html,
          image.heightCss,
          image.background
        )
        closeExportDialog()
        return
      }
      const images = await generateImages()
      await shareFiles(
        content?.title ?? t('appName'),
        images.map((image) => ({ name: image.fileName, blob: image.blob }))
      )
      closeExportDialog()
    })
  const print = () =>
    run('print', async () => {
      if (!content || !cardRef.current) {
        throw new Error('Share card is not ready')
      }
      const html = await buildPrintableHtml(cardRef.current, content.title)
      await printHtml(content.title, html)
      closeExportDialog()
    })

  const optionLabel = (action: ExportAction) => {
    if (action === busy) {
      return t(
        action === 'save' ? 'exportSaving' : action === 'share' ? 'exportSharing' : 'exportPrinting'
      )
    }
    return t(
      action === 'save'
        ? format === 'image'
          ? 'exportSaveImage'
          : 'exportSaveFile'
        : action === 'share'
          ? 'exportShare'
          : 'exportPrint'
    )
  }

  return (
    <Modal
      title={t('exportTitle')}
      closable={!busy}
      onClose={close}
      className={styles.dialog}
      mainClassName={styles.body}
      footer={
        format === 'print' ? (
          <Button variant="primary" disabled={!ready || !!busy} onClick={() => void print()}>
            {optionLabel('print')}
          </Button>
        ) : (
          <>
            <Button
              variant="outlined"
              disabled={!ready || !!busy}
              onClick={() => void (format === 'markdown' ? shareMarkdown() : shareImage())}
            >
              {optionLabel('share')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready || !!busy}
              onClick={() => void (format === 'markdown' ? saveMarkdown() : saveImage())}
            >
              {optionLabel('save')}
            </Button>
          </>
        )
      }
    >
      {loading ? (
        <p className={styles.status} role="status">
          {t('sessionLoading')}
        </p>
      ) : loadFailed ? (
        <p className={styles.error} role="alert">
          {t('exportFailed')}
        </p>
      ) : session ? (
        <>
          <div className={styles.field}>
            <span>{t('exportFormat')}</span>
            <Select
              value={format}
              ariaLabel={t('exportFormat')}
              disabled={!!busy}
              options={[
                { value: 'markdown', label: t('exportFormatMarkdown') },
                { value: 'image', label: t('exportFormatImage') },
                { value: 'print', label: t('exportFormatPrint') },
              ]}
              onChange={setFormat}
            />
          </div>
          {format === 'markdown' ? (
            <div className={styles.switches}>
              <div className={styles.switchRow}>
                <span>{t('exportThinking')}</span>
                <Switch
                  checked={includeThinking}
                  aria-label={t('exportThinking')}
                  disabled={!!busy}
                  onClick={() => setIncludeThinking((value) => !value)}
                />
              </div>
              <div className={styles.switchRow}>
                <span>{t('exportSources')}</span>
                <Switch
                  checked={includeSources}
                  aria-label={t('exportSources')}
                  disabled={!!busy}
                  onClick={() => setIncludeSources((value) => !value)}
                />
              </div>
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <span>{t('exportTheme')}</span>
                <Select
                  value={theme}
                  ariaLabel={t('exportTheme')}
                  disabled={!!busy}
                  options={[
                    { value: 'light', label: t('exportThemeLight') },
                    { value: 'dark', label: t('exportThemeDark') },
                  ]}
                  onChange={setTheme}
                />
              </div>
              <div className={styles.switches}>
                <div className={styles.switchRow}>
                  <span>{t('exportQuestion')}</span>
                  <Switch
                    checked={includeQuestion}
                    aria-label={t('exportQuestion')}
                    disabled={!!busy}
                    onClick={() => setIncludeQuestion((value) => !value)}
                  />
                </div>
                <div className={styles.switchRow}>
                  <span>{t('exportModel')}</span>
                  <Switch
                    checked={includeModel}
                    aria-label={t('exportModel')}
                    disabled={!!busy}
                    onClick={() => setIncludeModel((value) => !value)}
                  />
                </div>
                <div className={styles.switchRow}>
                  <span>{t('exportThinking')}</span>
                  <Switch
                    checked={includeThinking}
                    aria-label={t('exportThinking')}
                    disabled={!!busy}
                    onClick={() => setIncludeThinking((value) => !value)}
                  />
                </div>
              </div>
              <div ref={previewViewportRef} className={styles.previewViewport}>
                <div className={styles.previewSizer} style={{ height: `${previewHeight}px` }}>
                  <div
                    className={styles.previewScale}
                    style={{ transform: `scale(${previewScale})` }}
                  >
                    <ShareCard
                      ref={cardRef}
                      content={content ?? { title: '', turns: [], replyCount: 0 }}
                      includeQuestion={includeQuestion}
                      includeModel={includeModel}
                      includeThinking={includeThinking}
                      theme={theme}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
          {!content ? (
            <p className={styles.error} role="alert">
              {t('exportEmpty')}
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}
