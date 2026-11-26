import {
  ActionButton,
  IconButton,
  IconCheckOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconExpandOutline16,
  Menu,
} from '../base/index.js'
import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'

import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { useTheme } from '../../app/theme.js'
import {
  isPreviewableArtifact,
  sanitizeSvgMarkup,
  svgToPngBlob,
  type ArtifactType,
} from '../../services/markdown/artifactUtils.js'
import {
  saveImageToGallery,
  saveTextFile,
  shareFile,
} from '../../services/native.js'
import { ArtifactPreview } from './ArtifactPreview.js'
import { useMermaidRender } from './MermaidDiagram.js'
import { useMarkdownTheme } from './MarkdownThemeContext.js'
import styles from './CodeBlock.module.css'

type ArtifactView = 'preview' | 'code'
type ArtifactExportOption = {
  key: string
  label: string
  onSelect: () => void
}

const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError'

/** 代码块标题栏：语言名、Artifact 切换、复制、全屏与导出。 */
const CodeInfoRow = ({
  code,
  label,
  artifactType,
  showPreview,
  previewDisabled,
  onToggleView,
  onOpenFullscreen,
  exportOptions,
}: {
  code: string
  label: string
  artifactType: ArtifactType | null
  showPreview: boolean
  previewDisabled: boolean
  onToggleView: (view: ArtifactView) => void
  onOpenFullscreen?: () => void
  exportOptions: ArtifactExportOption[]
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimerRef.current), [])

  return (
    <div className={styles.container}>
      <div className={styles.leading}>
        <span className={styles.name}>{label}</span>
        {artifactType ? (
          <div
            className="md-code-block-switch"
            role="group"
            aria-label={t('artifactSwitchLabel')}
          >
            <ActionButton
              type="button"
              className={styles.button}
              aria-pressed={showPreview}
              disabled={previewDisabled}
              onClick={() => onToggleView('preview')}
            >
              {t('artifactPreview')}
            </ActionButton>
            <ActionButton
              type="button"
              className={styles.button}
              aria-pressed={!showPreview}
              onClick={() => onToggleView('code')}
            >
              {t('artifactCode')}
            </ActionButton>
          </div>
        ) : null}
      </div>
      <div className={styles.actions}>
        <ActionButton
          type="button"
          className={styles.button}
          aria-label={t(copied ? 'copied' : 'copy')}
          onClick={async () => {
            if (!(await copyText(code))) {
              showToast({ key: 'copyFailed' })
              return
            }
            setCopied(true)
            clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
          <span className={styles.copyLabel}>{t(copied ? 'copied' : 'copy')}</span>
        </ActionButton>
        {artifactType && onOpenFullscreen ? (
          <IconButton
            icon={<IconExpandOutline16 />}
            tooltip={t('artifactFullscreen')}
            disabled={previewDisabled}
            onClick={onOpenFullscreen}
          />
        ) : null}
        {artifactType && exportOptions.length > 0 ? (
          <Menu options={exportOptions}>
            {({ open, toggle }) => (
              <IconButton
                icon={<IconDownloadOutline16 />}
                tooltip={t('artifactExport')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              />
            )}
          </Menu>
        ) : null}
      </div>
    </div>
  )
}

/** 代码块：Artifact 类型支持预览、全屏和导出；流式未闭合时保持代码视图。 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
  unclosed = false,
}: {
  code: string
  infostring: string
  loading?: boolean
  unclosed?: boolean
}) {
  const t = useTranslate()
  const dark = useMarkdownTheme(useTheme()) === 'dark'
  const artifactType = isPreviewableArtifact(infostring, code)
  const forceCode = artifactType !== null && unclosed && loading
  const mermaid = useMermaidRender(
    code,
    loading,
    artifactType === 'mermaid' && !forceCode
  )
  const [view, setView] = useState<ArtifactView>('preview')
  const [fullscreen, setFullscreen] = useState(false)
  const exportingRef = useRef(false)
  const showPreview = artifactType !== null && !forceCode && view === 'preview'

  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    if (showPreview) {
      return ''
    }
    const name = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, lang, loaded, showPreview])

  useEffect(() => {
    if (forceCode || !artifactType) {
      setFullscreen(false)
    }
  }, [artifactType, forceCode])

  const artifactTitle =
    artifactType === 'html'
      ? t('artifactTitleHtml')
      : artifactType === 'svg'
        ? t('artifactTitleSvg')
        : t('artifactTitleMermaid')

  const runArtifactTask = async (task: () => Promise<void>) => {
    if (exportingRef.current) {
      return
    }
    exportingRef.current = true
    try {
      await task()
    } catch (error) {
      if (!isAbortError(error)) {
        showToast({ key: 'exportFailed', type: 'error' })
      }
    } finally {
      exportingRef.current = false
    }
  }

  const artifactFileBase = () => `deepchat-${artifactType}-${Date.now()}`
  const artifactSvgMarkup = () => {
    const markup = sanitizeSvgMarkup(artifactType === 'mermaid' ? mermaid.svg : code)
    if (!markup) {
      throw new Error('SVG content is empty')
    }
    return markup
  }
  const saveText = async (extension: 'html' | 'svg', content: string, mimeType: string) => {
    await saveTextFile(`${artifactFileBase()}.${extension}`, content, mimeType)
    showToast({ key: 'exportSaved' })
  }
  const shareText = async (extension: 'html' | 'svg', content: string, mimeType: string) => {
    await shareFile(
      t('appName'),
      `${artifactFileBase()}.${extension}`,
      new Blob([content], { type: `${mimeType};charset=utf-8` })
    )
  }
  const svgBlob = async () =>
    svgToPngBlob(artifactSvgMarkup(), {
      background: dark ? '#1b1b1c' : '#ffffff',
    })

  const exportOptions: ArtifactExportOption[] = []
  if (artifactType === 'html' && !forceCode) {
    exportOptions.push(
      {
        key: 'save-html',
        label: t('artifactSaveHtml'),
        onSelect: () => void runArtifactTask(() => saveText('html', code, 'text/html')),
      },
      {
        key: 'share-html',
        label: t('artifactShareHtml'),
        onSelect: () => void runArtifactTask(() => shareText('html', code, 'text/html')),
      }
    )
  } else if (artifactType && !forceCode) {
    const canExportSvg =
      artifactType === 'svg' || (mermaid.state === 'ready' && !!mermaid.svg)
    if (canExportSvg) {
      exportOptions.push(
        {
          key: 'save-svg',
          label: t('artifactSaveSvg'),
          onSelect: () =>
            void runArtifactTask(async () => saveText('svg', artifactSvgMarkup(), 'image/svg+xml')),
        },
        {
          key: 'share-svg',
          label: t('artifactShareSvg'),
          onSelect: () =>
            void runArtifactTask(async () =>
              shareText('svg', artifactSvgMarkup(), 'image/svg+xml')
            ),
        },
        {
          key: 'save-png',
          label: t('artifactSavePng'),
          onSelect: () =>
            void runArtifactTask(async () => {
              await saveImageToGallery(`${artifactFileBase()}.png`, await svgBlob())
              showToast({ key: 'exportSaved' })
            }),
        },
        {
          key: 'share-png',
          label: t('artifactSharePng'),
          onSelect: () =>
            void runArtifactTask(async () => {
              await shareFile(t('appName'), `${artifactFileBase()}.png`, await svgBlob())
            }),
        }
      )
    }
  }

  return (
    <div className="md-code-block">
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          label={infostring}
          artifactType={artifactType}
          showPreview={showPreview}
          previewDisabled={forceCode}
          onToggleView={setView}
          onOpenFullscreen={
            artifactType
              ? () => {
                  setView('preview')
                  setFullscreen(true)
                }
              : undefined
          }
          exportOptions={exportOptions}
        />
      </div>
      {!fullscreen ? (
        showPreview && artifactType ? (
          <ArtifactPreview
            type={artifactType}
            code={code}
            mermaid={mermaid}
            title={artifactTitle}
          />
        ) : (
          <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
        )
      ) : null}
      {fullscreen && artifactType ? (
        <ArtifactPreview
          type={artifactType}
          code={code}
          mermaid={mermaid}
          title={artifactTitle}
          fullscreen
          onClose={() => setFullscreen(false)}
        />
      ) : null}
    </div>
  )
})
