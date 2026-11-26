export type RgbaColor = {
  r: number
  g: number
  b: number
  a: number
}

export type HsvColor = {
  h: number
  s: number
  v: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const channelFromHex = (value: string) =>
  Number.parseInt(value.length === 1 ? value + value : value, 16)

const parseHex = (input: string): RgbaColor | null => {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input.trim())
  if (!match) {
    return null
  }
  const value = match[1]
  if (value.length === 3 || value.length === 4) {
    return {
      r: channelFromHex(value[0]),
      g: channelFromHex(value[1]),
      b: channelFromHex(value[2]),
      a: value.length === 4 ? channelFromHex(value[3]) / 255 : 1,
    }
  }
  return {
    r: channelFromHex(value.slice(0, 2)),
    g: channelFromHex(value.slice(2, 4)),
    b: channelFromHex(value.slice(4, 6)),
    a: value.length === 8 ? channelFromHex(value.slice(6, 8)) / 255 : 1,
  }
}

const parseAlpha = (input: string | undefined) => {
  if (input === undefined) {
    return 1
  }
  const value = input.endsWith('%')
    ? Number.parseFloat(input.slice(0, -1)) / 100
    : Number.parseFloat(input)
  return Number.isFinite(value) ? clamp(value, 0, 1) : null
}

const parseRgb = (input: string): RgbaColor | null => {
  const match =
    /^rgba?\(\s*([0-9.]+%?)\s*[, ]\s*([0-9.]+%?)\s*[, ]\s*([0-9.]+%?)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(
      input.trim()
    )
  if (!match) {
    return null
  }
  const channel = (raw: string) => {
    const value = raw.endsWith('%')
      ? (Number.parseFloat(raw.slice(0, -1)) / 100) * 255
      : Number.parseFloat(raw)
    return Number.isFinite(value) ? Math.round(clamp(value, 0, 255)) : null
  }
  const r = channel(match[1])
  const g = channel(match[2])
  const b = channel(match[3])
  const a = parseAlpha(match[4])
  return r === null || g === null || b === null || a === null ? null : { r, g, b, a }
}

const hueToRgb = (p: number, q: number, t: number) => {
  let value = t
  if (value < 0) {
    value += 1
  }
  if (value > 1) {
    value -= 1
  }
  if (value < 1 / 6) {
    return p + (q - p) * 6 * value
  }
  if (value < 1 / 2) {
    return q
  }
  if (value < 2 / 3) {
    return p + (q - p) * (2 / 3 - value) * 6
  }
  return p
}

const parseHsl = (input: string): RgbaColor | null => {
  const match =
    /^hsla?\(\s*(-?[0-9.]+)(?:deg)?\s*[, ]\s*([0-9.]+)%\s*[, ]\s*([0-9.]+)%(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(
      input.trim()
    )
  if (!match) {
    return null
  }
  const h = (((Number.parseFloat(match[1]) % 360) + 360) % 360) / 360
  const s = clamp(Number.parseFloat(match[2]), 0, 100) / 100
  const l = clamp(Number.parseFloat(match[3]), 0, 100) / 100
  const a = parseAlpha(match[4])
  if (!Number.isFinite(h) || a === null) {
    return null
  }
  if (s === 0) {
    const gray = Math.round(l * 255)
    return { r: gray, g: gray, b: gray, a }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
    a,
  }
}

/** 解析主题允许的 hex/rgb/hsl 颜色；其他 CSS 语法一律拒绝。 */
export const parseCssColor = (input: string): RgbaColor | null => {
  if (typeof input !== 'string' || input.length > 80) {
    return null
  }
  return parseHex(input) ?? parseRgb(input) ?? parseHsl(input)
}

const hexChannel = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, '0')

/** 统一输出 hex；透明度小于 1 时输出 8 位 hex。 */
export const rgbaToHex = ({ r, g, b, a }: RgbaColor): string => {
  const base = `#${hexChannel(r)}${hexChannel(g)}${hexChannel(b)}`
  return a < 1 ? `${base}${hexChannel(a * 255)}` : base
}

export const rgbToHsv = ({ r, g, b }: RgbaColor): HsvColor => {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta > 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6
    } else if (max === green) {
      hue = (blue - red) / delta + 2
    } else {
      hue = (red - green) / delta + 4
    }
    hue *= 60
    if (hue < 0) {
      hue += 360
    }
  }
  return {
    h: Math.round(hue * 10) / 10,
    s: Math.round((max === 0 ? 0 : delta / max) * 1000) / 10,
    v: Math.round(max * 1000) / 10,
  }
}

export const hsvToRgb = ({ h, s, v }: HsvColor, alpha = 1): RgbaColor => {
  const hue = ((h % 360) + 360) % 360
  const saturation = clamp(s, 0, 100) / 100
  const value = clamp(v, 0, 100) / 100
  const chroma = value * saturation
  const sector = hue / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const match = Math.floor(sector) % 6
  const [red, green, blue] =
    match === 0
      ? [chroma, x, 0]
      : match === 1
        ? [x, chroma, 0]
        : match === 2
          ? [0, chroma, x]
          : match === 3
            ? [0, x, chroma]
            : match === 4
              ? [x, 0, chroma]
              : [chroma, 0, x]
  const offset = value - chroma
  return {
    r: Math.round((red + offset) * 255),
    g: Math.round((green + offset) * 255),
    b: Math.round((blue + offset) * 255),
    a: clamp(alpha, 0, 1),
  }
}

export const hsvToHex = (hsv: HsvColor, alpha = 1): string => rgbaToHex(hsvToRgb(hsv, alpha))

export const colorToHsv = (input: string): { hsv: HsvColor; alpha: number } | null => {
  const color = parseCssColor(input)
  return color ? { hsv: rgbToHsv(color), alpha: Math.round(color.a * 100) } : null
}
