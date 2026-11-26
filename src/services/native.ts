import { Capacitor, registerPlugin } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export const isNative = Capacitor.isNativePlatform()

export type CredentialSlot = 'customProvider' | 'webdav' | 'mcp' | 'externalSearch'

export const credentials = registerPlugin<{
  read(options?: { slot?: CredentialSlot }): Promise<{ value: string | null }>
  write(options: { value: string | null; slot?: CredentialSlot }): Promise<void>
}>('SecureCredentials')

export type WebDavNativeResponse = {
  status: number
  headers?: Record<string, string>
  body?: string
}

export const webDavHttp = registerPlugin<{
  request(options: {
    baseUrl: string
    path: string
    method: 'PROPFIND' | 'MKCOL' | 'GET' | 'PUT' | 'DELETE'
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<WebDavNativeResponse>
}>('WebDavHttp')

export type ExternalHttpResponse = {
  status: number
  headers?: Record<string, string>
  body?: string
}

/** 第三方 MCP / 搜索请求的受控 Android 原生通路；不读取任何官方账号凭据。 */
export const externalHttp = registerPlugin<{
  request(options: {
    id: string
    url: string
    method: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }): Promise<ExternalHttpResponse>
  cancel(options: { id: string }): Promise<void>
}>('ExternalHttp')

const officialBrowser = registerPlugin<{ open(options: { url: string }): Promise<void> }>(
  'OfficialBrowser'
)

export const openOfficialPage = async (url: string) => {
  if (Capacitor.getPlatform() === 'android') {
    await officialBrowser.open({ url })
  } else if (isNative) {
    await Browser.open({ url, presentationStyle: 'fullscreen' })
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** 分享文本：移动端走系统分享面板，桌面端不支持时抛错由调用方提示 */
export const shareText = async (title: string, text: string) => {
  if (isNative) {
    await Share.share({ title, text })
    return
  }
  if (navigator.share) {
    await navigator.share({ title, text })
    return
  }
  throw new Error('share unsupported')
}

export const saveArchive = async (name: string, blob: Blob) => {
  if (isNative) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = () => reject(new Error('无法读取导出文件'))
      reader.readAsDataURL(blob)
    })
    const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache })
    await Share.share({ title: '保存聊天记录', files: [uri] })
    return
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
