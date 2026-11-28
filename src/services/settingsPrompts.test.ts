import assert from 'node:assert/strict'
import { test } from 'node:test'

const PROMPTS_KEY = 'deepchat:prompt-presets-v1'

test('keeps existing presets when adding and selecting a built-in template', async (t) => {
  const existing = {
    id: 'existing',
    title: 'Existing prompt',
    body: 'Keep this prompt.',
    createdAt: 1,
  }
  const storage = new Map([
    [PROMPTS_KEY, JSON.stringify({ presets: [existing], selectedId: existing.id })],
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  t.after(() => Reflect.deleteProperty(globalThis, 'localStorage'))

  const { addPromptPreset, useSettings } = await import('./settings.js')
  const { BUILTIN_PROMPT_TEMPLATES, readBuiltinPrompt } = await import('./promptLibrary.js')
  const template = readBuiltinPrompt(BUILTIN_PROMPT_TEMPLATES[0], 'zh-CN', 2)
  assert.deepEqual(useSettings.getState().prompts, {
    presets: [existing],
    selectedId: existing.id,
  })

  assert.equal(addPromptPreset(template, true), true)

  const expected = {
    presets: [existing, template],
    selectedId: template.id,
  }
  assert.deepEqual(useSettings.getState().prompts, expected)
  assert.deepEqual(JSON.parse(storage.get(PROMPTS_KEY) ?? ''), expected)
})
