import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Code } from 'mdast'
import { toMdAst } from './parse.js'
import {
  ARTIFACT_MAX_HEIGHT,
  buildArtifactPreviewDocument,
  hasOpenCodeFence,
  isPreviewableArtifact,
  isTrustedArtifactMessage,
  parseArtifactMessage,
  planSvgRaster,
  sanitizeSvgMarkup,
  svgToDataUrl,
  svgToPngBlob,
} from './artifactUtils.js'

test('detects supported artifact languages and rejects empty or mismatched blocks', () => {
  assert.equal(isPreviewableArtifact('html', '<div>ok</div>'), 'html')
  assert.equal(isPreviewableArtifact('HTM', '<p>ok</p>'), 'html')
  assert.equal(isPreviewableArtifact('svg', '<svg viewBox="0 0 1 1" />'), 'svg')
  assert.equal(isPreviewableArtifact('image/svg+xml', '<svg />'), 'svg')
  assert.equal(isPreviewableArtifact('mermaid', 'flowchart LR\nA-->B'), 'mermaid')
  assert.equal(isPreviewableArtifact('html', '   '), null)
  assert.equal(isPreviewableArtifact('svg', '<div />'), null)
  assert.equal(isPreviewableArtifact('typescript', 'const a = 1'), null)
})

test('detects an unclosed streaming code fence', () => {
  assert.equal(hasOpenCodeFence('```html\n<div>'), true)
  assert.equal(hasOpenCodeFence('```html\n<div>\n```'), false)
  assert.equal(hasOpenCodeFence('````html\n```\n````'), false)
  assert.equal(hasOpenCodeFence('~~~svg\n<svg>'), true)
  assert.equal(hasOpenCodeFence('~~~svg\n<svg>\n~~~'), false)
  assert.equal(hasOpenCodeFence('> ```html\n> <div>'), true)
  assert.equal(hasOpenCodeFence('普通文本'), false)
})

test('marks only the last open code fence as streaming', () => {
  const closed = toMdAst('```html\n<div>done</div>\n```', {
    sources: undefined,
    disableLink: false,
  })
  assert.equal((closed.children[0] as Code).streaming, undefined)
  const open = toMdAst('```html\n<div>done</div>\n```\n\n```svg\n<svg>', {
    sources: undefined,
    disableLink: false,
  })
  assert.equal((open.children[0] as Code).streaming, undefined)
  assert.equal((open.children[1] as Code).streaming, true)
})

test('injects CSP and the height protocol before user scripts', () => {
  const document = buildArtifactPreviewDocument(
    '<html><head><script src="https://example.test/app.js"></script></head><body><div>ok</div></body></html>'
  )
  assert.match(document, /default-src 'none'/)
  assert.match(document, /script-src 'unsafe-inline'/)
  assert.match(document, /connect-src 'none'/)
  assert.match(document, /deepchat-artifact-height/)
  assert.ok(
    document.indexOf('Content-Security-Policy') <
      document.indexOf('<script src="https://example.test/app.js"')
  )
  assert.equal((document.match(/Content-Security-Policy/g) ?? []).length, 1)
  assert.doesNotMatch(document, /allow-same-origin/)
})

test('prefixes CSP without relying on head tags found in user text', () => {
  const fragment = buildArtifactPreviewDocument('<div>hello</div>')
  assert.match(fragment, /^<!doctype html><meta http-equiv="Content-Security-Policy"/)
  assert.ok(fragment.endsWith('<div>hello</div>'))
  const withMetaRefresh = buildArtifactPreviewDocument(
    '<html><head><meta http-equiv="refresh" content="0;url=https://example.test"></head><body><p>hello</p></body></html>'
  )
  assert.doesNotMatch(withMetaRefresh, /http-equiv="refresh"/i)
  const withoutHead = buildArtifactPreviewDocument('<html><body><p>hello</p></body></html>')
  assert.ok(
    withoutHead.indexOf('Content-Security-Policy') <
      withoutHead.indexOf('<html>')
  )
  const commentedHead = buildArtifactPreviewDocument(
    '<!-- <head> --><html><head><style>body{color:red}</style></head><body><p>hello</p></body></html>'
  )
  assert.ok(
    commentedHead.indexOf('Content-Security-Policy') <
      commentedHead.indexOf('<!-- <head> -->')
  )
})

