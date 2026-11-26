import { Capacitor, registerPlugin } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export const isNative = Capacitor.isNativePlatform()
export const isAndroid = Capacitor.getPlatform() === 'android'
export const credentials = registerPlugin<{
  read(options?: { slot: 'customProvider' }): Promise<{ value: string | null }>
  write(options: { value: string | null; slot?: 'customProvider' }): Promise<void>
}>('SecureCredentials')

export type NativeExportResult = {
  fileName: string
  uri?: string
}

export type NativeShareFile = {
  name: string
  blob: Blob
}

type NativeExportPlugin = {
  saveText(options: {
    fileName: string
    content: string
    mimeType: string
  }): Promise<{ files: NativeExportResult[] }>
  saveFile(options: {
    fileName: string
    base64: string
    mimeType: string
  }): Promise<{ files: NativeExportResult[] }>
  saveImages(options: {
    files: { fileName: string; base64: string; mimeType: string }[]
  }): Promise<{ files: NativeExportResult[] }>
  saveHtmlImages(options: {
    html: string
    fileNameBase: string
    heightCss: number
    background: string
  }): Promise<{ files: NativeExportResult[] }>
  shareHtmlImages(options: {
    html: string
    fileNameBase: string
    heightCss: number
    background: string
    title?: string
  }): Promise<void>
  shareFiles(options: {
    files: { fileName: string; base64: string; mimeType: string }[]
    title?: string
  }): Promise<void>
  printHtml(options: { title: string; html: string; baseUrl?: string }): Promise<void>
}

const nativeExport = registerPlugin<NativeExportPlugin>('NativeExport')

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

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('Unable to read export data'))
    reader.readAsDataURL(blob)
  })

