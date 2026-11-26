import { parseCssColor } from './color.js'

export type ThemeColorKey = 'brand' | 'background' | 'surface' | 'bubble' | 'text' | 'border'
export type ThemeColors = Partial<Record<ThemeColorKey, string>>

/** 兼容 v1 调用方的命名。 */
export type ThemePalette = ThemeColors

export type ThemeGradientKey = 'background' | 'bubble' | 'brand'

export type ThemeGradientStop = {
  color: string
  position: number
}

export type ThemeLinearGradient = {
  type: 'linear'
  angle: number
  stops: ThemeGradientStop[]
}

export const THEME_TOKEN_VARIABLES = {
  labelSecondary: '--dsw-alias-label-secondary',
  labelTertiary: '--dsw-alias-label-tertiary',
  inputBackground: '--dsw-specific-input-major',
  surface: '--dsw-alias-bg-layer-2',
  border: '--dsw-alias-border-l3',
  sidebarFill: '--dsw-specific-sidebar-fill',
  selector: '--dsw-specific-selector',
  markdownCode: '--dsw-alias-markdown-code-block',
} as const

export type ThemeTokenKey = keyof typeof THEME_TOKEN_VARIABLES
export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>

export type ThemeMode = {
  colors?: ThemeColors
  gradients?: Partial<Record<ThemeGradientKey, ThemeLinearGradient>>
  tokens?: ThemeTokens
}

export type ThemeIdentity = {
  appName?: string
  welcomeTitle?: string
  welcomeSubtitle?: string
  promptHint?: string
}

export type WelcomeCardTemplate = {
  title?: string
  body?: string
}

/** 主题包 v2：颜色、可绘制渐变、身份文案与固定白名单 tokens。 */
export type ThemePackageV2 = {
  version: 2
  id: string
  name: string
  light: ThemeMode
  dark: ThemeMode
  identity?: ThemeIdentity
  welcomeCard?: WelcomeCardTemplate
}

export type ThemePackage = ThemePackageV2

/** v1 只用于导入迁移，运行时统一存 v2。 */
export type ThemePackageV1 = {
  version: 1
  id: string
  name: string
  light: ThemePalette
  dark: ThemePalette
  identity?: ThemeIdentity
  welcomeCard?: WelcomeCardTemplate
}

export type ThemePackageResult =
  | { ok: true; value: ThemePackageV2 }
  | { ok: false; errors: string[] }

export const DEFAULT_LIGHT_PALETTE: Required<ThemeColors> = {
  brand: '#2e66ce',
  background: '#ffffff',
  surface: '#ffffff',
  bubble: '#f3f3f3',
  text: '#1b1b1c',
  border: 'rgba(0, 0, 0, 0.1)',
}

export const DEFAULT_DARK_PALETTE: Required<ThemeColors> = {
  brand: '#78a9ff',
  background: '#0f0f0f',
  surface: '#242424',
  bubble: '#333333',
  text: '#f3f3f3',
  border: 'rgba(255, 255, 255, 0.12)',
}

