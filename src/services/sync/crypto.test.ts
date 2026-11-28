import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncCipher } from './crypto.js'
import { SyncError } from './errors.js'

const isCode = (code: string) => (error: unknown) =>
  error instanceof SyncError && error.code === code

test('plain sync documents keep the same data without a passphrase', async () => {
  const cipher = SyncCipher.plain()
  const text = await cipher.seal({ hello: 'world', count: 1 })
  assert.match(text, /"encrypted":false/)
  const opened = await SyncCipher.open<{ hello: string }>(text, '')
  assert.deepEqual(opened.value, { hello: 'world', count: 1 })
  assert.equal(opened.cipher.encrypted, false)
})

test('AES-GCM documents round-trip with PBKDF2', async () => {
  const cipher = await SyncCipher.create('correct horse battery staple', {
    iterations: 10_000,
  })
  const text = await cipher.seal({
    format: 'deepchat.sync',
    nested: { value: '会话内容' },
  })
  assert.match(text, /"encrypted":true/)
  assert.match(text, /"name":"AES-GCM"/)
  assert.doesNotMatch(text, /会话内容/)
  const opened = await SyncCipher.open<{ nested: { value: string } }>(
    text,
    'correct horse battery staple'
  )
  assert.equal(opened.value.nested.value, '会话内容')
  assert.equal(opened.cipher.encrypted, true)
})

test('wrong passphrase reports a decrypt error', async () => {
  const cipher = await SyncCipher.create('right', { iterations: 10_000 })
  const text = await cipher.seal({ secret: true })
  await assert.rejects(SyncCipher.open(text, 'wrong'), isCode('decrypt'))
  await assert.rejects(SyncCipher.open(text, ''), isCode('decrypt'))
})

test('configured passphrase rejects a plaintext downgrade', async () => {
  const text = await SyncCipher.plain().seal({ secret: true })
  await assert.rejects(
    SyncCipher.open(text, 'configured passphrase'),
    isCode('decrypt')
  )
  await assert.rejects(
    SyncCipher.open(text, '', { requireEncrypted: true }),
    isCode('decrypt')
  )
})

test('first plaintext migration requires the explicit path and produces ciphertext', async () => {
  const text = await SyncCipher.plain().seal({ secret: 'legacy remote' })
  await assert.rejects(
    SyncCipher.open(text, 'configured passphrase'),
    isCode('decrypt')
  )

  const migrated = await SyncCipher.openForInitialMigration<{ secret: string }>(
    text,
    'configured passphrase'
  )
  assert.equal(migrated.cipher.encrypted, false)
  assert.deepEqual(migrated.value, { secret: 'legacy remote' })

  const encrypted = await (
    await SyncCipher.create('configured passphrase', { iterations: 10_000 })
  ).seal(migrated.value)
  const opened = await SyncCipher.open<{ secret: string }>(
    encrypted,
    'configured passphrase',
    { requireEncrypted: true }
  )
  assert.equal(opened.cipher.encrypted, true)
  assert.deepEqual(opened.value, { secret: 'legacy remote' })
})

test('tampered ciphertext fails authentication', async () => {
  const cipher = await SyncCipher.create('right', { iterations: 10_000 })
  const text = await cipher.seal({ secret: true })
  const parsed = JSON.parse(text) as { data: string }
  parsed.data = `${parsed.data.slice(0, -2)}AA`
  await assert.rejects(
    SyncCipher.open(JSON.stringify(parsed), 'right'),
    isCode('decrypt')
  )
})

test('excessive KDF work is rejected before deriving a key', async () => {
  const envelope = {
    format: 'deepchat.sync',
    version: 1,
    encrypted: true,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 100_000_000,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
    cipher: { name: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA' },
    data: 'AAAA',
  }
  await assert.rejects(
    SyncCipher.open(JSON.stringify(envelope), 'passphrase'),
    isCode('corrupt')
  )
})
