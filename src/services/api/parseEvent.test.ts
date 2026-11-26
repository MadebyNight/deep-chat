import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readMessageEvent } from './parseEvent.js'

test('accepts validated client tool starts and argument deltas', () => {
  assert.deepEqual(
    readMessageEvent({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call-1',
        name: 'external_web_search',
        input: {},
      },
    }),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call-1',
        name: 'external_web_search',
        input: {},
      },
    }
  )
  assert.equal(
    readMessageEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', name: 'external_web_search', input: {} },
    }),
    null
  )
  assert.deepEqual(
    readMessageEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' },
    }),
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' },
    }
  )
})
