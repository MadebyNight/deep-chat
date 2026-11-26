import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button, Modal } from '../base/index.js'
import {
  buildArtifactPreviewDocument,
  isTrustedArtifactMessage,
  sanitizeSvgMarkup,
  svgToDataUrl,
  type ArtifactType,
} from '../../services/markdown/artifactUtils.js'
import { MermaidDiagram, type MermaidRenderResult } from './MermaidDiagram.js'
import styles from './ArtifactPreview.module.css'

const MIN_FRAME_HEIGHT = 120
const MAX_FRAME_HEIGHT = 520
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.5
const EMPTY_MERMAID: MermaidRenderResult = { svg: '', state: 'loading' }

const HtmlArtifactFrame = ({
  html,
  title,
  fullscreen = false,
}: {
  html: string
  title: string
  fullscreen?: boolean
}) => {
  const t = useTranslate()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const documentHtml = useMemo(() => buildArtifactPreviewDocument(html), [html])

  useEffect(() => {
    setError(false)
    setHeight(MIN_FRAME_HEIGHT)
  }, [documentHtml])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = isTrustedArtifactMessage(
        event,
        frameRef.current?.contentWindow ?? null
      )
      if (!message) {
        return
      }
      if (message.type === 'deepchat-artifact-error') {
        setError(true)
        return
      }
      setError(false)
      setHeight(
        Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, message.height))
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (error) {
    return (
      <div className={clsx(styles.error, fullscreen && styles.fullscreenError)} role="alert">
        <span>{t('artifactLoadFail')}</span>
        <Button
          size="s"
          variant="outlined"
          onClick={() => {
            setError(false)
            setReloadKey((value) => value + 1)
          }}
        >
          {t('retry')}
        </Button>
      </div>
    )
  }

  return (
    <iframe
      key={reloadKey}
      ref={frameRef}
      className={clsx(styles.htmlFrame, fullscreen && styles.fullscreenHtmlFrame)}
      style={fullscreen ? undefined : { height }}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={documentHtml}
    />
  )
}

const SvgArtifactImage = ({
  markup,
  fullscreen,
  zoom,
}: {
  markup: string
  fullscreen: boolean
  zoom: number
}) => {
  const t = useTranslate()
  const src = useMemo(() => (markup ? svgToDataUrl(markup) : ''), [markup])
  if (!src) {
    return (
      <div className={clsx(styles.error, fullscreen && styles.fullscreenError)} role="alert">
        {t('artifactLoadFail')}
      </div>
    )
  }
  const imageStyle: CSSProperties | undefined = fullscreen
    ? { width: `${zoom * 100}%`, maxWidth: 'none' }
    : undefined
  return (
    <div className={clsx(styles.svgFrame, fullscreen && styles.fullscreenSvgFrame)}>
      <img
        className={styles.svgImage}
        src={src}
        alt={t('artifactTitleSvg')}
        style={imageStyle}
        draggable={false}
      />
    </div>
  )
}

export const ArtifactPreview = ({
  type,
  code,
  mermaid,
  title,
  fullscreen = false,
  onClose,
}: {
  type: ArtifactType
  code: string
  mermaid?: MermaidRenderResult
  title: string
  fullscreen?: boolean
  onClose?: () => void
}) => {
  const t = useTranslate()
  const [zoom, setZoom] = useState(1)
  const svgMarkup = useMemo(
    () => (type === 'svg' ? sanitizeSvgMarkup(code) : ''),
    [code, type]
  )
  const mermaidResult = mermaid ?? EMPTY_MERMAID

  useEffect(() => {
    if (fullscreen) {
      setZoom(1)
    }
  }, [fullscreen])

  const inlineContent =
    type === 'html' ? (
      <HtmlArtifactFrame html={code} title={title} />
    ) : type === 'svg' ? (
      <SvgArtifactImage markup={svgMarkup} fullscreen={false} zoom={1} />
    ) : (
      <MermaidDiagram result={mermaidResult} />
    )

  if (!fullscreen) {
    return <div className={styles.inline}>{inlineContent}</div>
  }

  if (type === 'html') {
    return (
      <Modal
        title={title}
        closable
        fitViewport
        className={styles.modal}
        mainClassName={styles.modalMain}
        onClose={() => onClose?.()}
      >
        <HtmlArtifactFrame html={code} title={title} fullscreen />
      </Modal>
    )
  }

  const zoomIn = () => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))
  const zoomOut = () => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))
  return (
    <Modal
      title={title}
      closable
      fitViewport
      className={styles.modal}
      mainClassName={styles.modalMain}
      onClose={() => onClose?.()}
    >
      <div className={styles.fullscreenContent}>
        <div className={styles.zoomBar}>
          <Button
            size="s"
            variant="outlined"
            className={styles.zoomButton}
            aria-label={t('artifactZoomOut')}
            disabled={zoom <= MIN_ZOOM}
            onClick={zoomOut}
          >
            −
          </Button>
          <Button
            size="s"
            variant="outlined"
            className={styles.zoomButton}
            aria-label={t('artifactZoomReset')}
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            size="s"
            variant="outlined"
            className={styles.zoomButton}
            aria-label={t('artifactZoomIn')}
            disabled={zoom >= MAX_ZOOM}
            onClick={zoomIn}
          >
            +
          </Button>
        </div>
        <div className={styles.fullscreenViewport}>
          {type === 'svg' ? (
            <SvgArtifactImage markup={svgMarkup} fullscreen zoom={zoom} />
          ) : (
            <MermaidDiagram
              result={mermaidResult}
              className={styles.fullscreenMermaid}
              imageStyle={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
