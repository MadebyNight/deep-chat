import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_DARK_PALETTE,
  DEFAULT_LIGHT_PALETTE,
  THEME_TOKEN_VARIABLES,
  gradientToCss,
  isSafeThemeColor,
  parseThemePackage,
  serializeThemePackage,
  type ThemePackageV1,
  type ThemePackageV2,
} from './themePackages.js'

const validV1: ThemePackageV1 = {
  version: 1,
  id: 'ocean-theme',
  name: ' Ocean ',
  light: { ...DEFAULT_LIGHT_PALETTE, bubble: 'rgb(240, 248, 255)' },
  dark: DEFAULT_DARK_PALETTE,
  identity: {
    appName: ' Ocean Chat ',
    welcomeTitle: ' 你好 ',
    welcomeSubtitle: ' 今天想聊什么？ ',
    promptHint: ' 输入消息 ',
  },
  welcomeCard: { title: ' 快捷入口 ', body: ' 选择下面的提示词开始 ' },
}

const validV2: ThemePackageV2 = {
  version: 2,
  id: 'ocean-v2',
  name: 'Ocean v2',
  light: {
    colors: { ...DEFAULT_LIGHT_PALETTE },
    gradients: {
      background: {
        type: 'linear',
        angle: 160,
        stops: [
          { color: '#ffffff', position: 0 },
          { color: '#eef4ff', position: 100 },
        ],
      },
      brand: {
        type: 'linear',
        angle: 135,
        stops: [
          { color: '#2e66ce', position: 0 },
          { color: '#4b8bff', position: 100 },
        ],
      },
    },
    tokens: { labelSecondary: '#334155', inputBackground: '#f8fafc' },
  },
  dark: {
    colors: { ...DEFAULT_DARK_PALETTE },
    gradients: {
      bubble: {
        type: 'linear',
        angle: 90,
        stops: [
          { color: '#1e293b', position: 0 },
          { color: '#334155', position: 100 },
        ],
      },
    },
  },
  identity: {
    appName: 'Ocean Chat',
    welcomeTitle: '你好',
    welcomeSubtitle: '今天想聊什么？',
    promptHint: '输入消息',
  },
  welcomeCard: { title: '快捷入口', body: '选择下面的提示词开始' },
}

test('migrates a v1 package to v2 and keeps only declared fields', () => {
  const result = parseThemePackage({ ...validV1, unexpected: '<script>alert(1)</script>' })
  assert.equal(result.ok, true)
  if (!result.ok) {
    return
  }
  assert.equal(result.value.version, 2)
  assert.equal(result.value.name, 'Ocean')
  assert.deepEqual(result.value.light.colors, {
    ...DEFAULT_LIGHT_PALETTE,
    bubble: 'rgb(240, 248, 255)',
  })
  assert.deepEqual(result.value.identity, {
    appName: 'Ocean Chat',
    welcomeTitle: '你好',
    welcomeSubtitle: '今天想聊什么？',
    promptHint: '输入消息',
  })
  assert.equal(Object.hasOwn(result.value, 'unexpected'), false)
})

test('round-trips a v2 package with gradients and whitelisted tokens', () => {
  const result = parseThemePackage(JSON.parse(serializeThemePackage(validV2)))
  assert.equal(result.ok, true)
  if (!result.ok) {
    return
  }
  assert.deepEqual(result.value, validV2)
  const backgroundGradient = validV2.light.gradients?.background
  assert.ok(backgroundGradient)
  assert.equal(
    gradientToCss(backgroundGradient),
    'linear-gradient(160deg, #ffffff 0%, #eef4ff 100%)'
  )
})

test('ignores raw CSS variable names in tokens', () => {
  const result = parseThemePackage({
    ...validV2,
    light: {
      ...validV2.light,
      tokens: {
        labelSecondary: '#334155',
        '--dsw-alias-brand-primary': '#ff0000',
        '--dsw-alias-bg-base': '#ff0000',
      },
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) {
    return
  }
  assert.deepEqual(result.value.light.tokens, { labelSecondary: '#334155' })
  assert.equal(
    Object.hasOwn(result.value.light.tokens ?? {}, '--dsw-alias-brand-primary'),
    false
  )
})

test('rejects invalid versions, ids, empty packages and unsafe colors', () => {
  for (const invalid of [
    null,
    [],
    { ...validV2, version: 3 },
    { ...validV2, id: '../escape' },
    { ...validV2, name: '   ' },
    { ...validV2, light: { colors: { brand: 'red; background:url(javascript:1)' } } },
    { ...validV2, dark: { colors: { bubble: 'var(--secret)' } } },
    { version: 2, id: 'empty', name: 'Empty', light: {}, dark: {} },
    { ...validV2, identity: { appName: { nested: true } } },
    { ...validV2, welcomeCard: [] },
  ]) {
    assert.equal(parseThemePackage(invalid).ok, false)
  }
})

test('rejects malformed or unsafe gradients', () => {
  const stops = [
    { color: '#ffffff', position: 0 },
    { color: '#000000', position: 100 },
  ]
  for (const gradient of [
    { type: 'radial', angle: 90, stops },
    { type: 'linear', angle: 361, stops },
    { type: 'linear', angle: -1, stops },
    { type: 'linear', angle: 90, stops: [stops[0]] },
    { type: 'linear', angle: 90, stops: [...stops, stops[0], stops[1], stops[0]] },
    { type: 'linear', angle: 90, stops: [{ color: 'url(x)', position: 0 }, stops[1]] },
    { type: 'linear', angle: 90, stops: [{ color: '#fff', position: -1 }, stops[1]] },
    { type: 'linear', angle: 90, stops: [{ color: '#fff', position: 101 }, stops[1]] },
  ]) {
    assert.equal(
      parseThemePackage({
        ...validV2,
        light: { ...validV2.light, gradients: { background: gradient } },
      }).ok,
      false
    )
  }
})

test('rejects non-color custom tokens and keeps the token whitelist bounded', () => {
  assert.equal(
    parseThemePackage({
      ...validV2,
      light: { ...validV2.light, tokens: { labelSecondary: 'url(https://example.test)' } },
    }).ok,
    false
  )
  assert.equal(Object.keys(THEME_TOKEN_VARIABLES).length, 8)
})

test('only accepts bounded safe color syntax', () => {
  for (const color of [
    '#fff',
    '#ffff',
    '#ffffff',
    '#ffffffff',
    'rgb(1, 2, 3)',
    'rgba(1,2,3,.5)',
    'hsl(20 30% 40%)',
  ]) {
    assert.equal(isSafeThemeColor(color), true)
  }
  for (const color of [
    '',
    'red',
    '#fffff',
    'url(https://example.test)',
    'rgb(1);display:none',
    'expression(1)',
  ]) {
    assert.equal(isSafeThemeColor(color), false)
  }
})

test('strips control characters and caps oversized text', () => {
  const result = parseThemePackage({
    version: 2,
    id: 'text-test',
    name: `A\u0000B${'x'.repeat(80)}`,
    light: { colors: { brand: '#000000' } },
    dark: {},
    identity: { welcomeTitle: `Hello\u0007${'y'.repeat(100)}` },
  })
  assert.equal(result.ok, true)
  if (!result.ok) {
    return
  }
  assert.equal(result.value.name?.length, 60)
  assert.equal(result.value.name?.startsWith('AB'), true)
  assert.equal(result.value.identity?.welcomeTitle?.length, 80)
})
