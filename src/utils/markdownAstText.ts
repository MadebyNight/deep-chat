import type { Nodes, Root, Table, TableRow } from 'mdast'
import type { Source } from '../services/chat/view.js'
import { parseMdAst } from '../services/markdown/parse.js'

const inlineText = (nodes: readonly Nodes[]): string => {
  let result = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'inlineCode':
      case 'inlineMath':
      case 'math':
      case 'code':
        result += node.value
        break
      case 'html':
        result += /^<br\s*\/?>$/iu.test(node.value) ? '\n' : node.value
        break
      case 'break':
        result += '\n'
        break
      case 'image':
        result += node.alt || node.url || ''
        break
      case 'imageReference':
        result += node.alt || ''
        break
      case 'link':
        result += inlineText(node.children) || node.url
        break
      case 'linkReference':
        result += inlineText(node.children)
        break
      case 'citation':
      case 'footnoteReference':
        break
      default:
        if ('value' in node && typeof node.value === 'string') {
          result += node.value
        } else if ('children' in node) {
          result += inlineText(node.children)
        }
    }
  }
  return result
}

const blockText = (node: Nodes): string => {
  switch (node.type) {
    case 'root':
      return blockTextFrom(node.children)
    case 'heading':
    case 'paragraph':
      return inlineText(node.children).trim()
    case 'blockquote':
      return blockTextFrom(node.children)
    case 'list': {
      const start = node.ordered ? node.start ?? 1 : 1
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${start + index}. ` : '• '
          const prefix = ' '.repeat(marker.length)
          const task =
            typeof item.checked === 'boolean' ? (item.checked ? '[x] ' : '[ ] ') : ''
          const body = item.children
            .map(blockText)
            .filter((part) => part.length > 0)
            .join('\n')
          const lines = body.split('\n')
          return (
            marker +
            task +
            lines.map((line, lineIndex) => (lineIndex === 0 ? line : prefix + line)).join('\n')
          )
        })
        .join('\n')
    }
    case 'code':
    case 'math':
      return node.value
    case 'table':
      return tableNodeToTsv(node)
    case 'html':
      return node.value === '<br>' || /^<br\s*\/?>$/iu.test(node.value) ? '\n' : node.value
    case 'thematicBreak':
    case 'definition':
    case 'footnoteDefinition':
      return ''
    default:
      if ('children' in node) {
        return inlineText(node.children)
      }
      return 'value' in node && typeof node.value === 'string' ? node.value : ''
  }
}

const blockTextFrom = (nodes: readonly Nodes[]): string =>
  nodes
    .map(blockText)
    .filter((part) => part.trim().length > 0)
    .join('\n\n')

export const mdastToPlainText = (root: Root): string => blockText(root)

export const markdownToPlainText = (
  markdown: string,
  { sources }: { sources?: Source[] } = {}
): string =>
  // 传入空数组也会注册引用替换，未解析的 [citation:N] 一并从纯文本移除。
  mdastToPlainText(parseMdAst(markdown, { sources: sources ?? [] }))

const tableRows = (node: Table): string[][] => {
  const rows = node.children as TableRow[]
  const values = rows.map((row) =>
    row.children.map((cell) => inlineText(cell.children).trim())
  )
  const columns = values.reduce((count, row) => Math.max(count, row.length), 0)
  return values.map((row) =>
    Array.from({ length: columns }, (_, index) => row[index] ?? '')
  )
}

const serializeTable = (node: Table, delimiter: '\t' | ',') => {
  const quote = (value: string) => {
    const needsQuote =
      value.includes(delimiter) ||
      (delimiter === ',' && value.includes('"')) ||
      value.includes('\n') ||
      value.includes('\r')
    return needsQuote ? `"${value.replaceAll('"', '""')}"` : value
  }
  return tableRows(node)
    .map((row) => row.map(quote).join(delimiter))
    .join('\r\n')
}

export const tableNodeToTsv = (node: Table): string => serializeTable(node, '\t')

export const tableNodeToCsv = (node: Table): string => serializeTable(node, ',')