export const DEFAULT_GRADIENTS: Record<ThemeGradientKey, ThemeLinearGradient> = {
  background: {
    type: 'linear',
    angle: 160,
    stops: [
      { color: '#ffffff', position: 0 },
      { color: '#eef4ff', position: 100 },
    ],
  },
  bubble: {
    type: 'linear',
    angle: 135,
    stops: [
      { color: '#eaf1ff', position: 0 },
      { color: '#dfe9ff', position: 100 },
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
}

export const THEME_GRADIENT_KEYS: ThemeGradientKey[] = ['background', 'bubble', 'brand']

const colorKeys = [
  'brand',
  'background',
  'surface',
  'bubble',
  'text',
  'border',
] as const satisfies ThemeColorKey[]
const tokenKeys = Object.keys(THEME_TOKEN_VARIABLES) as ThemeTokenKey[]
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cleanText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const cleaned = Array.from(value)
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
  return cleaned ? cleaned.slice(0, maxLength) : undefined
}

const appearsUnsafe = (value: string) =>
  /(?:url|var|env|expression|@import|javascript)\s*\(|@import|[;{}]/i.test(value)

/** 只允许 hex 和常见 rgb/hsl 函数形式，拒绝分号、url() 等 CSS 注入。 */
export const isSafeThemeColor = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 80 &&
  !appearsUnsafe(value) &&
  parseCssColor(value) !== null

export const gradientToCss = (gradient: ThemeLinearGradient): string | null => {
  const parsed = parseGradient(gradient)
  if (!parsed) {
    return null
  }
  const stops = parsed.stops.map((stop) => `${stop.color} ${stop.position}%`).join(', ')
  return `linear-gradient(${parsed.angle}deg, ${stops})`
}

const parseColors = (input: unknown): ThemeColors | null | undefined => {
  if (input === undefined) {
    return {}
  }
  if (!isRecord(input)) {
    return null
  }
  const colors: ThemeColors = {}
  for (const key of colorKeys) {
    const raw = input[key]
    if (raw === undefined || raw === null || raw === '') {
      continue
    }
    if (!isSafeThemeColor(raw)) {
      return null
    }
    colors[key] = raw.trim()
  }
  return colors
}

const parseGradient = (input: unknown): ThemeLinearGradient | null => {
  if (!isRecord(input) || input.type !== 'linear') {
    return null
  }
  const angle = input.angle
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle > 360) {
    return null
  }
  if (!Array.isArray(input.stops) || input.stops.length < 2 || input.stops.length > 4) {
    return null
  }
  const stops: ThemeGradientStop[] = []
  for (const raw of input.stops) {
    if (!isRecord(raw) || !isSafeThemeColor(raw.color)) {
      return null
    }
    const position = raw.position
    if (
      typeof position !== 'number' ||
      !Number.isFinite(position) ||
      position < 0 ||
      position > 100
    ) {
      return null
    }
    stops.push({ color: raw.color.trim(), position: Math.round(position * 10) / 10 })
  }
  stops.sort((left, right) => left.position - right.position)
  return { type: 'linear', angle: Math.round(angle * 10) / 10, stops }
}

const parseGradients = (
  input: unknown
): Partial<Record<ThemeGradientKey, ThemeLinearGradient>> | null | undefined => {
  if (input === undefined) {
    return {}
  }
  if (!isRecord(input)) {
    return null
  }
  const gradients: Partial<Record<ThemeGradientKey, ThemeLinearGradient>> = {}
  for (const key of THEME_GRADIENT_KEYS) {
    const raw = input[key]
    if (raw === undefined || raw === null) {
      continue
    }
    const gradient = parseGradient(raw)
    if (!gradient) {
      return null
    }
    gradients[key] = gradient
  }
  return gradients
}

const parseTokens = (input: unknown): ThemeTokens | null | undefined => {
  if (input === undefined) {
    return {}
  }
  if (!isRecord(input)) {
    return null
  }
  const tokens: ThemeTokens = {}
  let count = 0
  for (const key of tokenKeys) {
    const raw = input[key]
    if (raw === undefined || raw === null || raw === '') {
      continue
    }
    if (!isSafeThemeColor(raw)) {
      return null
    }
    tokens[key] = raw.trim()
    count += 1
  }
  return count > 8 ? null : tokens
}

const parseMode = (input: unknown): ThemeMode | null | undefined => {
  if (input === undefined) {
    return {}
  }
  if (!isRecord(input)) {
    return null
  }
  const colors = parseColors(input.colors)
  const gradients = parseGradients(input.gradients)
  const tokens = parseTokens(input.tokens)
  if (!colors || !gradients || !tokens) {
    return null
  }
  return {
    ...(Object.keys(colors).length ? { colors } : {}),
    ...(Object.keys(gradients).length ? { gradients } : {}),
    ...(Object.keys(tokens).length ? { tokens } : {}),
  }
}

const parseIdentity = (input: unknown): ThemeIdentity | null | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    return null
  }
  for (const key of ['appName', 'welcomeTitle', 'welcomeSubtitle', 'promptHint']) {
    const value = input[key]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return null
    }
  }
  const identity: ThemeIdentity = {
    appName: cleanText(input.appName, 40),
    welcomeTitle: cleanText(input.welcomeTitle, 80),
    welcomeSubtitle: cleanText(input.welcomeSubtitle, 120),
    promptHint: cleanText(input.promptHint, 80),
  }
  const defined = Object.fromEntries(
    Object.entries(identity).filter(([, value]) => value !== undefined)
  ) as ThemeIdentity
  return defined
}

const parseWelcomeCard = (input: unknown): WelcomeCardTemplate | null | undefined => {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    return null
  }
  for (const key of ['title', 'body']) {
    const value = input[key]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return null
    }
  }
  const card: WelcomeCardTemplate = {
    title: cleanText(input.title, 60),
    body: cleanText(input.body, 240),
  }
  const defined = Object.fromEntries(
    Object.entries(card).filter(([, value]) => value !== undefined)
  ) as WelcomeCardTemplate
  return Object.keys(defined).length ? defined : undefined
}

const isModeEmpty = (mode: ThemeMode) =>
  !Object.keys(mode.colors ?? {}).length &&
  !Object.keys(mode.gradients ?? {}).length &&
  !Object.keys(mode.tokens ?? {}).length

/** 校验并归一化外部 JSON；v1 自动迁移到 v2，未知字段直接丢弃。 */
export const parseThemePackage = (input: unknown): ThemePackageResult => {
  if (!isRecord(input)) {
    return { ok: false, errors: ['package'] }
  }
  const version = input.version
  if (version !== 1 && version !== 2) {
    return { ok: false, errors: ['version'] }
  }

  const errors: string[] = []
  const id = cleanText(input.id, 64)
  if (!id || !idPattern.test(id)) {
    errors.push('id')
  }
  const name = cleanText(input.name, 60)
  if (!name) {
    errors.push('name')
  }

  let light: ThemeMode | null | undefined
  let dark: ThemeMode | null | undefined
  if (version === 1) {
    const lightColors = parseColors(input.light)
    const darkColors = parseColors(input.dark)
    light = lightColors ? { colors: lightColors } : null
    dark = darkColors ? { colors: darkColors } : null
  } else {
    light = parseMode(input.light)
    dark = parseMode(input.dark)
  }
  if (!light) {
    errors.push('light')
  }
  if (!dark) {
    errors.push('dark')
  }
  const identity = parseIdentity(input.identity)
  if (identity === null) {
    errors.push('identity')
  }
  const welcomeCard = parseWelcomeCard(input.welcomeCard)
  if (welcomeCard === null) {
    errors.push('welcomeCard')
  }

  if (!light || !dark) {
    return { ok: false, errors }
  }
  if (isModeEmpty(light) && isModeEmpty(dark)) {
    errors.push('colors')
  }
  if (errors.length || !id || !name) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      version: 2,
      id,
      name,
      light,
      dark,
      ...(identity && Object.keys(identity).length ? { identity } : {}),
      ...(welcomeCard ? { welcomeCard } : {}),
    },
  }
}

export const serializeThemePackage = (theme: ThemePackageV2): string =>
  JSON.stringify(theme, null, 2)
