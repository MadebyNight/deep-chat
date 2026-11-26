import assert from 'node:assert/strict'
import { test } from 'node:test'
import { colorToHsv, hsvToHex, hsvToRgb, parseCssColor, rgbaToHex, rgbToHsv } from './color.js'

test('parses hex, rgb, rgba, hsl and hsla', () => {
  assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  assert.deepEqual(parseCssColor('#12345678'), {
    r: 18,
    g: 52,
    b: 86,
    a: 120 / 255,
  })
  assert.deepEqual(parseCssColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 })
  assert.deepEqual(parseCssColor('rgba(1,2,3,.5)'), { r: 1, g: 2, b: 3, a: 0.5 })
  assert.deepEqual(parseCssColor('hsl(0 100% 50%)'), { r: 255, g: 0, b: 0, a: 1 })
  assert.deepEqual(parseCssColor('hsla(120, 100%, 25%, 0.25)'), {
    r: 0,
    g: 128,
    b: 0,
    a: 0.25,
  })
})

test('rejects non-color and injected values', () => {
  for (const value of [
    '',
    'red',
    'transparent',
    '#fffff',
    'url(https://example.test/a.png)',
    'rgb(1);display:none',
    'var(--secret)',
    'expression(alert(1))',
  ]) {
    assert.equal(parseCssColor(value), null)
  }
})

test('round-trips HSV and hex values', () => {
  for (const value of ['#2e66ce', '#78a9ff', '#000000', '#ffffff', '#12ab3478']) {
    const parsed = parseCssColor(value)
    assert.ok(parsed)
    const hsv = rgbToHsv(parsed)
    assert.equal(hsvToHex(hsv, parsed.a), rgbaToHex(parsed))
  }
})

test('hsvToRgb clamps out-of-range channels', () => {
  assert.deepEqual(hsvToRgb({ h: 720, s: 150, v: 120 }, 2), {
    r: 255,
    g: 0,
    b: 0,
    a: 1,
  })
})

test('colorToHsv keeps alpha percentage', () => {
  assert.deepEqual(colorToHsv('#ffffff80'), {
    hsv: { h: 0, s: 0, v: 100 },
    alpha: 50,
  })
})