test('validates height messages and rejects out-of-bound values', () => {
  assert.deepEqual(parseArtifactMessage({ type: 'deepchat-artifact-height', height: 320 }), {
    type: 'deepchat-artifact-height',
    height: 320,
  })
  assert.deepEqual(
    parseArtifactMessage({ type: 'deepchat-artifact-height', height: ARTIFACT_MAX_HEIGHT }),
    { type: 'deepchat-artifact-height', height: ARTIFACT_MAX_HEIGHT }
  )
  assert.deepEqual(parseArtifactMessage({ type: 'deepchat-artifact-error' }), {
    type: 'deepchat-artifact-error',
  })
  for (const data of [
    null,
    'height',
    [],
    { type: 'other', height: 10 },
    { type: 'deepchat-artifact-height' },
    { type: 'deepchat-artifact-height', height: -1 },
    { type: 'deepchat-artifact-height', height: 1.5 },
    { type: 'deepchat-artifact-height', height: Number.NaN },
    { type: 'deepchat-artifact-height', height: Number.POSITIVE_INFINITY },
    { type: 'deepchat-artifact-height', height: ARTIFACT_MAX_HEIGHT + 1 },
  ]) {
    assert.equal(parseArtifactMessage(data), null)
  }
})

test('accepts messages only from the current iframe window', () => {
  const frame = {}
  assert.deepEqual(
    isTrustedArtifactMessage(
      { source: frame, data: { type: 'deepchat-artifact-height', height: 200 } },
      frame
    ),
    { type: 'deepchat-artifact-height', height: 200 }
  )
  assert.equal(
    isTrustedArtifactMessage(
      { source: {}, data: { type: 'deepchat-artifact-height', height: 200 } },
      frame
    ),
    null
  )
  assert.equal(
    isTrustedArtifactMessage(
      { source: frame, data: { type: 'deepchat-artifact-height', height: 200 } },
      null
    ),
    null
  )
})

test('sanitizes scripts, foreignObject, events and external references from SVG', () => {
  const sanitized = sanitizeSvgMarkup(`
    <div>outside</div>
    <svg viewBox="0 0 20 20" onload="alert(1)">
      <defs><linearGradient id="g"><stop offset="0" /></linearGradient></defs>
      <script>alert(1)</script>
      <foreignObject><div onclick="alert(2)">html</div></foreignObject>
      <a href="javascript:alert(3)" xlink:href="//example.test">
        <path d="M0 0L10 10" fill="url(#g)" stroke="url(https://example.test/x)" />
      </a>
      <image href="https://example.test/a.png" />
      <style>@import url(https://example.test/x.css); .ok { fill: url(#g); }</style>
    </svg>
    <script>alert(4)</script>
  `)
  assert.match(sanitized, /^<svg\b/)
  assert.match(sanitized, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(sanitized, /fill="url\(#g\)"/)
  assert.match(sanitized, /\.ok \{ fill: url\(#g\); \}/)
  assert.doesNotMatch(sanitized, /script|foreignObject|onload|onclick|javascript:|example\.test|@import|outside/i)
})

test('keeps safe data image references and removes content outside the root SVG', () => {
  const sanitized = sanitizeSvgMarkup(
    'leading<script>bad()</script><svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA" /></svg><div>trailing</div>'
  )
  assert.equal(
    sanitized,
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA" /></svg>'
  )
})

test('plans a safe PNG size from the SVG viewBox and writes pixel dimensions', () => {
  const plan = planSvgRaster(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" /></svg>'
  )
  assert.equal(plan.width, 100)
  assert.equal(plan.height, 50)
  assert.equal(plan.pixelWidth, 200)
  assert.equal(plan.pixelHeight, 100)
  assert.match(plan.markup, /<svg[^>]*width="100"[^>]*height="50"/)

  const large = planSvgRaster(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10000"><path d="M0 0" /></svg>',
    { maxDimension: 4096, maxPixels: 16_000_000 }
  )
  assert.ok(large.pixelWidth <= 4096)
  assert.ok(large.pixelHeight <= 4096)
  assert.ok(large.pixelWidth * large.pixelHeight <= 16_000_000)

  assert.throws(() => planSvgRaster(''), /empty/i)
})

test('builds an inline data URL for sanitized SVG', () => {
  const url = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><path /></svg>')
  assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/)
  assert.doesNotMatch(url, /</)
})

test('SVG PNG export rejects an empty source before touching canvas', async () => {
  await assert.rejects(() => svgToPngBlob(''), /empty/i)
})
