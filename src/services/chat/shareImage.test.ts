import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  planShareImage,
  SHARE_CARD_WIDTH,
  SHARE_SLICE_CSS_HEIGHT,
  ShareImageTooLargeError,
} from './shareImage.js'

test('plans a safe single image for a normal card', () => {
  const plan = planShareImage(1800)
  assert.equal(plan.width, SHARE_CARD_WIDTH)
  assert.equal(plan.pixelWidth, 1080)
  assert.equal(plan.sliceCount, 1)
  assert.ok(plan.slicePixelHeight <= 9000)
})

test('splits a long card and keeps every canvas under the pixel budget', () => {
  const plan = planShareImage(SHARE_SLICE_CSS_HEIGHT * 3 + 1)
  assert.equal(plan.sliceCount, 4)
  assert.ok(plan.pixelWidth * plan.slicePixelHeight <= 18_000_000)
  assert.ok(plan.slicePixelHeight <= 16_384)
})

test('rejects content that would generate an unreasonable number of slices', () => {
  assert.throws(() => planShareImage(SHARE_SLICE_CSS_HEIGHT * 25), ShareImageTooLargeError)
})
