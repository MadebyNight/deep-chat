import { Capacitor, registerPlugin } from '@capacitor/core'
import { BackupError } from './errors.js'

const plugin = registerPlugin<{
  download(options: { id: string; url: string }): Promise<{ uri: string; size: number }>
  cancel(options: { id: string }): Promise<void>
  release(options: { id: string }): Promise<void>
}>('HistoryExportDownload')

export const canDownloadHistoryExport = Capacitor.getPlatform() === 'android'

export async function downloadHistoryExport(url: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const id = crypto.randomUUID()
  const name = `history-download-${id}.zip`
  let root: FileSystemDirectoryHandle | undefined
  let retained = false
  const cleanup = () => {
    if (root) {
      void root.removeEntry(name).catch(() => undefined)
    }
  }
  const cancel = () => {
    void plugin.cancel({ id }).catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const { uri, size } = await plugin.download({ id, url })
    signal.throwIfAborted()
    root = await navigator.storage?.getDirectory?.().catch(() => undefined)
    const handle = await root?.getFileHandle(name, { create: true })
    const canWrite = typeof handle?.createWritable === 'function'
    if (!canWrite && size > 32 * 1024 * 1024) {
      throw new BackupError('historyLinkTooLarge')
    }
    const response = await fetch(Capacitor.convertFileSrc(uri), { signal, cache: 'no-store' })
    if (!response.ok || !response.body) {
      throw new BackupError('backupImportReadError')
    }
    if (canWrite && handle) {
      await response.body.pipeTo(await handle.createWritable(), { signal })
      const file = await handle.getFile()
      retained = true
      return { file, cleanup }
    }
    const blob = await response.blob()
    return { file: new File([blob], name, { type: 'application/zip' }), cleanup }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof BackupError) {
      throw error
    }
    const failure = error as { code?: string; data?: { host?: unknown } } | null
    const host = failure?.data?.host
    const params = typeof host === 'string' && /^[a-z0-9.\-:[\]]{1,253}$/i.test(host)
      ? { host } : undefined
    switch (failure?.code) {
      case 'LINK_INPUT':
        throw new BackupError(params ? 'historyLinkInputHost' : 'historyLinkInputInvalid', params)
      case 'LINK_REDIRECT':
        throw new BackupError(params ? 'historyLinkRedirectHost' : 'historyLinkRedirectInvalid', params)
      case 'EXPIRED':
        throw new BackupError('historyLinkUnavailable')
      case 'NOT_ZIP':
        throw new BackupError('historyLinkNotZip')
      case 'TOO_LARGE':
        throw new BackupError('historyLinkTooLarge')
      default:
        throw new BackupError('historyLinkNetwork')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await plugin.release({ id }).catch(() => undefined)
    if (!retained) {
      cleanup()
    }
  }
}
