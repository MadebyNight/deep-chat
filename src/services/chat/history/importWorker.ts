import type { TranslationKey } from '../../../i18n/index.js'
import { BackupError } from './errors.js'
import { importArchive, prepareArchive, type ImportPreview } from './importArchive.js'

export type ImportRequest =
  | { type: 'preview'; file: File; cacheOnImport: boolean }
  | { type: 'import'; ids: string[] }
  | { type: 'cancel' }

export type ImportReply =
  | { type: 'preview'; items: ImportPreview }
  | { type: 'progress'; completed: number; total: number }
  | { type: 'complete' }
  | { type: 'failed'; key?: TranslationKey; name: string }

const port = self as unknown as {
  onmessage: (event: MessageEvent<ImportRequest>) => void
  postMessage: (reply: ImportReply) => void
}
let archive: Awaited<ReturnType<typeof prepareArchive>> | undefined
let providerFile: File | undefined
let operation: AbortController | undefined

// Android 文档提供器的文件切片可能反复从文件开头定位。需要导入时一次顺序读入私有临时文件。
const importFromProvider = async (
  file: File,
  prepared: Awaited<ReturnType<typeof prepareArchive>>,
  ids: string[],
  onProgress: (completed: number, total: number) => void,
  signal: AbortSignal
) => {
  const root = await navigator.storage.getDirectory()
  const name = 'history-import.tmp'
  signal.throwIfAborted()
  const handle = await root.getFileHandle(name, { create: true })
  try {
    const disk = handle as FileSystemFileHandle & {
      createWritable?: () => Promise<WritableStream<Uint8Array>>
    }
    if (!disk.createWritable) {
      await importArchive(prepared, ids, onProgress, signal)
      return
    }
    await file.stream().pipeTo(await disk.createWritable(), { signal })
    const local = await prepareArchive(await handle.getFile(), signal)
    await importArchive(local, ids, onProgress, signal)
  } finally {
    await root.removeEntry(name).catch(() => {})
  }
}

port.onmessage = async ({ data }) => {
  if (data.type === 'cancel') {
    operation?.abort()
    return
  }
  const controller = new AbortController()
  operation = controller
  try {
    if (data.type === 'preview') {
      archive = await prepareArchive(data.file, controller.signal)
      providerFile = data.cacheOnImport && typeof navigator.storage?.getDirectory === 'function'
        ? data.file
        : undefined
      controller.signal.throwIfAborted()
      port.postMessage({ type: 'preview', items: archive.preview })
    } else {
      if (!archive) {
        throw new BackupError('backupUnrecognized')
      }
      const onProgress = (completed: number, total: number) =>
        port.postMessage({ type: 'progress', completed, total })
      if (providerFile) {
        await importFromProvider(providerFile, archive, data.ids, onProgress, controller.signal)
      } else {
        await importArchive(archive, data.ids, onProgress, controller.signal)
      }
      controller.signal.throwIfAborted()
      port.postMessage({ type: 'complete' })
    }
  } catch (error) {
    port.postMessage({
      type: 'failed',
      key: error instanceof BackupError ? error.key : undefined,
      name: error instanceof Error ? error.name : 'Error',
    })
  } finally {
    operation = undefined
  }
}
