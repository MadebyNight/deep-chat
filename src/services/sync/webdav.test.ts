import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncError } from './errors.js'
import { normalizeWebDavUrl } from './webdav.js'

const invalid = (url: string) =>
  assert.throws(
    () => normalizeWebDavUrl(url),
    (error: unknown) => error instanceof SyncError && error.code === 'invalidUrl'
  )

test('normalizes a user HTTPS collection URL with a trailing slash', () => {
  assert.equal(
    normalizeWebDavUrl(' https://dav.example.com/remote.php/dav/files/me '),
    'https://dav.example.com/remote.php/dav/files/me/'
  )
  assert.equal(
    normalizeWebDavUrl('https://192.168.1.20:5006/webdav'),
    'https://192.168.1.20:5006/webdav/'
  )
})

test('rejects insecure, credentialed and ambiguous URLs', () => {
  for (const url of [
    'http://dav.example.com/webdav',
    'https://user:pass@dav.example.com/webdav',
    'https://dav.example.com/webdav?token=1',
    'https://dav.example.com/webdav#fragment',
    'https://dav.example.com/a//b',
    'https://dav.example.com/a%2fb',
    'https://dav.example.com/a%5cb',
    'https://dav.example.com/a\\b',
    'https://dav.example.com/a/../b',
  ]) {
    invalid(url)
  }
})

test('rejects cloud metadata endpoints, including normalized IP forms', () => {
  for (const url of [
    'https://169.254.169.254/',
    'https://2852039166/',
    'https://0xA9FEA9FE/',
    'https://169.254.169.254./',
    'https://[::ffff:169.254.169.254]/',
    'https://metadata.google.internal/',
    'https://[fd00:ec2::254]/',
  ]) {
    invalid(url)
  }
})