const downloadBlob = (fileName: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const singleResult = (result: { files: NativeExportResult[] }): NativeExportResult => {
  const file = result.files[0]
  if (!file) {
    throw new Error('Native export returned no file')
  }
  return file
}

/**
 * 保存文本文件。Android 写入系统 Downloads/DeepChat，Web 触发下载。
 * #27 可直接复用于 HTML、SVG、JSON 等文本产物。
 */
export const saveTextFile = async (
  fileName: string,
  content: string,
  mimeType = 'text/markdown'
): Promise<NativeExportResult> => {
  if (isAndroid) {
    return singleResult(await nativeExport.saveText({ fileName, content, mimeType }))
  }
  downloadBlob(fileName, new Blob([content], { type: `${mimeType};charset=utf-8` }))
  return { fileName }
}

/**
 * 保存任意二进制文件。Android 写入系统 Downloads/DeepChat，Web 触发下载。
 * #27 可复用于导出 PNG、SVG 和 HTML 归档。
 */
export const saveFile = async (
  fileName: string,
  blob: Blob,
  mimeType = blob.type || 'application/octet-stream'
): Promise<NativeExportResult> => {
  if (isAndroid) {
    return singleResult(
      await nativeExport.saveFile({ fileName, base64: await blobToBase64(blob), mimeType })
    )
  }
  downloadBlob(fileName, blob)
  return { fileName }
}

/** 保存 PNG 等图片到相册。Android 使用 MediaStore Pictures/DeepChat，Web 降级为下载。 */
export const saveImageToGallery = async (
  fileName: string,
  blob: Blob
): Promise<NativeExportResult> => {
  if (isAndroid) {
    return singleResult(
      await nativeExport.saveImages({
        files: [
          {
            fileName,
            base64: await blobToBase64(blob),
            mimeType: blob.type || 'image/png',
          },
        ],
      })
    )
  }
  downloadBlob(fileName, blob)
  return { fileName }
}

/** 批量保存图片到相册；返回系统分配的文件名和内容 URI。 */
export const saveImagesToGallery = async (
  files: { fileName: string; blob: Blob }[]
): Promise<NativeExportResult[]> => {
  if (isAndroid) {
    const results: NativeExportResult[] = []
    for (const { fileName, blob } of files) {
      const result = await nativeExport.saveImages({
        files: [
          {
            fileName,
            base64: await blobToBase64(blob),
            mimeType: blob.type || 'image/png',
          },
        ],
      })
      results.push(...result.files)
    }
    return results
  }
  for (const file of files) {
    downloadBlob(file.fileName, file.blob)
  }
  return files.map(({ fileName }) => ({ fileName }))
}

/**
 * Android 原生 WebView 将独立 HTML 按像素预算分段栅格化后写入相册。
 * #27 可复用于本地报告、分享卡片等 HTML 产物。
 */
export const saveHtmlImagesToGallery = async (
  fileNameBase: string,
  html: string,
  heightCss: number,
  background: string
): Promise<NativeExportResult[]> => {
  if (!isAndroid) {
    throw new Error('HTML image export is Android-only')
  }
  const result = await nativeExport.saveHtmlImages({
    html,
    fileNameBase,
    heightCss,
    background,
  })
  return result.files
}

/**
 * Android 原生 WebView 将独立 HTML 按像素预算分段栅格化后交给 FileProvider 分享。
 * #27 可复用于本地报告、分享卡片等 HTML 产物。
 */
export const shareHtmlImages = async (
  title: string,
  fileNameBase: string,
  html: string,
  heightCss: number,
  background: string
): Promise<void> => {
  if (!isAndroid) {
    throw new Error('HTML image export is Android-only')
  }
  await nativeExport.shareHtmlImages({
    title,
    html,
    fileNameBase,
    heightCss,
    background,
  })
}

/**
 * 通过系统分享面板发送一个或多个文件。Android 文件写入应用缓存并交给 FileProvider；
 * Web 支持文件分享时使用 Web Share API，否则逐项下载。
 * #27 可直接复用该通道导出本地 HTML/SVG/PNG。
 */
export const shareFiles = async (
  title: string,
  files: NativeShareFile[]
): Promise<void> => {
  if (files.length === 0) {
    throw new Error('No files to share')
  }
  if (isAndroid) {
    await nativeExport.shareFiles({
      title,
      files: await Promise.all(
        files.map(async (file) => ({
          fileName: file.name,
          base64: await blobToBase64(file.blob),
          mimeType: file.blob.type || 'application/octet-stream',
        }))
      ),
    })
    return
  }
  const shared = files.map(
    (file) => new File([file.blob], file.name, { type: file.blob.type })
  )
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: shared }))) {
    await navigator.share({ title, files: shared })
    return
  }
  for (const file of files) {
    downloadBlob(file.name, file.blob)
  }
}

export const shareFile = (
  title: string,
  fileName: string,
  blob: Blob
): Promise<void> => shareFiles(title, [{ name: fileName, blob }])

/**
 * 打印独立 HTML。Android 在隐藏 WebView 中完成排版后打开 PrintManager，
 * “另存为 PDF”由系统打印服务提供；Web 在隐藏 iframe 中调用浏览器打印。
 */
export const printHtml = async (title: string, html: string): Promise<void> => {
  if (isAndroid) {
    await nativeExport.printHtml({
      title,
      html,
      baseUrl: window.location.href,
    })
    return
  }
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  document.body.appendChild(frame)
  const loaded = new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve()
    frame.onerror = () => reject(new Error('Unable to load print document'))
  })
  frame.srcdoc = html
  try {
    await loaded
    await new Promise((resolve) => setTimeout(resolve, 80))
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
  } finally {
    setTimeout(() => frame.remove(), 60_000)
  }
}

export const saveArchive = async (name: string, blob: Blob, title = '保存聊天记录') => {
  if (isNative) {
    const data = await blobToBase64(blob)
    const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache })
    await Share.share({ title, files: [uri] })
    return
  }
  downloadBlob(name, blob)
}
