import assert from 'node:assert/strict'
import * as nodeModule from 'node:module'
import { test } from 'node:test'

type RegisterHooks = (hooks: {
  load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown): unknown
}) => void

const registerHooks = (nodeModule as typeof nodeModule & { registerHooks?: RegisterHooks })
  .registerHooks

if (!registerHooks) {
  throw new Error('Node.js 22.15 或更高版本才能运行侧栏组件回归')
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      return {
        format: 'module',
        source: 'export default new Proxy({}, { get: (_, key) => String(key) })',
        shortCircuit: true,
      }
    }
    if (url.endsWith('/src/app/viewport.ts')) {
      return {
        format: 'module',
        source: [
          "import { useRef } from 'react'",
          'export const useIsMobile = () => true',
          'export const useMobileViewport = () => useRef(null)',
          'export const usePreventPageScroll = () => {}',
        ].join('\n'),
        shortCircuit: true,
      }
    }
    if (url.endsWith('/src/components/base/Tooltip.tsx')) {
      return {
        format: 'module',
        source: 'export const Tooltip = ({ children }) => children',
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

Object.defineProperty(globalThis, '__API_ORIGIN__', {
  configurable: true,
  value: 'https://api.test',
})
Object.defineProperty(globalThis, '__APP_LICENSE__', {
  configurable: true,
  value: '',
})
Object.defineProperty(globalThis, '__OPEN_SOURCE_NOTICES__', {
  configurable: true,
  value: [],
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    innerHeight: 640,
    innerWidth: 320,
    addEventListener() {},
    removeEventListener() {},
  },
})

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { useChatStore } = await import('../../services/chat/store.js')
const { Sider } = await import('./Sider.js')
const styles = (await import('./Sider.module.css')).default

test('移动端分组筛选把管理操作放在横向滚动区之外', () => {
  useChatStore.setState({
    folders: [
      {
        id: 'review',
        name: 'Review Group',
        createdAt: 1,
        order: 1,
      },
    ],
  })

  const markup = renderToStaticMarkup(createElement(Sider, { mobile: true }))
  const controls = markup.indexOf(`<div class="${styles.folderControls}">`)
  const scroller = markup.indexOf(`<div class="${styles.folderBar}" role="group"`, controls)
  const scrollerEnd = markup.indexOf('</div>', scroller)
  const manage = markup.indexOf(styles.manageFolders, scrollerEnd)
  const list = markup.indexOf(`<div class="${styles.listWrap}`, scrollerEnd)

  assert.ok(controls >= 0)
  assert.ok(scroller > controls)
  assert.ok(scrollerEnd > scroller)
  assert.match(markup.slice(scroller, scrollerEnd), /Review Group/)
  assert.doesNotMatch(markup.slice(scroller, scrollerEnd), /manageFolders/)
  assert.ok(manage > scrollerEnd)
  assert.ok(list > manage)
  assert.match(markup.slice(manage - 100, manage + 200), /aria-label="管理分组"/)
})
