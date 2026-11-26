export type ArtifactType = 'html' | 'svg' | 'mermaid'

const HTML_LANGUAGES = new Set(['html', 'htm', 'text/html', 'application/xhtml+xml'])
const SVG_LANGUAGES = new Set(['svg', 'image/svg+xml'])
const MERMAID_LANGUAGES = new Set(['mermaid'])

/** 识别可进入 Artifact 模式的代码块；空内容保持普通代码块。 */
export const isPreviewableArtifact = (
  infostring: string,
  code: string
): ArtifactType | null => {
  if (!code.trim()) {
    return null
  }
  const language = infostring.trim().toLowerCase().split(/\s+/, 1)[0].replace(/^language-/, '')
  if (HTML_LANGUAGES.has(language)) {
    return 'html'
  }
  if (SVG_LANGUAGES.has(language)) {
    return /<svg[\s/>]/i.test(code) ? 'svg' : null
  }
  if (MERMAID_LANGUAGES.has(language)) {
    return 'mermaid'
  }
  return null
}

/** 流式阶段判断最后一个代码围栏是否尚未闭合。 */
export const hasOpenCodeFence = (markdown: string): boolean => {
  let fence: { character: string; length: number } | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const stripped = line.replace(/^(?: {0,3}>[ \t]?)+/, '')
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(stripped)
    if (!fence) {
      if (!match) {
        continue
      }
      const marker = match[1]
      if (marker.startsWith('`') && match[2].includes('`')) {
        continue
      }
      fence = { character: marker[0], length: marker.length }
      continue
    }
    if (
      match &&
      match[1].startsWith(fence.character) &&
      match[1].length >= fence.length &&
      !match[2].trim()
    ) {
      fence = null
    }
  }
  return fence !== null
}

export const ARTIFACT_MAX_HEIGHT = 20_000

export type ArtifactPreviewMessage =
  | { type: 'deepchat-artifact-height'; height: number }
  | { type: 'deepchat-artifact-error' }

/** 只接受本预览协议内的消息和有限高度。 */
export const parseArtifactMessage = (data: unknown): ArtifactPreviewMessage | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null
  }
  const record = data as Record<string, unknown>
  if (record.type === 'deepchat-artifact-error') {
    return { type: 'deepchat-artifact-error' }
  }
  if (record.type !== 'deepchat-artifact-height') {
    return null
  }
  const height = record.height
  if (
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    !Number.isInteger(height) ||
    height < 0 ||
    height > ARTIFACT_MAX_HEIGHT
  ) {
    return null
  }
  return { type: 'deepchat-artifact-height', height }
}

/** event.source 必须就是当前 iframe 的窗口，再校验消息结构。 */
export const isTrustedArtifactMessage = (
  event: { source: unknown; data: unknown },
  iframeWindow: unknown
): ArtifactPreviewMessage | null => {
  if (!iframeWindow || event.source !== iframeWindow) {
    return null
  }
  return parseArtifactMessage(event.data)
}

export const ARTIFACT_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
].join('; ')

const ARTIFACT_BOOTSTRAP = `<script>(function () {
  var lastHeight = -1;
  function reportHeight() {
    var body = document.body;
    var height = Math.ceil(Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      body ? body.scrollHeight : 0
    ));
    if (height !== lastHeight) {
      lastHeight = height;
      parent.postMessage({ type: 'deepchat-artifact-height', height: height }, '*');
    }
  }
  function reportError(event) {
    if (event && event.target && event.target !== window) {
      return;
    }
    parent.postMessage({ type: 'deepchat-artifact-error' }, '*');
  }
  addEventListener('error', reportError, true);
  addEventListener('unhandledrejection', reportError);
  addEventListener('load', reportHeight);
  addEventListener('resize', reportHeight);
  if (typeof ResizeObserver === 'function') {
    var observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
    if (document.body) {
      observer.observe(document.body);
    }
  }
  setTimeout(reportHeight, 0);
})();</script>`

/**
 * 把 CSP 和高度/错误上报脚本放到用户文档最前面。
 * 不按 `<head>` 文本位置插入，避免注释、脚本字符串里的伪标签绕过 CSP；
 * 浏览器解析前置的 doctype/meta/script 后会继续使用用户文档中的 head/body。
 * 脚本仍可运行，但所有外部资源、连接、表单、子框架都被阻断。
 */
