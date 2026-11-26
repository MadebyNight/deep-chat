import { useSyncExternalStore } from 'react'
import { useSettings, type ThemePreference } from '../services/settings.js'
import {
  THEME_TOKEN_VARIABLES,
  gradientToCss,
  type ThemeColorKey,
  type ThemeGradientKey,
  type ThemePackage,
} from '../services/themePackages.js'
import { subscribeMediaQuery } from './mediaQuery.js'

export type Theme = 'light' | 'dark'

const query = window.matchMedia?.('(prefers-color-scheme: dark)')
const subscribeOsTheme = (listener: () => void) => subscribeMediaQuery(query, listener)
const getOsTheme = (): Theme => (query?.matches ? 'dark' : 'light')

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  return resolveTheme(preference, osTheme)
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

const paletteVariables: Record<ThemeColorKey, string[]> = {
  brand: ['--dsw-alias-brand-primary', '--dsw-alias-brand-text', '--dsw-alias-button-primary-fill'],
  background: ['--dsw-alias-bg-base'],
  bubble: ['--dsw-specific-bubble'],
  text: ['--dsw-alias-label-primary'],
  surface: ['--dsw-specific-input-major', '--dsw-alias-bg-layer-2'],
  border: ['--dsw-alias-border-l2', '--dsw-alias-border-l2-darkmode-thin'],
}
const gradientVariables: Record<ThemeGradientKey, string> = {
  background: '--deepchat-theme-background-image',
  bubble: '--deepchat-theme-bubble-image',
  brand: '--deepchat-theme-brand-image',
}
const managedVariables = [
  ...Object.values(paletteVariables).flat(),
  ...Object.values(gradientVariables),
  ...Object.values(THEME_TOKEN_VARIABLES),
]

/** 主题包只写到白名单变量，切换或恢复默认时先清掉上一次覆盖。 */
const applyThemePackage = (theme: Theme, themePackage: ThemePackage | null) => {
  const style = document.body.style
  for (const variable of managedVariables) {
    style.removeProperty(variable)
  }
  if (themePackage) {
    const mode = theme === 'dark' ? themePackage.dark : themePackage.light
    for (const [key, variables] of Object.entries(paletteVariables) as [
      ThemeColorKey,
      string[],
    ][]) {
      const value = mode.colors?.[key]
      if (value) {
        variables.forEach((variable) => style.setProperty(variable, value))
      }
    }
    for (const [key, variable] of Object.entries(gradientVariables) as [
      ThemeGradientKey,
      string,
    ][]) {
      const gradient = mode.gradients?.[key]
      const value = gradient ? gradientToCss(gradient) : null
      if (value) {
        style.setProperty(variable, value)
      }
    }
    for (const [key, variable] of Object.entries(THEME_TOKEN_VARIABLES)) {
      const value = mode.tokens?.[key as keyof typeof THEME_TOKEN_VARIABLES]
      if (value) {
        style.setProperty(variable, value)
      }
    }
  }
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  window.dispatchEvent(new Event('deepchat:theme-applied'))
}

/** 同步页面主题、根画布背景和支持 theme-color 的浏览器栏。 */
const applyTheme = (theme: Theme) => {
  const body = document.body
  // 主题切换帧禁用过渡，使页面颜色同步更新
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  // 首次背景色同步在样式表加载完成后执行，适配 WebKit 的 defer 脚本执行顺序。
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => {
    body.classList.remove('change-theme')
  }, 0)
}

let appliedTheme: Theme | null = null
let appliedPackage: string | null = null

const syncTheme = () => {
  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())
  const themePackage = useSettings.getState().themePackage
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  }
  const packageSignature = JSON.stringify([theme, themePackage])
  if (packageSignature !== appliedPackage) {
    appliedPackage = packageSignature
    applyThemePackage(theme, themePackage)
  }
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  subscribeMediaQuery(query, syncTheme)
  useSettings.subscribe(syncTheme)
}
