import { Capacitor } from '@capacitor/core'
import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'
import { BackupError } from './history/errors.js'
import type { ImportPreview, ImportProgress } from './history/importArchive.js'
import type { ImportReply, ImportRequest } from './history/importWorker.js'

export { BackupError }

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

export type HistoryImportSource = {
  preview(signal: AbortSignal): Promise<ImportPreview>
  stage(ids: string[], onProgress: ImportProgress, signal: AbortSignal): Promise<void>
  close(): void
}

export const openHistoryImport = (file: File): HistoryImportSource => {
  // 本地 HTML 可以用 file:// 打开，此时浏览器可能禁止加载 Worker 脚本。
  if (location.protocol === 'file:') {
    const module = import('./history/importArchive.js')
    let archive: Awaited<ReturnType<typeof import('./history/importArchive.js').prepareArchive>>
    return {
      async preview(signal) {
        archive = await (await module).prepareArchive(file, signal)
        return archive.preview
      },
      async stage(ids, onProgress, signal) {
        await (await module).importArchive(archive, ids, onProgress, signal)
      },
      close() {},
    }
  }
  const worker = new Worker(new URL('./history/importWorker.ts', import.meta.url), { type: 'module' })
  const request = (
    message: Exclude<ImportRequest, { type: 'cancel' }>,
    signal: AbortSignal,
    onProgress?: ImportProgress
  ) => {
    signal.throwIfAborted()
    return new Promise<ImportPreview | undefined>((resolve, reject) => {
      const cancel = () => worker.postMessage({ type: 'cancel' } satisfies ImportRequest)
      const cleanup = () => {
        signal.removeEventListener('abort', cancel)
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
      }
      const fail = (error: unknown) => {
        cleanup()
        reject(error)
      }
      worker.onmessage = ({ data }: MessageEvent<ImportReply>) => {
        if (data.type === 'progress') {
          if (!signal.aborted) {
            onProgress?.(data.completed, data.total)
          }
          return
        }
        cleanup()
        if (signal.aborted) {
          reject(signal.reason)
        } else if (data.type === 'failed') {
          reject(data.key ? new BackupError(data.key) : new DOMException('', data.name))
        } else {
          resolve(data.type === 'preview' ? data.items : undefined)
        }
      }
      worker.onerror = worker.onmessageerror = () => fail(new BackupError('backupImportReadError'))
      signal.addEventListener('abort', cancel, { once: true })
      try {
        worker.postMessage(message)
      } catch (error) {
        fail(error)
      }
    })
  }
  return {
    async preview(signal) {
      const preview = await request(
        { type: 'preview', file, cacheOnImport: Capacitor.getPlatform() === 'android' },
        signal
      )
      if (!preview) {
        throw new BackupError('backupImportReadError')
      }
      return preview
    },
    async stage(ids, onProgress, signal) {
      await request({ type: 'import', ids }, signal, onProgress)
    },
    close: () => worker.terminate(),
  }
}

export const importHistory = (
  source: HistoryImportSource,
  ids: string[],
  signal: AbortSignal,
  onProgress: ImportProgress,
  onCommit: () => void
): Promise<number> =>
  enqueueBackup(async () => {
    signal.throwIfAborted()
    const existing = new Set(useChatStore.getState().sessions.map((item) => item.id))
    const selected = ids.filter((id) => !existing.has(id))
    if (selected.length === 0) {
      return 0
    }
    return replaceHistory(async () => {
      signal.throwIfAborted()
      await source.stage(selected, onProgress, signal)
      signal.throwIfAborted()
      onCommit()
    }, true)
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