export const buildArtifactPreviewDocument = (html: string): string => {
  const source = html.replace(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*(['"]?)refresh\1[^>]*>/gi,
    ''
  )
  const head = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_PREVIEW_CSP}">${ARTIFACT_BOOTSTRAP}`
  return `<!doctype html>${head}${source}`
}

const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src'])
const DROPPED_ATTRIBUTES = new Set(['srcset', 'ping', 'action', 'formaction', 'srcdoc', 'xml:base'])
const BLOCKED_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'template',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'link',
  'meta',
  'base',
  'html',
  'body',
  'set',
  'animate',
  'animatetransform',
  'animatemotion',
  'handler',
  'listener',
])
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi

type SvgAttribute = {
  name: string
  value: string | null
  raw: string
}

const findTagEnd = (source: string, start: number): number => {
  let quote = ''
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) {
        quote = ''
      }
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

const escapeAttribute = (value: string): string =>
  value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const isSafeCssUrl = (raw: string): boolean => {
  const value = raw.trim()
  return (
    value.startsWith('#') ||
    /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)|font\/[a-z0-9.+-]+|application\/font-[a-z0-9.+-]+)/i.test(
      value
    )
  )
}

const sanitizeCss = (css: string): string =>
  css
    .replace(/@import\b[^;{}]*(?:;|(?=\}))/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/(?:behavior|-moz-binding)\s*:/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(CSS_URL, (match, _quote: string, url: string) =>
      isSafeCssUrl(url) ? match : 'none'
    )

const isSafeSvgHref = (value: string): boolean => {
  const trimmed = value.trim()
  return trimmed.startsWith('#') || /^data:image\//i.test(trimmed)
}

const parseAttributes = (source: string, start: number, end: number): SvgAttribute[] => {
  const attributes: SvgAttribute[] = []
  let index = start
  while (index < end) {
    while (index < end && /\s/.test(source[index])) {
      index++
    }
    if (index >= end || source[index] === '/') {
      break
    }
    const nameStart = index
    while (index < end && !/[\s=/>]/.test(source[index])) {
      index++
    }
    const name = source.slice(nameStart, index)
    if (!name) {
      index++
      continue
    }
    while (index < end && /\s/.test(source[index])) {
      index++
    }
    let value: string | null = null
    if (source[index] === '=') {
      index++
      while (index < end && /\s/.test(source[index])) {
        index++
      }
      const quote = source[index]
      if (quote === '"' || quote === "'") {
        index++
        const valueStart = index
        while (index < end && source[index] !== quote) {
          index++
        }
        value = source.slice(valueStart, index)
        if (source[index] === quote) {
          index++
        }
      } else {
        const valueStart = index
        while (index < end && !/[\s>]/.test(source[index])) {
          index++
        }
        value = source.slice(valueStart, index)
      }
    }
    attributes.push({ name, value, raw: source.slice(nameStart, index).trim() })
  }
  return attributes
}

const sanitizeAttribute = (attribute: SvgAttribute): string | null => {
  if (!ATTRIBUTE_NAME.test(attribute.name)) {
    return null
  }
  const lower = attribute.name.toLowerCase()
  if (lower.startsWith('on') || DROPPED_ATTRIBUTES.has(lower)) {
    return null
  }
  if (attribute.value === null) {
    return attribute.name
  }
  if (lower === 'style') {
    const css = sanitizeCss(attribute.value).trim()
    return css ? `${attribute.name}="${escapeAttribute(css)}"` : null
  }
  if (URL_ATTRIBUTES.has(lower) && !isSafeSvgHref(attribute.value)) {
    return null
  }
  const cleanValue = sanitizeCss(attribute.value).replace(/javascript\s*:/gi, '')
  if (!cleanValue.trim()) {
    return null
  }
  return cleanValue === attribute.value
    ? attribute.raw
    : `${attribute.name}="${escapeAttribute(cleanValue)}"`
}

/**
 * 只保留一个根 SVG，并移除脚本、foreignObject、事件、外部链接和外部 CSS 引用。
 * 预览本身仍放在图片上下文，避免 SVG 内的脚本获得主页面执行环境。
 */
