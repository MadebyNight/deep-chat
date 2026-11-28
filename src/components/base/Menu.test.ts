import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

const zIndex = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const rule = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'u').exec(css)
  assert.ok(rule, `${selector} rule must exist`)
  const value = /z-index:\s*(\d+)/u.exec(rule[1])?.[1]
  assert.ok(value, `${selector} must declare z-index`)
  return Number(value)
}

test('菜单浮层始终位于 Modal 遮罩之上', () => {
  const menu = zIndex(source('./Menu.module.css'), '.menu')
  const modalOverlay = zIndex(source('./Modal.module.css'), '.overlay')

  assert.equal(menu, 1050)
  assert.ok(menu > modalOverlay, `menu z-index ${menu} must exceed overlay ${modalOverlay}`)
})
