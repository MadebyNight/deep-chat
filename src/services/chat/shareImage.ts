import { ensureKatex } from '../markdown/katex.js'

export const SHARE_CARD_WIDTH = 720
export const SHARE_SLICE_CSS_HEIGHT = 6000
const TARGET_PIXEL_WIDTH = 1080
const MAX_CANVAS_PIXELS = 18_000_000
const MAX_SLICES = 24
const MAX_FONT_BYTES = 4 * 1024 * 1024
const MAX_EMBEDDED_FONT_BYTES = 20 * 1024 * 1024
const XHTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'

export type ShareImagePlan = {
  width: number
  height: number
  pixelWidth: number
  scale: number
  sliceCssHeight: number
  slicePixelHeight: number
  sliceCount: number
}

export type ShareImageFile = {
  fileName: string
  blob: Blob
}

export class ShareImageTooLargeError extends Error {
  constructor() {
    super('Share image exceeds the safe slice budget')
    this.name = 'ShareImageTooLargeError'
  }
}

export class ShareImageRenderTimeoutError extends Error {
  constructor() {
    super('Share image content did not finish rendering')
    this.name = 'ShareImageRenderTimeoutError'
  }
}

export const planShareImage = (
  height: number,
  width = SHARE_CARD_WIDTH,
  sliceCssHeight = SHARE_SLICE_CSS_HEIGHT,
  maxSlices = MAX_SLICES
): ShareImagePlan => {
  const safeWidth = Math.max(1, Math.ceil(width))
  const safeHeight = Math.max(1, Math.ceil(height))
  const safeSliceHeight = Math.max(1, Math.floor(sliceCssHeight))
  const scale = Math.min(
    1.5,
    TARGET_PIXEL_WIDTH / safeWidth,
    Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeSliceHeight))
  )
  const sliceCount = Math.ceil(safeHeight / safeSliceHeight)
  if (sliceCount > maxSlices) {
    throw new ShareImageTooLargeError()
  }
  return {
    width: safeWidth,
    height: safeHeight,
    pixelWidth: Math.max(1, Math.round(safeWidth * scale)),
    scale,
    sliceCssHeight: safeSliceHeight,
    slicePixelHeight: Math.max(1, Math.round(safeSliceHeight * scale)),
    sliceCount,
  }
}

const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/** 等待公式、字体和异步 Mermaid 图完成，避免首帧生成空白占位。 */
export const waitForShareCard = async (element: HTMLElement) => {
  await Promise.resolve(ensureKatex()).catch(() => undefined)
  await document.fonts?.ready.catch(() => undefined)
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!element.querySelector('[data-mermaid-state="loading"]')) {
      break
    }
    await wait(100)
  }
  if (element.querySelector('[data-mermaid-state="loading"]')) {
    throw new ShareImageRenderTimeoutError()
  }
  await nextFrame()
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read font'))
    reader.readAsDataURL(blob)
  })

const fontCache = new Map<string, Promise<string | null>>()

const fontDataUrl = (url: string) => {
  const cached = fontCache.get(url)
  if (cached) {
    return cached
  }
  const loaded = (async () => {
    try {
      const response = await fetch(url, { credentials: 'omit' })
      if (!response.ok) {
        return null
      }
      const blob = await response.blob()
      if (blob.size > MAX_FONT_BYTES) {
        return null
      }
      return await blobToDataUrl(blob)
    } catch {
      return null
    }
  })()
  fontCache.set(url, loaded)
  return loaded
}

const absoluteUrl = (value: string, base: string) => {
  try {
    return new URL(value, base).toString()
  } catch {
    return null
  }
}

const collectCssText = async () => {
  const chunks: { css: string; href: string }[] = []
  for (const sheet of document.styleSheets) {
    try {
      chunks.push({
        css: [...sheet.cssRules].map((rule) => rule.cssText).join('\n'),
        href: sheet.href ?? window.location.href,
      })
    } catch {
      // Cross-origin stylesheets cannot be read; the export card uses same-origin app CSS.
    }
  }
  let embeddedBytes = 0
  const replacements = new Map<string, string>()
  for (const { css, href } of chunks) {
    const matches = css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)
    for (const match of matches) {
      const raw = match[2]
      if (!raw || raw.startsWith('data:') || !/\.(?:woff2?|ttf|otf)(?:[?#].*)?$/i.test(raw)) {
        continue
      }
      const url = absoluteUrl(raw, href)
      if (!url) {
        continue
      }
      const data = await fontDataUrl(url)
      if (!data) {
        continue
      }
      embeddedBytes += Math.ceil((data.length * 3) / 4)
      if (embeddedBytes > MAX_EMBEDDED_FONT_BYTES) {
        break
      }
      replacements.set(raw, data)
    }
  }
  return chunks
    .map(({ css }) =>
      css.replace(/url\((['"]?)([^'")]+)\1\)/g, (full, _quote: string, raw: string) => {
        const replacement = replacements.get(raw)
        return replacement ? `url("${replacement}")` : full
      })
    )
    .join('\n')
}

const SNAPSHOT_CSS = `
  * { animation: none !important; transition: none !important; caret-color: transparent !important; }
  button, [role='button'] { display: none !important; }
  a { text-decoration: none !important; }
  .md-code-block-switch { display: none !important; }
`

const copyCustomProperties = (source: HTMLElement, target: HTMLElement) => {
  const computed = getComputedStyle(source)
  for (const property of computed) {
    if (property.startsWith('--')) {
      target.style.setProperty(property, computed.getPropertyValue(property))
    }
  }
}

const cloneCard = (element: HTMLElement) => {
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('button, [role="button"]').forEach((node) => node.remove())
  copyCustomProperties(element, clone)
  return clone
}

const serializeSlice = (
  element: HTMLElement,
  css: string,
  offset: number,
  sliceHeight: number,
  background: string,
  theme: 'light' | 'dark'
) => {
  const documentRoot = document.implementation.createHTMLDocument('')
  documentRoot.documentElement.setAttribute('xmlns', XHTML)
  documentRoot.body.className = theme
  documentRoot.body.setAttribute('style', 'margin:0;padding:0;background:transparent;')
  const style = documentRoot.createElement('style')
  style.textContent = `${css}\n${SNAPSHOT_CSS}`
  const clip = documentRoot.createElement('div')
  clip.setAttribute(
    'style',
    `width:${SHARE_CARD_WIDTH}px;height:${sliceHeight}px;overflow:hidden;background:${background};`
  )
  const positioned = documentRoot.createElement('div')
  positioned.setAttribute('style', `width:${SHARE_CARD_WIDTH}px;margin-top:-${offset}px;`)
  const clone = cloneCard(element)
  positioned.appendChild(clone)
  clip.appendChild(positioned)
  documentRoot.head.appendChild(style)
  documentRoot.body.appendChild(clip)
  return new XMLSerializer().serializeToString(documentRoot.documentElement)
}

const svgToImage = async (svg: string) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Could not rasterize share card'))
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  return { image, url }
}

const canvasBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode share image'))),
      'image/png'
    )
  })

