import { create } from 'zustand'
import { credentials, isNative } from './native.js'
import type { TtsVoice } from './api/speech.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 非敏感设置保存在本机；连接密钥仅在内存及 Android Keystore 加密存储中。 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  chatFontSize: number | null
  ttsVoice: TtsVoice
  autoReadAloud: boolean
  /** 思考内容自动折叠：生成结束后收起思考过程，只留标题行 */
  autoCollapseThinking: boolean
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  themePreference: 'chat-demo:theme-preference',
  chatFontSize: 'deepchat:chat-font-size',
  ttsVoice: 'chat-demo:tts-voice',
  autoReadAloud: 'chat-demo:auto-read-aloud',
  autoCollapseThinking: 'chat-demo:auto-collapse-thinking',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

const initialChatFontSize = () => {
  const value = Number(read(KEYS.chatFontSize))
  return Number.isInteger(value) && value >= 14 && value <= 22 ? value : null
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const useSettings = create<Settings>(() => ({
  apiKey: null,
  locale: initialLocale(),
  themePreference: initialThemePreference(),
  chatFontSize: initialChatFontSize(),
  ttsVoice: initialTtsVoice(),
  autoReadAloud: read(KEYS.autoReadAloud) === 'true',
  // 未保存过时默认开启，与官方「思考内容自动折叠」初始状态一致
  autoCollapseThinking: read(KEYS.autoCollapseThinking) !== 'false',
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setChatFontSize = (chatFontSize: number | null) => {
  write(KEYS.chatFontSize, chatFontSize === null ? null : String(chatFontSize))
  useSettings.setState({ chatFontSize })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setAutoReadAloud = (autoReadAloud: boolean) => {
  write(KEYS.autoReadAloud, String(autoReadAloud))
  useSettings.setState({ autoReadAloud })
}

export const setAutoCollapseThinking = (autoCollapseThinking: boolean) => {
  write(KEYS.autoCollapseThinking, String(autoCollapseThinking))
  useSettings.setState({ autoCollapseThinking })
}

export const initializeCredentials = async () => {
  write(KEYS.apiKey, null)
  write('chat-demo:location', null)
  if (isNative) {
    const { value } = await credentials.read()
    useSettings.setState({ apiKey: value })
  }
}

export const setApiKey = async (apiKey: string | null) => {
  if (isNative) {
    await credentials.write({ value: apiKey })
  }
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
