import { Capacitor, registerPlugin } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { Clipboard } from '@capacitor/clipboard'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export const isNative = Capacitor.isNativePlatform()
export const credentials = registerPlugin<{
  read(): Promise<{ value: string | null }>
  write(options: { value: string | null }): Promise<void>
}>('SecureCredentials')

export const openOfficialPage = async (url: string) => {
  if (isNative) {
    try {
      await Browser.open({ url, presentationStyle: 'fullscreen' })
      return
    } catch {
      window.open(url, '_system')
      return
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export const readPastedText = async () => isNative
  ? (await Clipboard.read()).value
  : navigator.clipboard.readText()

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
