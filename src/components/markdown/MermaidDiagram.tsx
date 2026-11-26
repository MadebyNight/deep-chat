import clsx from 'clsx'
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useTheme } from '../../app/theme.js'
import { renderMermaid } from '../../services/markdown/mermaid.js'
import { sanitizeSvgMarkup, svgToDataUrl } from '../../services/markdown/artifactUtils.js'
import { useMarkdownTheme } from './MarkdownThemeContext.js'

export type MermaidRenderState = 'empty' | 'loading' | 'error' | 'ready'

export type MermaidRenderResult = {
  svg: string
  state: MermaidRenderState
}

const EMPTY_RESULT: MermaidRenderResult = { svg: '', state: 'empty' }

/**
 * 流式绘制最新内容、保留上次有效图；回答结束后才显示渲染错误。
 * 代码块和外层工具条共用此结果，避免为了导出重复渲染。
 */
export const useMermaidRender = (
  code: string,
  loading: boolean,
  enabled = true
): MermaidRenderResult => {
  const dark = useMarkdownTheme(useTheme()) === 'dark'
  const [result, setResult] = useState({
    svg: '',
    renderedCode: '',
    renderedDark: false,
    failedCode: null as string | null,
  })
  const latestCodeRef = useRef(code)
  latestCodeRef.current = code
  // 流式阶段从 ref 取最新文本，避免每个片段都取消绘制；结束后立即绘制完整内容。
  const finalCode = loading ? null : code

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previousCode: string | undefined
    let displayedCode: string | undefined

    const draw = async (input: string) => {
      if (input === displayedCode || cancelled) {
        return
      }
      const svg = await renderMermaid(input, dark, () => cancelled)
      if (svg && !cancelled) {
        displayedCode = input
        setResult({ svg, renderedCode: input, renderedDark: dark, failedCode: null })
      }
    }

    const renderLatest = async () => {
      const input = latestCodeRef.current
      if (input !== previousCode) {
        previousCode = input
        try {
          await draw(input)
        } catch {
          if (!cancelled) {
            if (loading) {
              // 流式片段的末行可能包含未完成的节点，仅绘制前面的完整行。
              const text = input.trimEnd()
              const lineEnd = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
              const prefix = text.slice(0, Math.max(0, lineEnd))
              // 已显示的内容覆盖当前前缀时保持图形。
              if (prefix && !displayedCode?.startsWith(prefix)) {
                try {
                  await draw(prefix)
                } catch {
                  // 前缀也可能尚未构成完整语法，保留已有图。
                }
              }
            } else {
              setResult({
                svg: '',
                renderedCode: '',
                renderedDark: dark,
                failedCode: input,
              })
            }
          }
        }
      }
      // 当前帧结束后绘制最新片段，连续输入合并为一次绘制。
      if (!cancelled && loading) {
        timer = setTimeout(renderLatest, 100)
      }
    }

    void renderLatest()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [dark, enabled, loading, finalCode])

  if (!enabled) {
    return EMPTY_RESULT
  }
  const state: MermaidRenderState = !code.trim()
    ? loading
      ? 'loading'
      : 'empty'
    : result.failedCode === code && !loading
      ? 'error'
      : result.svg && result.renderedCode === code && result.renderedDark === dark
        ? 'ready'
        : 'loading'
  return { svg: result.svg, state }
}

/** 将 Mermaid 结果净化后放进图片上下文，脚本和事件无法在主页面执行。 */
export const MermaidDiagram = memo(function MermaidDiagram({
  result,
  className,
  imageStyle,
}: {
  result: MermaidRenderResult
  className?: string
  imageStyle?: CSSProperties
}) {
  const t = useTranslate()
  const markup = useMemo(
    () => (result.svg ? sanitizeSvgMarkup(result.svg) : ''),
    [result.svg]
  )
  const src = useMemo(() => (markup ? svgToDataUrl(markup) : ''), [markup])
  if (!src) {
    const state: MermaidRenderState =
      result.state === 'ready' || result.state === 'error' ? 'error' : result.state
    return (
      <div
        className={clsx('md-mermaid-status', className)}
        role={state === 'error' ? 'alert' : 'status'}
        data-mermaid-state={state}
      >
        {state === 'empty'
          ? t('mermaidEmpty')
          : state === 'error'
            ? t('mermaidRenderFail')
            : t('mermaidLoading')}
      </div>
    )
  }
  return (
    <div className={clsx('md-mermaid-diagram', className)} data-mermaid-state={result.state}>
      <img src={src} alt={t('artifactTitleMermaid')} style={imageStyle} draggable={false} />
    </div>
  )
})
