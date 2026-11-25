import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PromptPreset } from './settings.js'
import {
  MAX_IMPORTED_PROMPTS,
  MAX_PROMPT_BODY_LENGTH,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_TITLE_LENGTH,
  PROMPT_PACK_FORMAT,
  PROMPT_PACK_VERSION,
  PromptImportError,
  parsePromptImport,
  readPromptPreferences,
  readStoredPromptPreset,
  serializePromptLibrary,
} from './promptLibrary.js'

const preset: PromptPreset = {
  id: 'local-id',
  title: 'Writing partner',
  body: 'Preserve intent and avoid invented facts.',
  category: 'writing',
  starterPrompt: 'Review this paragraph:',
  createdAt: 42,
}

const expectCode = (code: string) => (error: unknown) =>
  error instanceof PromptImportError && error.code === code

test('round-trips the DeepChat JSON prompt pack without trusting exported IDs', () => {
  const result = parsePromptImport(serializePromptLibrary([preset]), 100)
  assert.equal(result.source, 'deepchat')
  assert.equal(result.truncated, false)
  assert.equal(result.presets.length, 1)
  assert.notEqual(result.presets[0].id, preset.id)
  assert.deepEqual(
    {
      title: result.presets[0].title,
      body: result.presets[0].body,
      category: result.presets[0].category,
      starterPrompt: result.presets[0].starterPrompt,
      createdAt: result.presets[0].createdAt,
    },
    {
      title: preset.title,
      body: preset.body,
      category: preset.category,
      starterPrompt: preset.starterPrompt,
      createdAt: preset.createdAt,
    }
  )
})

test('imports only whitelisted plain-text fields from V2 character cards', () => {
  const result = parsePromptImport(
    JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Mira',
        description: 'A cartographer who trusts evidence.',
        personality: 'Careful and direct.',
        scenario: 'A ruined observatory.',
        system_prompt: 'Stay in character.',
        mes_example: 'Mira: Show me the map.',
        first_mes: 'The stars moved again.',
        post_history_instructions: 'Keep continuity.',
        character_book: { entries: [{ content: 'script payload' }] },
        extensions: { talkativeness: '0.7', script: 'do-not-import' },
      },
    }),
    123
  )
  assert.equal(result.source, 'character-card')
  assert.equal(result.presets.length, 1)
  assert.equal(result.presets[0].title, 'Mira')
  assert.equal(result.presets[0].category, 'roleplay')
  assert.equal(result.presets[0].createdAt, 123)
  assert.match(result.presets[0].body, /A cartographer/)
  assert.match(result.presets[0].body, /Stay in character/)
  assert.doesNotMatch(result.presets[0].body, /script payload|do-not-import/)
})

test('imports V3 character cards and rejects non-text whitelisted fields', () => {
  const result = parsePromptImport(
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Ivo',
        description: 'A careful archivist.',
        system_prompt: 'Cite the record number.',
        character_book: { entries: [{ content: 'ignored world book' }] },
      },
    }),
    456
  )
  assert.equal(result.presets[0].title, 'Ivo')
  assert.equal(result.presets[0].category, 'roleplay')
  assert.equal(result.presets[0].createdAt, 456)
  assert.match(result.presets[0].body, /A careful archivist/)
  assert.doesNotMatch(result.presets[0].body, /ignored world book/)

  assert.throws(
    () =>
      parsePromptImport(
        JSON.stringify({
          spec: 'chara_card_v2',
          data: { name: 'Ivo', description: { script: 'not text' } },
        })
      ),
    expectCode('promptImportInvalid')
  )
})

test('rejects malformed, unsupported, empty and oversized imports', () => {
  assert.throws(() => parsePromptImport('{'), expectCode('promptImportInvalid'))
  assert.throws(
    () => parsePromptImport(JSON.stringify({ hello: 'world' })),
    expectCode('promptImportUnsupported')
  )
  assert.throws(
    () =>
      parsePromptImport(
        JSON.stringify({ format: PROMPT_PACK_FORMAT, version: 2, presets: [] })
      ),
    expectCode('promptImportUnsupported')
  )
  assert.throws(
    () =>
      parsePromptImport(
        JSON.stringify({ format: PROMPT_PACK_FORMAT, version: PROMPT_PACK_VERSION, presets: [] })
      ),
    expectCode('promptImportEmpty')
  )
  assert.throws(
    () =>
      parsePromptImport(
        JSON.stringify({
          format: PROMPT_PACK_FORMAT,
          version: PROMPT_PACK_VERSION,
          presets: [{ title: 'Invalid', body: 42 }],
        })
      ),
    expectCode('promptImportInvalid')
  )
  assert.throws(
    () => parsePromptImport('x'.repeat(MAX_PROMPT_FILE_BYTES + 1)),
    expectCode('promptImportTooLarge')
  )
})

test('caps prompt counts and truncates oversized text fields', () => {
  const tooMany = Array.from({ length: MAX_IMPORTED_PROMPTS + 1 }, (_, index) => ({
    title: `Preset ${index}`,
    body: 'Body',
  }))
  assert.throws(
    () =>
      parsePromptImport(
        JSON.stringify({
          format: PROMPT_PACK_FORMAT,
          version: PROMPT_PACK_VERSION,
          presets: tooMany,
        })
      ),
    expectCode('promptImportTooMany')
  )

  const result = parsePromptImport(
    JSON.stringify({
      format: PROMPT_PACK_FORMAT,
      version: PROMPT_PACK_VERSION,
      presets: [
        {
          title: 'T'.repeat(MAX_PROMPT_TITLE_LENGTH + 20),
          body: 'B'.repeat(MAX_PROMPT_BODY_LENGTH + 20),
          category: 'C'.repeat(100),
        },
      ],
    })
  )
  assert.equal(result.truncated, true)
  assert.equal(result.presets[0].title.length, MAX_PROMPT_TITLE_LENGTH)
  assert.equal(result.presets[0].body.length, MAX_PROMPT_BODY_LENGTH)
  assert.equal(result.presets[0].category?.length, 40)
})

test('keeps optional prompt fields when reading local preferences', () => {
  assert.deepEqual(
    readStoredPromptPreset({
      id: 'one',
      title: '',
      body: 'Body text',
      category: 'custom',
      starterPrompt: 'Start',
      createdAt: 9,
      extras: { script: 'ignored' },
    }),
    {
      id: 'one',
      title: 'Body text',
      body: 'Body text',
      category: 'custom',
      starterPrompt: 'Start',
      createdAt: 9,
    }
  )
  assert.deepEqual(
    readPromptPreferences({
      presets: [
        { id: 'one', title: 'One', body: 'First', category: 'writing' },
        { id: 'one', title: 'Duplicate', body: 'Dropped' },
        { id: '', title: 'Invalid', body: 'Dropped' },
        { id: 'two', title: 'Two', body: 'Second', createdAt: 7 },
      ],
      selectedId: 'two',
    }),
    {
      presets: [
        { id: 'one', title: 'One', body: 'First', category: 'writing' },
        { id: 'two', title: 'Two', body: 'Second', createdAt: 7 },
      ],
      selectedId: 'two',
    }
  )
})
