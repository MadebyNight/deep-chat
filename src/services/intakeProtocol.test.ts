import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeIntakeError,
  mergeDraftText,
  parseIntake,
  SHARED_INTAKE_MAX_FILES,
  SHARED_INTAKE_MAX_FILE_BYTES,
  SHARED_INTAKE_MAX_TEXT_CHARS,
} from './intakeProtocol.js'

const file = {
  uri: 'file:///data/user/0/app.deepchat.mobile/cache/shared_intake/id/report.pdf',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 2048,
}

test('accepts bounded share and process-text intakes', () => {
  assert.deepEqual(
    parseIntake({
      id: 'intake-123',
      kind: 'share',
      text: 'https://example.test',
      files: [file],
    }),
    {
      id: 'intake-123',
      kind: 'share',
      text: 'https://example.test',
      files: [file],
    }
  )
  assert.deepEqual(
    parseIntake({
      id: 'intake-124',
      kind: 'process-text',
      text: 'selected text',
      files: [],
    }),
    { id: 'intake-124', kind: 'process-text', text: 'selected text', files: [] }
  )
  assert.deepEqual(parseIntake({ id: 'shortcut-1', kind: 'shortcut', shortcut: 'camera' }), {
    id: 'shortcut-1',
    kind: 'shortcut',
    shortcut: 'camera',
  })
  assert.deepEqual(parseIntake({ id: 'intake-125', kind: 'error', error: 'UNSUPPORTED' }), {
    id: 'intake-125',
    kind: 'error',
    error: 'UNSUPPORTED',
  })
})

test('rejects paths, counts, sizes and malformed text', () => {
  assert.equal(
    parseIntake({
      id: 'intake-1',
      kind: 'share',
      text: '',
      files: [{ ...file, uri: 'file:///data/user/0/other/private.pdf' }],
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-2',
      kind: 'share',
      text: '',
      files: [{ ...file, uri: file.uri.replace('/id/', '/../') }],
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-2a',
      kind: 'share',
      text: '',
      files: [{ ...file, uri: file.uri.replace('/id/', '/%2E%2E/') }],
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-2b',
      kind: 'share',
      text: '',
      files: [{ ...file, uri: `${file.uri}?download=1` }],
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-2c',
      kind: 'share',
      text: '',
      files: [{ ...file, uri: file.uri.replace('/cache/', '/files/') }],
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-3',
      kind: 'share',
      text: '',
      files: Array.from({ length: SHARED_INTAKE_MAX_FILES + 1 }, () => file),
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-4',
      kind: 'share',
      text: '',
      files: [{ ...file, size: SHARED_INTAKE_MAX_FILE_BYTES + 1 }],
    }),
    null
  )
  assert.equal(
    parseIntake({
      id: 'intake-5',
      kind: 'share',
      text: 'x'.repeat(SHARED_INTAKE_MAX_TEXT_CHARS + 1),
      files: [],
    }),
    null
  )
  assert.equal(
    parseIntake({ id: 'intake-6', kind: 'process-text', text: 'text', files: [file] }),
    null
  )
  assert.equal(parseIntake({ id: 'shortcut-1', kind: 'shortcut', shortcut: 'unknown' }), null)
  assert.deepEqual(parseIntake({ id: 'intake-7', kind: 'error', error: 'future-error' }), {
    id: 'intake-7',
    kind: 'error',
    error: 'READ_FAILED',
  })
})

test('merges shared text without destroying an existing draft', () => {
  assert.equal(mergeDraftText('existing', 'shared'), 'existing\nshared')
  assert.equal(mergeDraftText('existing\n', '\nshared'), 'existing\nshared')
  assert.equal(mergeDraftText('', 'shared'), 'shared')
  assert.equal(mergeDraftText('existing', '   '), 'existing')
  assert.equal(mergeDraftText('existing', '  indented'), 'existing\n  indented')
  assert.equal(mergeDraftText('', '  indented\n'), '  indented\n')
})

test('maps intake limits to user-facing errors', () => {
  assert.deepEqual(describeIntakeError('TOO_MANY_FILES'), {
    key: 'uploadMaxFiles',
    params: { count: SHARED_INTAKE_MAX_FILES },
  })
  assert.equal(describeIntakeError('UNSUPPORTED').key, 'uploadUnsupportedFormat')
  assert.equal(describeIntakeError('READ_FAILED').key, 'shareIntakeReadFailed')
})
