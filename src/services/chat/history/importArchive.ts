import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir, sessionPath } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import { ArchiveError, isZipFile, openArchive, readEntry, type ArchiveEntry } from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry, signal?: AbortSignal): Promise<unknown> => {
  const text = await (await readEntry(entry, signal)).text()
  signal?.throwIfAborted()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

export type ImportPreview = { id: string; title: string; messages: number }[]
export type ImportProgress = (completed: number, total: number) => void

export const prepareArchive = async (file: File, signal?: AbortSignal) => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    const entries = await openArchive(file)
    signal?.throwIfAborted()
    const manifest = entries.get(MANIFEST_PATH) ?? fail('backupUnrecognized')
    checkManifest(await readJson(manifest, signal))
    const index = entries.get(INDEX_PATH) ?? fail('backupIncomplete')
    const sessions = readSessionIndex(await readJson(index, signal))
    const ids = new Set<string>()
    const folders = new Set<string>()
    for (const { id } of sessions) {
      if (ids.has(id) || !entries.has(sessionPath(id))) {
        fail('backupIncomplete')
      }
      ids.add(id)
      folders.add(sessionFilesDir(id))
    }
    for (const path of entries.keys()) {
      if (path === MANIFEST_PATH || path === INDEX_PATH || path === USER_PATH) {
        continue
      }
      const sessionId = parseSessionPath(path)
      const folder = path.slice(0, path.indexOf('/', 'chat_sessions/'.length) + 1)
      if (sessionId === null ? !folders.has(folder) : !ids.has(sessionId)) {
        fail('backupIncomplete')
      }
    }
    const preview: ImportPreview = sessions.map(({ id, title, message_count }) => ({
      id,
      title: title ?? '',
      messages: message_count,
    }))
    return { entries, preview }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}

/** 校验选中的会话和引用的图片，逐项写入暂存，由调用方统一提交或回滚。 */
export const importArchive = async (
  archive: Awaited<ReturnType<typeof prepareArchive>>,
  ids: string[],
  onProgress: ImportProgress,
  signal?: AbortSignal
): Promise<void> => {
  const { entries } = archive
  const namespace = `${crypto.randomUUID()}:`
  const stored = new Map<string, string>()
  onProgress(0, ids.length)
  try {
    for (const [index, id] of ids.entries()) {
      signal?.throwIfAborted()
      const entry = entries.get(sessionPath(id)) ?? fail('backupIncomplete')
      const local = toLocalSession(readSessionFile(await readJson(entry, signal)))
      if (local.session.id !== id) {
        fail('backupIncomplete')
      }
      for (const message of local.session.messages) {
        if (message.role === 'user') {
          for (const file of message.files) {
            file.id = namespace + file.id
          }
        }
      }
      for (const [path, fileId] of local.images) {
        signal?.throwIfAborted()
        const image = entries.get(path)
        const namespacedId = namespace + fileId
        if (!image) {
          continue
        }
        const data = await readEntry(image, signal)
        if (!stored.has(namespacedId)) {
          const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
          await db.saveStagingFiles([{ id: namespacedId, blob: new Blob([data], { type }) }])
          stored.set(namespacedId, type)
        }
      }
      signal?.throwIfAborted()
      for (const message of local.session.messages) {
        if (message.role === 'user') {
          for (const file of message.files) {
            file.mimeType = stored.get(file.id) ?? ''
          }
        }
      }
      await db.addStagingSession(local.session)
      onProgress(index + 1, ids.length)
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}