export const sanitizeSvgMarkup = (svg: string): string => {
  let index = 0
  let output = ''
  let rootSeen = false
  let svgDepth = 0
  let styleDepth = 0
  let blocked: { name: string; depth: number } | null = null

  while (index < svg.length) {
    const tagStart = svg.indexOf('<', index)
    if (tagStart === -1) {
      if (!blocked && rootSeen) {
        const text = svg.slice(index)
        output += styleDepth > 0 ? sanitizeCss(text) : text
      }
      break
    }
    if (tagStart > index && !blocked && rootSeen) {
      const text = svg.slice(index, tagStart)
      output += styleDepth > 0 ? sanitizeCss(text) : text
    }
    if (svg.startsWith('<!--', tagStart)) {
      const commentEnd = svg.indexOf('-->', tagStart + 4)
      index = commentEnd === -1 ? svg.length : commentEnd + 3
      continue
    }
    if (svg.startsWith('<![CDATA[', tagStart)) {
      const cdataEnd = svg.indexOf(']]>', tagStart + 9)
      if (!blocked && rootSeen && styleDepth > 0) {
        output += sanitizeCss(svg.slice(tagStart + 9, cdataEnd === -1 ? svg.length : cdataEnd))
      }
      index = cdataEnd === -1 ? svg.length : cdataEnd + 3
      continue
    }
    if (svg.startsWith('<!', tagStart) || svg.startsWith('<?', tagStart)) {
      const declarationEnd = svg.indexOf('>', tagStart + 2)
      index = declarationEnd === -1 ? svg.length : declarationEnd + 1
      continue
    }
    const tagEnd = findTagEnd(svg, tagStart)
    if (tagEnd === -1) {
      break
    }
    const tag = svg.slice(tagStart, tagEnd + 1)
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9_.:-]*)/.exec(tag)
    if (!match) {
      if (!blocked && rootSeen) {
        output += '&lt;'
      }
      index = tagStart + 1
      continue
    }
    const closing = match[1] === '/'
    const name = match[2]
    const lower = name.toLowerCase()
    const selfClosing = /\/\s*>$/.test(tag)

    if (blocked) {
      if (closing && lower === blocked.name) {
        blocked.depth--
        if (blocked.depth === 0) {
          blocked = null
        }
      } else if (!closing && lower === blocked.name && !selfClosing) {
        blocked.depth++
      }
      index = tagEnd + 1
      continue
    }
    if (closing) {
      if (rootSeen) {
        if (lower === 'svg') {
          if (svgDepth > 0) {
            svgDepth--
            output += `</${name}>`
          }
          index = tagEnd + 1
          if (svgDepth === 0) {
            break
          }
          continue
        }
        if (lower === 'style' && styleDepth > 0) {
          styleDepth--
        }
        output += `</${name}>`
      }
      index = tagEnd + 1
      continue
    }
    if (BLOCKED_ELEMENTS.has(lower)) {
      if (!selfClosing) {
        blocked = { name: lower, depth: 1 }
      }
      index = tagEnd + 1
      continue
    }
    if (!rootSeen && lower !== 'svg') {
      index = tagEnd + 1
      continue
    }
    const nameEnd = tagStart + match[0].length
    let attributeEnd = tagEnd
    if (selfClosing) {
      attributeEnd = tagEnd - 1
      while (attributeEnd > nameEnd && /\s/.test(svg[attributeEnd])) {
        attributeEnd--
      }
      if (svg[attributeEnd] === '/') {
        attributeEnd--
      }
    }
    const attributes = parseAttributes(svg, nameEnd, attributeEnd)
      .map(sanitizeAttribute)
      .filter((attribute): attribute is string => attribute !== null)
    output += `<${name}${attributes.length ? ` ${attributes.join(' ')}` : ''}${
      selfClosing ? ' /' : ''
    }>`
    if (lower === 'svg') {
      rootSeen = true
      if (!selfClosing) {
        svgDepth++
      }
    }
    if (lower === 'style' && !selfClosing) {
      styleDepth++
    }
    index = tagEnd + 1
    if (selfClosing && lower === 'svg' && svgDepth === 0) {
      break
    }
  }

  if (!rootSeen || !output) {
    return ''
  }
  const rootMatch = /<svg\b/i.exec(output)
  if (!rootMatch || rootMatch.index === undefined) {
    return ''
  }
  const rootStart = rootMatch.index
  const rootEnd = findTagEnd(output, rootStart)
  if (rootEnd === -1) {
    return ''
  }
  const rootTag = output.slice(rootStart, rootEnd + 1)
  if (/\bxmlns\s*=/.test(rootTag)) {
    return output
  }
  return `${output.slice(0, rootStart + rootMatch[0].length)} xmlns="http://www.w3.org/2000/svg"${output.slice(rootStart + rootMatch[0].length)}`
}

const parseSvgLength = (value: string | null): number | null => {
  if (!value) {
    return null
  }
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)(?:px)?\s*$/i.exec(value)
  if (!match) {
    return null
  }
  const number = Number(match[1])
  return Number.isFinite(number) && number > 0 ? number : null
}

