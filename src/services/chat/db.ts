import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Folder, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
export const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string; folderId: string }
  }
  /** 本地会话分组；不写入官方历史导出。 */
  folders: { key: string; value: Folder }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

/**
 * 返回本次操作后已无任何会话摘要引用的原件 ID。
 * 删除会话前先删摘要，再调用此函数；fork 共享的 file.id 会因另一份摘要仍引用而被保留。
 */
export const unreferencedFileIds = (
  candidates: Iterable<string>,
  summaries: Iterable<{ fileIds: readonly string[] }>
): string[] => {
  const referenced = new Set<string>()
  for (const summary of summaries) {
    for (const id of summary.fileIds) {
      referenced.add(id)
    }
  }
  return [...new Set(candidates)].filter((id) => !referenced.has(id))
}

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' })
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      if (!summaries.indexNames.contains('folderId')) {
        summaries.createIndex('folderId', 'folderId')
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadFolders = async (): Promise<Folder[]> =>
  (await (await getDB()).getAll('folders')).sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name)
  )

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const loadAllSessions = async (): Promise<Session[]> =>
  (await getDB()).getAll('sessions')

export type SyncDbChanges = {
  sessions: Session[]
  deleteSessionIds: string[]
  folders: Folder[]
  deleteFolderIds: string[]
  files?: StoredFile[]
}

/**
 * 同步引擎的原子应用入口：会话、摘要、分组和附件原件在同一事务内提交。
 * 删除分组只解除会话归属；删除会话时仍按摘要引用释放无人使用的原件。
 */
export const applySyncChanges = async ({
  sessions: changedSessions,
  deleteSessionIds,
  folders,
  deleteFolderIds,
  files = [],
}: SyncDbChanges): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'folders', 'files'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const summaries = tx.objectStore('sessionSummaries')
        const candidates = new Set<string>()
        for (const id of new Set(deleteSessionIds)) {
          const summary = await summaries.get(id)
          for (const fileId of summary?.fileIds ?? []) {
            candidates.add(fileId)
          }
          await sessions.delete(id)
          await summaries.delete(id)
        }
        for (const folderId of new Set(deleteFolderIds)) {
          const keys = await summaries.index('folderId').getAllKeys(folderId)
          for (const key of keys) {
            const id = String(key)
            const summary = await summaries.get(id)
            const session = await sessions.get(id)
            if (summary) {
              await summaries.put({ ...summary, folderId: null })
            }
            if (session) {
              await sessions.put({ ...session, folderId: null })
            }
          }
          await tx.objectStore('folders').delete(folderId)
        }
        for (const folder of folders) {
          await tx.objectStore('folders').put(folder)
        }
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        for (const session of changedSessions) {
          const nextSummary = storedSummary(session)
          const previous = await summaries.get(session.id)
          for (const fileId of previous?.fileIds ?? []) {
            if (!nextSummary.fileIds.includes(fileId)) {
              candidates.add(fileId)
            }
          }
          await sessions.put(session)
          await summaries.put(nextSummary)
        }
        const released = unreferencedFileIds(candidates, await summaries.getAll())
        for (const id of released) {
          await tx.objectStore('files').delete(id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const previousSummary = await summaries.get(session.id)
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await summaries.put(summary)
        // 若会话内删除了包含附件的轮次，在同一事务中清理不再被任何会话引用的本地原件
        const released = unreferencedFileIds(
          (previousSummary?.fileIds ?? []).filter((id) => !summary.fileIds.includes(id)),
          await summaries.getAll()
        )
        for (const id of released) {
          await tx.objectStore('files').delete(id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 原子更新未加载会话的详情与摘要。 */
export const updateSessionMetadata = async (
  id: string,
  patch: Partial<Pick<Session, 'title' | 'pinned' | 'folderId'>>
): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          Object.assign(session, patch)
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const saveFolder = async (folder: Folder): Promise<void> => {
  await (await getDB()).put('folders', folder)
}

/** 删除分组并把其下会话原子地移回未分组；不会删除会话、消息或附件。 */
export const deleteFolder = async (folderId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['folders', 'sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const keys = await summaries.index('folderId').getAllKeys(folderId)
        for (const key of keys) {
          const id = String(key)
          const summary = await summaries.get(id)
          const session = await tx.objectStore('sessions').get(id)
          if (summary) {
            await summaries.put({ ...summary, folderId: null })
          }
          if (session) {
            await tx.objectStore('sessions').put({ ...session, folderId: null })
          }
        }
        await tx.objectStore('folders').delete(folderId)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 批量移动会话；只改分组元数据，不更新时间、不触碰消息与附件。 */
export const moveSessionsToFolder = async (
  ids: readonly string[],
  folderId: string | null
): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const summaries = tx.objectStore('sessionSummaries')
        for (const id of new Set(ids)) {
          const summary = await summaries.get(id)
          const session = await sessions.get(id)
          if (summary) {
            await summaries.put({ ...summary, folderId })
          }
          if (session) {
            await sessions.put({ ...session, folderId })
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        const released = unreferencedFileIds(summary?.fileIds ?? [], await summaries.getAll())
        for (const id of released) {
          await tx.objectStore('files').delete(id)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

export const mergeStaging = async (): Promise<SessionSummary[]> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const merge = async () => {
    try {
      for (
        let cursor = await tx.objectStore('sessionsStaging').openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        if (await tx.objectStore('sessions').getKey(cursor.key)) {
          continue
        }
        await tx.objectStore('sessions').add(cursor.value)
        await tx.objectStore('sessionSummaries').add(storedSummary(cursor.value))
      }
      for (
        let cursor = await tx.objectStore('filesStaging').openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        if (!(await tx.objectStore('files').getKey(cursor.key))) {
          await tx.objectStore('files').add(cursor.value)
        }
      }
      await tx.objectStore('sessionsStaging').clear()
      await tx.objectStore('filesStaging').clear()
      return (await tx.objectStore('sessionSummaries').getAll()).map(toSessionSummary)
    } catch (error) {
      abortTransaction(tx)
      throw error
    }
  }
  const [summaries] = await Promise.all([merge(), tx.done])
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
