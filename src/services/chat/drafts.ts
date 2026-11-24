import { create } from 'zustand'
import { useCustomProvider } from '../customProvider.js'
import { openDB, type IDBPDatabase } from 'idb'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  attachmentTaskKey,
  cancelUpload,
  getAttachmentConnection,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  useUploads,
  type AttachmentConnection,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 草稿独立于会话详情缓存并持久化；null 是新对话。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, connection: AttachmentConnection) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    connection,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage
  ).catch(() => {})
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  connection: AttachmentConnection
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const added = files.map((file): DraftAttachment => {
    const image = isImage(resolveMimeType(file))
    return {
      id: createId(),
      file,
      isImage: image,
      previewUrl: image ? URL.createObjectURL(file) : null,
    }
  })
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, connection))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  connection: AttachmentConnection
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, connection)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>, scope?: string) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = scope ? tasks[attachmentTaskKey(attachment.id, scope)] : undefined
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const prepareDraftUploads = (attachments: DraftAttachment[], connection: AttachmentConnection) => {
  for (const attachment of attachments) {
    if (!useUploads.getState().tasks[attachmentTaskKey(attachment.id, connection.scope)]) {
      upload(attachment, connection)
    }
  }
}

const releaseAttachment = (attachment: DraftAttachment, cancel: boolean) => {
  if (cancel) {
    cancelUpload(attachment.id)
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment, true)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/** 发送成功后原件与 serverId 已交给会话，释放预览但保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, false))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, true))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

let draftDB: IDBPDatabase | undefined
let saving: Promise<unknown> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | undefined
export const flushDrafts = () => {
  clearTimeout(timer)
  const db = draftDB
  if (!db) {
    return Promise.resolve()
  }
  const snapshot = [...useDrafts.getState().drafts].map(([id, draft]) => [id, {
    text: draft.text,
    attachments: draft.attachments.map((attachment) => ({ ...attachment, previewUrl: null })),
  }])
  const task = saving.catch(() => {}).then(() => db.put('drafts', snapshot, 'all'))
  saving = task
  return task
}
export const initializeDrafts = async (deadline: Promise<never>) => {
  const opening = openDB('deepchat-drafts', 1, {
    upgrade(database) { database.createObjectStore('drafts') },
  })
  const reading = opening.then(async (db) => ({
    db,
    saved: await db.get('drafts', 'all') as [string | null, Draft][] | undefined,
  }))
  const { db, saved } = await Promise.race([reading, deadline]).catch((error: unknown) => {
    void opening.then((db) => db.close(), () => {})
    throw error
  })
  const connection = useCustomProvider.getState().enabled ? undefined : getAttachmentConnection()
  const drafts = new Map(saved ?? [])
  for (const draft of drafts.values()) {
    for (const attachment of draft.attachments) {
      attachment.previewUrl = attachment.isImage ? URL.createObjectURL(attachment.file) : null
    }
    if (connection) {prepareDraftUploads(draft.attachments, connection)}
  }
  useDrafts.setState({ drafts })
  draftDB = db
  useDrafts.subscribe(() => {
    clearTimeout(timer)
    timer = setTimeout(() => { void flushDrafts().catch(() => {}) }, 200)
  })
  window.addEventListener('pagehide', () => { void flushDrafts().catch(() => {}) })
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
  }
  useDrafts.setState({ drafts: new Map() })
}
