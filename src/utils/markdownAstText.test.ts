import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Source } from '../services/chat/view.js'
import { parseMdAst } from '../services/markdown/parse.js'
import {
  markdownToPlainText,
  mdastToPlainText,
  tableNodeToCsv,
  tableNodeToTsv,
} from './markdownAstText.js'

test('removes Markdown syntax while preserving readable structure', () => {
  const markdown = [
    '# 标题 **加粗**',
    '',
    '段落有 ***加粗斜体***、[**粗链接**](https://example.test)、`code` 和 ~~删除~~。',
    '',
    '1. 第一项',
    '   - 嵌套项',
    '2. 第二项',
    '',
    '> 引用内容',
    '',
    '```ts',
    'const literal = "**保留**";',
    '```',
    '',
    '$$',
    '\\sum_{i=0}^{n} i^2',
    '$$',
  ].join('\n')

  assert.equal(
    markdownToPlainText(markdown),
    [
      '标题 加粗',
      '',
      '段落有 加粗斜体、粗链接、code 和 删除。',
      '',
      '1. 第一项\n   • 嵌套项\n2. 第二项',
      '',
      '引用内容',
      '',
      'const literal = "**保留**";',
      '',
      '\\sum_{i=0}^{n} i^2',
    ].join('\n')
  )
})

test('keeps text code and math untouched and removes resolved citations', () => {
  const source: Source = {
    url: 'https://example.test/source',
    title: 'Source',
    siteName: 'example.test',
    publishedAt: null,
    snippet: null,
    siteIcon: null,
    index: 1,
  }
  const ast = parseMdAst('正文[citation:1] `a_b*c`\n\n$$x_1 + **y**$$\n', {
    sources: [source],
  })
  assert.equal(mdastToPlainText(ast), '正文 a_b*c\n\nx_1 + **y**')
})

test('removes unresolved citation markers from plain text', () => {
  assert.equal(
    markdownToPlainText('正文[citation:9] `[citation:1]`\n\n$$x[citation:1]$$'),
    '正文 [citation:1]\n\nx[citation:1]'
  )
})

test('serializes tables with inline text, quotes, tabs, and line breaks', () => {
  const ast = parseMdAst(
    [
      '| **名称** | 说明 | 备注 |',
      '| --- | --- | --- |',
      '| `A` | say "hi" | tab\tvalue |',
      '| B | line<br>break |  |',
      '| C | a,b | "x" |',
    ].join('\n'),
    { sources: undefined }
  )
  const table = ast.children[0]
  assert.equal(table?.type, 'table')
  if (table?.type !== 'table') {
    assert.fail('expected a table node')
  }
  assert.equal(
    tableNodeToTsv(table),
    '名称\t说明\t备注\r\nA\tsay "hi"\t"tab\tvalue"\r\nB\t"line\nbreak"\t\r\nC\ta,b\t"x"'
  )
  assert.equal(
    tableNodeToCsv(table),
    '名称,说明,备注\r\nA,"say ""hi""",tab\tvalue\r\nB,"line\nbreak",\r\nC,"a,b","""x"""'
  )
})

test('serializes nested inline formatting inside table cells', () => {
  const ast = parseMdAst(
    [
      '| 名称 | 说明 |',
      '| --- | --- |',
      '| [**链接**](https://example.test) | `a,b` 与 ***强调*** |',
    ].join('\n'),
    { sources: undefined }
  )
  const table = ast.children[0]
  if (table?.type !== 'table') {
    assert.fail('expected a table node')
  }
  assert.equal(tableNodeToTsv(table), '名称\t说明\r\n链接\ta,b 与 强调')
  assert.equal(tableNodeToCsv(table), '名称,说明\r\n链接,"a,b 与 强调"')
})

test('pads short table rows without inventing content', () => {
  const ast = parseMdAst('| A | B |\n| --- | --- |\n| C |', { sources: undefined })
  const table = ast.children[0]
  if (table?.type !== 'table') {
    assert.fail('expected a table node')
  }
  assert.equal(tableNodeToTsv(table), 'A\tB\r\nC\t')
})
