import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PromptPreset } from '../settings.js'
import {
  assembleSystemPrompt,
  buildSessionSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  MEMORY_SECTION_HEADER,
  PERSONA_SECTION_HEADER,
  resolveSessionPersona,
} from './systemPrompt.js'
import type { Session } from './types.js'

const preset: PromptPreset = {
  id: 'writer',
  title: 'Writing partner',
  body: 'Write with evidence and preserve the author’s intent.',
}
const prompts = { presets: [preset], selectedId: preset.id }
const session = (
  systemPromptId: Session['systemPromptId'],
  systemPromptSnapshot?: string
): Pick<Session, 'systemPromptId' | 'systemPromptSnapshot'> => ({
  systemPromptId,
  ...(systemPromptSnapshot === undefined ? {} : { systemPromptSnapshot }),
})

test('keeps the current plain persona output when no memory is present', () => {
  assert.equal(assembleSystemPrompt({ persona: '  Persona\r\ntext  ' }), 'Persona\ntext')
  assert.equal(assembleSystemPrompt({}), DEFAULT_SYSTEM_PROMPT)
  assert.equal(assembleSystemPrompt({ persona: '', memory: '   ' }), DEFAULT_SYSTEM_PROMPT)
})

test('places long-term memory after the persona with stable section headers', () => {
  const result = assembleSystemPrompt({ persona: '  Persona  ', memory: '  Fact one\nFact two  ' })
  assert.equal(
    result,
    `${PERSONA_SECTION_HEADER}\nPersona\n\n${MEMORY_SECTION_HEADER}\nFact one\nFact two`
  )
  assert.ok(result.indexOf(PERSONA_SECTION_HEADER) < result.indexOf(MEMORY_SECTION_HEADER))
})

test('resolves legacy, explicit default, live preset and deleted snapshot bindings', () => {
  assert.equal(resolveSessionPersona(undefined, prompts), preset.body)
  assert.equal(resolveSessionPersona(session(undefined), prompts), preset.body)
  assert.equal(resolveSessionPersona(session(null), prompts), DEFAULT_SYSTEM_PROMPT)
  assert.equal(
    resolveSessionPersona(session(preset.id, 'Stale snapshot'), prompts),
    preset.body
  )
  assert.equal(
    resolveSessionPersona(session('removed', 'Snapshot after deletion'), {
      presets: [],
      selectedId: null,
    }),
    'Snapshot after deletion'
  )
  assert.equal(
    resolveSessionPersona(session('removed'), { presets: [], selectedId: null }),
    DEFAULT_SYSTEM_PROMPT
  )
})

test('builds the session prompt through one entry point with an ordered memory slot', () => {
  assert.equal(buildSessionSystemPrompt(session(preset.id), prompts), preset.body)
  assert.equal(
    buildSessionSystemPrompt(session('removed', 'Snapshot after deletion'), {
      presets: [],
      selectedId: null,
    }, { memory: '  Remember the earlier decision.  ' }),
    `${PERSONA_SECTION_HEADER}\nSnapshot after deletion\n\n${MEMORY_SECTION_HEADER}\nRemember the earlier decision.`
  )
  assert.equal(
    buildSessionSystemPrompt(session(undefined), { presets: [], selectedId: null }, {
      memory: 'Memory only',
    }),
    `${PERSONA_SECTION_HEADER}\n${DEFAULT_SYSTEM_PROMPT}\n\n${MEMORY_SECTION_HEADER}\nMemory only`
  )
})
