import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  anthropicGenerationFields,
  applyGenerationPreset,
  createAnthropicRequest,
  customGenerationFields,
  DEFAULT_GENERATION_PARAMS,
  generationPresetFor,
  normalizeGenerationParams,
  parseGenerationParams,
} from './generation.js'

test('presets materialize complete, valid generation parameters', () => {
  const precise = applyGenerationPreset(
    { ...DEFAULT_GENERATION_PARAMS, model: 'deepseek-v4-pro' },
    'precise'
  )
  assert.deepEqual(precise, {
    model: 'deepseek-v4-pro',
    maxTokens: 65_536,
    temperature: 0.2,
    topP: 0.8,
    preset: 'precise',
  })
  assert.equal(generationPresetFor(precise), 'precise')
  assert.equal(generationPresetFor({ ...precise, temperature: 0.3 }), null)
})

test('stored generation parameters reject invalid values and keep a safe fallback', () => {
  assert.deepEqual(
    parseGenerationParams({ ...DEFAULT_GENERATION_PARAMS }),
    DEFAULT_GENERATION_PARAMS
  )
  assert.deepEqual(
    normalizeGenerationParams({
      ...DEFAULT_GENERATION_PARAMS,
      preset: null,
      temperature: 0.4,
    }),
    { ...DEFAULT_GENERATION_PARAMS, preset: null, temperature: 0.4 }
  )
  assert.deepEqual(
    parseGenerationParams({
      ...DEFAULT_GENERATION_PARAMS,
      maxTokens: 393_216,
      temperature: 2,
      topP: 0.5,
    }),
    {
      ...DEFAULT_GENERATION_PARAMS,
      maxTokens: 393_216,
      temperature: 2,
      topP: 0.5,
      preset: null,
    }
  )
  for (const invalid of [
    { ...DEFAULT_GENERATION_PARAMS, model: 'unknown' },
    { ...DEFAULT_GENERATION_PARAMS, maxTokens: 0 },
    { ...DEFAULT_GENERATION_PARAMS, maxTokens: 393_217 },
    { ...DEFAULT_GENERATION_PARAMS, temperature: 2.1 },
    { ...DEFAULT_GENERATION_PARAMS, topP: 1.1 },
    { ...DEFAULT_GENERATION_PARAMS, topP: -0.1 },
  ]) {
    assert.equal(parseGenerationParams(invalid), undefined)
    assert.equal(normalizeGenerationParams(invalid), DEFAULT_GENERATION_PARAMS)
  }
})

test('official account requests omit sampling fields but keep model and output limit', () => {
  const fields = anthropicGenerationFields(DEFAULT_GENERATION_PARAMS, {
    officialAccount: true,
    thinking: false,
  })
  assert.deepEqual(fields, {
    model: 'deepseek-flash',
    max_tokens: 65_536,
  })
  assert.equal('temperature' in fields, false)
  assert.equal('top_p' in fields, false)
})

test('official API thinking mode omits sampling fields without changing thinking', () => {
  const params = { ...DEFAULT_GENERATION_PARAMS, temperature: 0.35, topP: 0.75 }
  assert.deepEqual(anthropicGenerationFields(params, { officialAccount: false, thinking: true }), {
    model: 'deepseek-flash',
    max_tokens: 65_536,
  })
  assert.deepEqual(anthropicGenerationFields(params, { officialAccount: false, thinking: false }), {
    model: 'deepseek-flash',
    max_tokens: 65_536,
    temperature: 0.35,
    top_p: 0.75,
  })
})

test('Anthropic request builder preserves caller fields and applies safe generation fields', () => {
  const request = createAnthropicRequest(
    {
      system: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled' },
      tools: [],
      safety_check: { level: 'high' },
    },
    { ...DEFAULT_GENERATION_PARAMS, model: 'deepseek-v4-pro' },
    { officialAccount: true, thinking: true }
  )
  assert.deepEqual(request, {
    system: 'system',
    messages: [{ role: 'user', content: 'hello' }],
    thinking: { type: 'enabled' },
    tools: [],
    safety_check: { level: 'high' },
    model: 'deepseek-v4-pro',
    max_tokens: 65_536,
  })
})

test('custom providers receive complete sampling parameters', () => {
  assert.deepEqual(
    customGenerationFields({
      maxTokens: 12_345,
      temperature: 0.25,
      topP: 0.65,
    }),
    {
      max_tokens: 12_345,
      temperature: 0.25,
      top_p: 0.65,
    }
  )
})
