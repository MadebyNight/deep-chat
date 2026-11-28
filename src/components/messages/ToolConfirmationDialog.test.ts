import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

test('maps confirmation buttons and every modal close path to their decisions', () => {
  const dialog = source('./ToolConfirmationDialog.tsx')
  const modal = source('../base/Modal.tsx')
  const lifecycle = source('../../app/nativeLifecycle.ts')

  assert.match(dialog, /onClose=\{\(\) => answer\('cancel'\)\}/u)
  assert.match(dialog, /onClick=\{\(\) => answer\('deny'\)\}/u)
  assert.match(dialog, /onClick=\{\(\) => answer\('allow'\)\}/u)
  assert.match(modal, /event\.key === 'Escape'[\s\S]*?onCloseRef\.current\(\)/u)
  assert.match(
    modal,
    /onMouseDown=\{\(event\) => event\.target === event\.currentTarget && onClose\(\)\}/u
  )
  assert.match(
    lifecycle,
    /addListener\('backButton'[\s\S]*?new KeyboardEvent\('keydown', \{ key: 'Escape'/u
  )
})

test('cancelling a confirmation aborts the turn without emitting a denial result', () => {
  const store = source('../../services/chat/store.ts')
  const cancelStart = store.indexOf("if (decision === 'cancel')")
  const denyStart = store.indexOf("if (decision === 'deny')")
  const executeStart = store.indexOf('const result = await executeMcpTool', denyStart)

  assert.ok(cancelStart >= 0)
  assert.ok(denyStart > cancelStart)
  assert.ok(executeStart > denyStart)

  const cancel = store.slice(cancelStart, denyStart)
  const deny = store.slice(denyStart, executeStart)
  assert.match(cancel, /status: 'complete'/u)
  assert.match(cancel, /controller\.abort\(\)/u)
  assert.match(cancel, /throw new DOMException\('Cancelled', 'AbortError'\)/u)
  assert.doesNotMatch(cancel, /User denied execution/u)
  assert.match(deny, /User denied execution/u)
})
