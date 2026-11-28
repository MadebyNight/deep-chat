import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

const rule = (css: string, selector: string) => {
  const start = css.lastIndexOf(`${selector} {`)
  assert.ok(start >= 0, `${selector} rule must exist`)
  let depth = 0
  for (let index = start + selector.length; index < css.length; index += 1) {
    if (css[index] === '{') {
      depth += 1
    } else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) {
        return css.slice(start, index + 1)
      }
    }
  }
  assert.fail(`${selector} rule must be closed`)
}

test('发送键使用 ActionButton 按压态且禁用时不反馈', () => {
  const sendButton = rule(source('./ChatInput.module.css'), '.sendButton')
  const component = source('./ChatInput.tsx')

  assert.match(sendButton, /&\[data-pressed\]:not\(\.disabled\)\s*\{/u)
  assert.doesNotMatch(sendButton, /&:active\b/u)
  assert.match(component, /aria-disabled=\{!canSend\}/u)
  assert.match(component, /!canSend && styles\.disabled/u)
})

test('会话输入框外仅保留对称的人设和参数入口', () => {
  const sessionInputSource = source('../session/SessionView.tsx')
  const chatInputSource = source('./ChatInput.tsx')

  assert.match(sessionInputSource, /<ChatInput sessionId=\{session\.id\} showPrompt \/>/u)
  assert.doesNotMatch(sessionInputSource, /<PromptPicker\b/u)
  assert.match(
    chatInputSource,
    /<PromptPicker sessionId=\{sessionId \?\? undefined\} \/>/u,
  )
  assert.doesNotMatch(chatInputSource, /showPrompt && !custom/u)
})