/**
 * 将已渲染的分享卡片切分为 PNG。每个分片使用独立 Canvas，渲染完立即释放；
 * 任一画布受宽度、高度和像素总量三重预算限制。
 */
export const captureShareCard = async (
  element: HTMLElement,
  { fileBase }: { fileBase: string }
): Promise<ShareImageFile[]> => {
  await waitForShareCard(element)
  const css = await collectCssText()
  const computed = getComputedStyle(element)
  const background = computed.backgroundColor || '#ffffff'
  const height = Math.max(element.offsetHeight, element.scrollHeight)
  const plan = planShareImage(height, SHARE_CARD_WIDTH)
  const theme = element.dataset.exportTheme === 'dark' ? 'dark' : 'light'
  const files: ShareImageFile[] = []
  for (let index = 0; index < plan.sliceCount; index++) {
    const offset = index * plan.sliceCssHeight
    const currentHeight = Math.min(plan.sliceCssHeight, plan.height - offset)
    const pixelHeight = Math.max(1, Math.round(currentHeight * plan.scale))
    const snapshot = serializeSlice(element, css, offset, currentHeight, background, theme)
    const svg = [
      `<svg xmlns="${SVG}" width="${plan.width}" height="${currentHeight}" viewBox="0 0 ${plan.width} ${currentHeight}">`,
      `<foreignObject x="0" y="0" width="${plan.width}" height="${currentHeight}">`,
      snapshot,
      '</foreignObject></svg>',
    ].join('')
    const { image, url } = await svgToImage(svg)
    const canvas = document.createElement('canvas')
    let blob: Blob
    try {
      canvas.width = plan.pixelWidth
      canvas.height = pixelHeight
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) {
        throw new Error('Canvas is unavailable')
      }
      context.fillStyle = background
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      blob = await canvasBlob(canvas)
    } finally {
      URL.revokeObjectURL(url)
      canvas.width = 0
      canvas.height = 0
    }
    files.push({
      fileName: plan.sliceCount === 1 ? `${fileBase}.png` : `${fileBase}-${index + 1}.png`,
      blob,
    })
  }
  return files
}

const buildStandaloneHtml = async (
  element: HTMLElement,
  title: string,
  extraCss: string,
  viewport = 'width=device-width,initial-scale=1'
) => {
  await waitForShareCard(element)
  const clone = cloneCard(element)
  const css = await collectCssText()
  const escapedTitle = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  const theme = element.dataset.exportTheme === 'dark' ? 'dark' : 'light'
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="${viewport}">
<title>${escapedTitle}</title>
<style>
${css}
${extraCss}
</style>
</head>
<body class="${theme}">${clone.outerHTML}</body>
</html>`
}

/** 生成可交给原生 WebView 或隐藏 iframe 的独立打印 HTML。 */
export const buildPrintableHtml = (element: HTMLElement, title: string) =>
  buildStandaloneHtml(
    element,
    title,
    `
html, body { margin: 0 !important; padding: 0 !important; overflow: visible !important; background: #fff !important; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@page { size: A4; margin: 12mm; }
body > article { width: 100% !important; max-width: 720px !important; margin: 0 auto !important; }
.md-code-block { break-inside: auto; }
.md-code-block-banner { break-after: avoid; }
.md-mermaid-diagram, blockquote, .ds-markdown-math { break-inside: avoid; }
`
  )

/** 生成 Android 原生 WebView 分段栅格化使用的独立 HTML。 */
export const buildImageHtml = async (element: HTMLElement, title: string) => {
  const cssBackground = getComputedStyle(element).backgroundColor || '#ffffff'
  const rgb = cssBackground.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/
  )
  const background = rgb
    ? `#${rgb
        .slice(1, 4)
        .map((value) => Number(value).toString(16).padStart(2, '0'))
        .join('')}`
    : cssBackground
  const html = await buildStandaloneHtml(
    element,
    title,
    `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  width: ${SHARE_CARD_WIDTH}px !important;
  overflow: hidden !important;
  background: ${cssBackground} !important;
}
body > article {
  width: ${SHARE_CARD_WIDTH}px !important;
  max-width: ${SHARE_CARD_WIDTH}px !important;
  margin: 0 !important;
}
`,
    `width=${SHARE_CARD_WIDTH}`
  )
  return { html, background }
}
