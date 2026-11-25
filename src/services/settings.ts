import { create } from 'zustand'
import { credentials, isNative } from './native.js'
import type { TtsVoice } from './api/speech.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 消息复制默认格式；默认沿用 Markdown 原文 */
export type CopyFormat = 'markdown' | 'plain'

/** 非敏感设置保存在本机；连接密钥仅在内存及 Android Keystore 加密存储中。 */
export type PromptPreset = { id: string; title: string; body: string }
type PromptPreferences = { presets: PromptPreset[]; selectedId: string | null }

type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  copyFormat: CopyFormat
  chatFontSize: number | null
  ttsVoice: TtsVoice
  autoReadAloud: boolean
  /** 思考内容自动折叠：生成结束后收起思考过程，只留标题行 */
  autoCollapseThinking: boolean
  autoCompactContext: boolean
  hapticsEnabled: boolean
  thinking: boolean
  search: boolean
  prompts: PromptPreferences
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  themePreference: 'chat-demo:theme-preference',
  copyFormat: 'deepchat:copy-format',
  chatFontSize: 'deepchat:chat-font-size',
  ttsVoice: 'chat-demo:tts-voice',
  autoReadAloud: 'chat-demo:auto-read-aloud',
  autoCollapseThinking: 'chat-demo:auto-collapse-thinking',
  autoCompactContext: 'deepchat:auto-compact-context',
  hapticsEnabled: 'deepchat:haptics-enabled',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  systemPrompt: 'deepchat:system-prompt',
  prompts: 'deepchat:prompt-presets-v1',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

export const readPreference = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const writePreference = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
    return true
  } catch {
    // 存储不可用时只在内存中生效
    return false
  }
}

const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = readPreference(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = readPreference(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

const initialCopyFormat = (): CopyFormat =>
  readPreference(KEYS.copyFormat) === 'plain' ? 'plain' : 'markdown'

const initialChatFontSize = () => {
  const value = Number(readPreference(KEYS.chatFontSize))
  return Number.isInteger(value) && value >= 14 && value <= 22 ? value : null
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (readPreference(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialPrompts = (): PromptPreferences => {
  const raw = readPreference(KEYS.prompts)
  if (raw !== null) {
    try {
      const stored = JSON.parse(raw) as Partial<PromptPreferences> | null
      if (Array.isArray(stored?.presets)) {
        const presets = stored.presets.filter((item) =>
          typeof item?.id === 'string' && typeof item.title === 'string' &&
          typeof item.body === 'string' && item.title.trim() && item.body.trim()
        )
        const selectedId = presets.some((item) => item.id === stored.selectedId)
          ? stored.selectedId ?? null : null
        return { presets, selectedId }
      }
    } catch {
      // Use the legacy value if the saved list cannot be read.
    }
  }
  const body = readPreference(KEYS.systemPrompt)
  if (!body?.trim()) {
    return { presets: [], selectedId: null }
  }
  const migrated = {
    presets: [{ id: 'legacy', title: initialLocale() === 'zh-CN' ? '自定义提示词' : 'Custom prompt', body }],
    selectedId: 'legacy',
  }
  if (writePreference(KEYS.prompts, JSON.stringify(migrated))) {
    writePreference(KEYS.systemPrompt, null)
  }
  return migrated
}

export const useSettings = create<Settings>(() => ({
  apiKey: null,
  locale: initialLocale(),
  themePreference: initialThemePreference(),
  copyFormat: initialCopyFormat(),
  chatFontSize: initialChatFontSize(),
  ttsVoice: initialTtsVoice(),
  autoReadAloud: readPreference(KEYS.autoReadAloud) === 'true',
  // 未保存过时默认开启，与官方「思考内容自动折叠」初始状态一致
  autoCollapseThinking: readPreference(KEYS.autoCollapseThinking) !== 'false',
  autoCompactContext: readPreference(KEYS.autoCompactContext) !== 'false',
  hapticsEnabled: readPreference(KEYS.hapticsEnabled) !== 'false',
  thinking: readPreference(KEYS.thinking) === 'true',
  search: readPreference(KEYS.search) === 'true',
  prompts: initialPrompts(),
  siderCollapsed: readPreference(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  writePreference(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  writePreference(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setCopyFormat = (copyFormat: CopyFormat) => {
  writePreference(KEYS.copyFormat, copyFormat)
  useSettings.setState({ copyFormat })
}

export const setChatFontSize = (chatFontSize: number | null) => {
  writePreference(KEYS.chatFontSize, chatFontSize === null ? null : String(chatFontSize))
  useSettings.setState({ chatFontSize })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  writePreference(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setAutoReadAloud = (autoReadAloud: boolean) => {
  writePreference(KEYS.autoReadAloud, String(autoReadAloud))
  useSettings.setState({ autoReadAloud })
}

export const setAutoCollapseThinking = (autoCollapseThinking: boolean) => {
  writePreference(KEYS.autoCollapseThinking, String(autoCollapseThinking))
  useSettings.setState({ autoCollapseThinking })
}

export const setAutoCompactContext = (autoCompactContext: boolean) => {
  writePreference(KEYS.autoCompactContext, String(autoCompactContext))
  useSettings.setState({ autoCompactContext })
}

export const setHapticsEnabled = (hapticsEnabled: boolean) => {
  writePreference(KEYS.hapticsEnabled, String(hapticsEnabled))
  useSettings.setState({ hapticsEnabled })
}

export const initializeCredentials = async (deadline: Promise<never>) => {
  writePreference(KEYS.apiKey, null)
  writePreference('chat-demo:location', null)
  if (isNative) {
    const { value } = await Promise.race([credentials.read(), deadline])
    useSettings.setState({ apiKey: value })
  }
}

export const apiKeyFileScopePreference = 'deepchat:api-key-file-scope'

export const setApiKey = async (apiKey: string | null) => {
  const changed = apiKey !== useSettings.getState().apiKey
  if (isNative) {
    await credentials.write({ value: apiKey })
  }
  if (changed) {
    writePreference(apiKeyFileScopePreference, crypto.randomUUID())
  }
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  writePreference(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  writePreference(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setPrompts = (prompts: PromptPreferences) => {
  if (!writePreference(KEYS.prompts, JSON.stringify(prompts))) {
    return false
  }
  useSettings.setState({ prompts })
  return true
}

export const getSelectedPrompt = ({ presets, selectedId }: PromptPreferences) =>
  presets.find((preset) => preset.id === selectedId)

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  writePreference(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