const parseViewBox = (value: string | null) => {
  if (!value) {
    return null
  }
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null
  }
  const width = Math.abs(parts[2])
  const height = Math.abs(parts[3])
  return width > 0 && height > 0 ? { width, height } : null
}

const readRootSvg = (markup: string) => {
  const match = /<svg\b/i.exec(markup)
  if (!match || match.index === undefined) {
    return null
  }
  const start = match.index
  const end = findTagEnd(markup, start)
  if (end === -1) {
    return null
  }
  const attributes = parseAttributes(markup, start + match[0].length, end)
  const byName = new Map(attributes.map((attribute) => [attribute.name.toLowerCase(), attribute.value]))
  return {
    width: parseSvgLength(byName.get('width') ?? null),
    height: parseSvgLength(byName.get('height') ?? null),
    viewBox: parseViewBox(byName.get('viewbox') ?? null),
  }
}

const setSvgLength = (tag: string, name: 'width' | 'height', value: number): string => {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i')
  if (pattern.test(tag)) {
    return tag.replace(pattern, ` ${name}="${value}"`)
  }
  return tag.replace(/\s*\/?>$/, (closing) => ` ${name}="${value}"${closing}`)
}

const setSvgPixelSize = (markup: string, width: number, height: number): string => {
  const match = /<svg\b/i.exec(markup)
  if (!match || match.index === undefined) {
    return markup
  }
  const start = match.index
  const end = findTagEnd(markup, start)
  if (end === -1) {
    return markup
  }
  const tag = setSvgLength(setSvgLength(markup.slice(start, end + 1), 'width', width), 'height', height)
  return `${markup.slice(0, start)}${tag}${markup.slice(end + 1)}`
}

export type SvgRasterOptions = {
  scale?: number
  maxDimension?: number
  maxPixels?: number
  background?: string
}

export type SvgRasterPlan = {
  width: number
  height: number
  scale: number
  pixelWidth: number
  pixelHeight: number
  background: string
  markup: string
}

/** 计算安全的高清画布尺寸，并把栅格化用的 SVG 改成明确像素尺寸。 */
export const planSvgRaster = (
  svg: string,
  { scale = 2, maxDimension = 4096, maxPixels = 16_000_000 }: SvgRasterOptions = {}
): SvgRasterPlan => {
  const markup = sanitizeSvgMarkup(svg)
  if (!markup) {
    throw new Error('SVG content is empty')
  }
  const root = readRootSvg(markup)
  if (!root) {
    throw new Error('SVG root is missing')
  }
  let width = root.width
  let height = root.height
  if (root.viewBox) {
    if (width === null) {
      width = root.viewBox.width
    }
    if (height === null) {
      height = root.viewBox.height
    }
  }
  if (width === null && height === null) {
    width = 1200
    height = 800
  } else if (width === null && height !== null) {
    width = root.viewBox ? (height * root.viewBox.width) / root.viewBox.height : height * (4 / 3)
  } else if (height === null && width !== null) {
    height = root.viewBox ? (width * root.viewBox.height) / root.viewBox.width : width * (3 / 4)
  }
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('SVG size is invalid')
  }
  const requestedScale = Math.min(4, Math.max(0.5, scale))
  const safeScale = Math.min(
    requestedScale,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / (width * height))
  )
  const pixelWidth = Math.max(1, Math.round(width * safeScale))
  const pixelHeight = Math.max(1, Math.round(height * safeScale))
  return {
    width,
    height,
    scale: safeScale,
    pixelWidth,
    pixelHeight,
    background: '#ffffff',
    markup: setSvgPixelSize(markup, Math.round(width), Math.round(height)),
  }
}

/** 用浏览器自带的 SVG 解码和 Canvas 输出 PNG，不引入额外运行时。 */
export const svgToPngBlob = async (svg: string, options: SvgRasterOptions = {}): Promise<Blob> => {
  const plan = planSvgRaster(svg, options)
  const background = options.background ?? plan.background
  const url = URL.createObjectURL(new Blob([plan.markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    image.decoding = 'async'
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Could not rasterize SVG'))
    })
    image.src = url
    await loaded
    const canvas = document.createElement('canvas')
    canvas.width = plan.pixelWidth
    canvas.height = plan.pixelHeight
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas is unavailable')
    }
    if (background !== 'transparent') {
      context.fillStyle = background
      context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob)
        } else {
          reject(new Error('Could not encode PNG'))
        }
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const svgToDataUrl = (markup: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
