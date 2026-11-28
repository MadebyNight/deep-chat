import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { translate } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  API_ORIGIN,
  ApiError,
  streamCustomMessage,
  streamMessage,
  streamOfficialMessage,
  type CustomMessage,
} from '../api/client.js'
import type { CreateMessageRequest, MessageStreamEvent } from '../api/types.js'
import {
  deepSeekRates,
  OFFICIAL_API_ORIGIN,
  tokenUsageCost,
  type TokenRates,
} from '../api/tokenPricing.js'
import {
  matchesChatProvider,
  providerRoute,
  useCustomProvider,
  type CustomProvider,
} from '../customProvider.js'
import { ensureChatConnection } from '../../components/settings/settingsDialogState.js'
import {
  extractFileIds,
  getFileErrorCode,
  isInputContextOverflow,
  isRetryableApiError,
  isTransientChatError,
} from '../api/errors.js'
import {
  CHAT_RETRY_BASE_DELAY_MS,
  streamWithPreContentRetry,
  type StreamRetryNotice,
} from '../api/streamRetry.js'
import {
  attachmentTaskKey, cancelUpload, describeUploadError, getAttachmentConnection, LEGACY_KEY_FILE_SCOPE,
  uploadAttachment, useUploads, type AttachmentConnection,
} from '../attachments.js'
import { getSelectedPrompt, useSettings, type PromptPreset } from '../settings.js'
import {
  createAnthropicRequest,
  isChatModel,
  normalizeGenerationParams,
  type GenerationParams,
} from '../generation.js'
import {
  appendBranch,
  forkVisibleBranch,
  getVisibleMessages,
  normalizeSession,
  removeTurns as removeSessionTurns,
  selectVersion,
} from './branches.js'
import * as db from './db.js'
import {
  compactContext,
  ContextPreparationError,
  estimateMessages,
  inputBudget,
  selectContext,
  summarizeContext,
} from './compaction.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import { createHandoffSession, customSummaryMessages } from './handoff.js'
import { buildSessionSystemPrompt } from './systemPrompt.js'
import { loadMemoryPrompt } from '../memory/store.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyText,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Folder,
  type Message,
  type MessageRoute,
  type ReplyBlock,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'
import { searchExternal } from '../search/externalSearch.js'
import { isExternalSearchConfigured, useExternalTools } from '../tools/config.js'
import {
  buildMcpToolCatalog,
  externalSearchTool,
  executeMcpTool,
  EXTERNAL_SEARCH_TOOL,
  toolRequiresConfirmation,
  validateToolArguments,
} from '../tools/runtime.js'
import { clearToolConfirmations, requestToolConfirmation } from '../tools/confirmation.js'
import {
  assistantToolMessage,
  collectToolCalls,
  externalSearchFailureBlock,
  externalSearchResultBlock,
  externalSearchUseBlock,
  formatSearchToolResult,
  MAX_TOOL_ROUNDS,
  roundText,
  toCustomToolCall,
  toolErrorMessage,
  toolResultMessage,
} from './toolCalling.js'

/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  folders: Folder[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  folders: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)

const sortFolders = (folders: Folder[]) =>
  [...folders].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  !!a.pinned === !!b.pinned &&
  (a.folderId ?? null) === (b.folderId ?? null)

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
const sessionSaveTasks = new Map<string, Promise<void>>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    const saving = db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
    sessionSaveTasks.set(sessionId, saving)
    void saving.finally(() => {
      if (sessionSaveTasks.get(sessionId) === saving) {
        sessionSaveTasks.delete(sessionId)
      }
    })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
const flushPendingChat = () => {
  if (get().importingHistory) {
    return
  }
  for (const [id, flush] of streamFlushes) {
    flush()
    persist(id)
  }
  for (const id of unsavedSessions) {
    if (!streamFlushes.has(id)) {
      persist(id)
    }
  }
}

export const bindChatPersistence = () => {
  const save = () => flushPendingChat()
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 同步前把流式增量与待保存会话落盘；生成中返回 false。 */
export const flushChatForSync = async (): Promise<boolean> => {
  if (Object.keys(get().streaming).length > 0) {
    return false
  }
  while (deletionTasks.size > 0) {
    await Promise.allSettled([...deletionTasks])
  }
  flushPendingChat()
  while (sessionSaveTasks.size > 0) {
    await Promise.allSettled([...sessionSaveTasks.values()])
  }
  return unsavedSessions.size === 0 && Object.keys(get().streaming).length === 0
}

/** 借用历史替换的全局写锁，避免同步导入与发送/分组修改交错。 */
export const acquireChatStorageLock = (): boolean => {
  if (get().importingHistory || Object.keys(get().streaming).length > 0) {
    return false
  }
  set({ importingHistory: true })
  return true
}

export const releaseChatStorageLock = () => {
  set({ importingHistory: false })
  retrySaveSessions()
}

/**
 * 同步写入数据库后重建列表与已加载会话缓存。
 * 必须持有 acquireChatStorageLock 返回的锁；这里不检查 importingHistory。
 */
export const refreshChatAfterSync = async (): Promise<void> => {
  historyEpoch += 1
  sessionLoads.clear()
  sessionAccess.clear()
  const [summaries, folders] = await Promise.all([db.loadSessionSummaries(), db.loadFolders()])
  set({
    ready: true,
    initError: false,
    sessions: sortSessions(summaries),
    folders: sortFolders(folders),
    sessionCache: {},
    sessionLoadErrors: {},
    sessionSaveErrors: {},
  })
  const activeId = get().activeId
  if (activeId !== null && !summaries.some((session) => session.id === activeId)) {
    set({ activeId: null })
  } else if (activeId !== null) {
    void ensureSessionLoaded(activeId)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (connection: ChatConnection, generation: GenerationParams): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  const externalSearch =
    connection.kind === 'custom' &&
    search &&
    isExternalSearchConfigured(useExternalTools.getState().search)
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: connection.kind === 'deepseek' ? generation.model : connection.provider.model,
    generation,
    thinking,
    search: connection.kind === 'deepseek' ? search : externalSearch,
    prefix: connection.kind === 'deepseek',
    status: 'pending',
    blocks: [],
    ...(connection.kind === 'custom'
      ? {
          route: routeInfo(
            connection.routes[0]?.provider ?? connection.provider,
            connection.routes[0]?.provider.id !== connection.provider.id,
            connection.provider
          ),
        }
      : {}),
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const [summaries, folders] = await Promise.all([db.loadSessionSummaries(), db.loadFolders()])
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries), folders: sortFolders(folders) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (
  write: () => Promise<void>,
  merge = false
): Promise<number> => {
  const previousCount = get().sessions.length
  const previousActive = get().activeId
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    if (merge) {
      await Promise.all(
        [...unsavedSessions].map(async (id) => {
          const session = getSession(id)
          if (session) {
            await db.saveSession(session, pendingFiles.get(id))
          }
        })
      )
    }
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await (merge ? db.mergeStaging() : db.commitStaging())
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    if (!merge) {
      clearAllDrafts()
    }
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: merge ? previousActive : null,
    })
    return merge ? summaries.length - previousCount : summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.updateSessionMetadata(id, { title }).catch(db.reportStorageError('rename session'))
  }
}

export const toggleSessionPinned = async (id: string) => {
  const summary = get().sessions.find((session) => session.id === id)
  if (!summary || get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const pinned = !summary.pinned
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, pinned }))
    persist(id)
    return
  }
  // Publish the preference synchronously so a concurrent session load inherits it.
  set((state) => ({
    sessions: sortSessions(
      state.sessions.map((item) => (item.id === id ? { ...item, pinned } : item))
    ),
  }))
  try {
    await db.updateSessionMetadata(id, { pinned })
  } catch (error) {
    db.reportStorageError('pin session')(error)
    if (get().importingHistory || deletingSessions.has(id)) {
      return
    }
    if (getSession(id)) {
      persist(id)
    } else {
      set((state) => ({
        sessions: sortSessions(
          state.sessions.map((item) =>
            item.id === id && item.pinned === pinned ? { ...item, pinned: summary.pinned } : item
          )
        ),
      }))
      showToast({ key: 'sessionSaveFailed', type: 'error' })
    }
  }
}

export type FolderMutationResult = 'ok' | 'empty' | 'duplicate' | 'missing' | 'failed'

const folderNameMatches = (folders: Folder[], name: string, exceptId?: string) => {
  const normalized = name.toLocaleLowerCase()
  return folders.some(
    (folder) => folder.id !== exceptId && folder.name.trim().toLocaleLowerCase() === normalized
  )
}

export const createFolder = async (name: string): Promise<FolderMutationResult> => {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'empty'
  }
  if (get().importingHistory || folderNameMatches(get().folders, trimmed)) {
    return get().importingHistory ? 'failed' : 'duplicate'
  }
  const folder: Folder = {
    id: createId(),
    name: trimmed,
    createdAt: Date.now(),
    order: Math.max(-1, ...get().folders.map((item) => item.order)) + 1,
  }
  try {
    await db.saveFolder(folder)
    set((state) => ({ folders: sortFolders([...state.folders, folder]) }))
    return 'ok'
  } catch (error) {
    db.reportStorageError('create folder')(error)
    return 'failed'
  }
}

export const renameFolder = async (id: string, name: string): Promise<FolderMutationResult> => {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'empty'
  }
  const folder = get().folders.find((item) => item.id === id)
  if (!folder || get().importingHistory) {
    return 'missing'
  }
  if (folderNameMatches(get().folders, trimmed, id)) {
    return 'duplicate'
  }
  const next = { ...folder, name: trimmed }
  try {
    await db.saveFolder(next)
    set((state) => ({
      folders: sortFolders(state.folders.map((item) => (item.id === id ? next : item))),
    }))
    return 'ok'
  } catch (error) {
    db.reportStorageError('rename folder')(error)
    return 'failed'
  }
}

/** 删除分组只解除会话归属；会话、消息和附件均保留。 */
export const deleteFolder = async (id: string): Promise<boolean> => {
  if (get().importingHistory || !get().folders.some((folder) => folder.id === id)) {
    return false
  }
  try {
    await db.deleteFolder(id)
    set((state) => ({
      folders: state.folders.filter((folder) => folder.id !== id),
      sessions: state.sessions.map((session) =>
        session.folderId === id ? { ...session, folderId: null } : session
      ),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).map(([sessionId, session]) => [
          sessionId,
          session.folderId === id ? { ...session, folderId: null } : session,
        ])
      ),
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete folder')(error)
    return false
  }
}

export const moveSessionsToFolder = async (
  ids: readonly string[],
  folderId: string | null
): Promise<boolean> => {
  if (
    get().importingHistory ||
    ids.length === 0 ||
    (folderId !== null && !get().folders.some((folder) => folder.id === folderId))
  ) {
    return false
  }
  const selected = new Set(ids)
  try {
    await db.moveSessionsToFolder(ids, folderId)
    set((state) => ({
      sessions: state.sessions.map((session) =>
        selected.has(session.id) ? { ...session, folderId } : session
      ),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).map(([sessionId, session]) => [
          sessionId,
          selected.has(sessionId) ? { ...session, folderId } : session,
        ])
      ),
    }))
    return true
  } catch (error) {
    db.reportStorageError('move sessions to folder')(error)
    return false
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 改变会话绑定的人设，只影响后续轮次；不重写任何历史回答。
 * preset 为 null 时显式使用默认助手。
 */
export const setSessionPrompt = (sessionId: string, preset: PromptPreset | null): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId) || !getSession(sessionId)) {
    return false
  }
  updateSession(sessionId, (session) => ({
    ...session,
    systemPromptId: preset?.id ?? null,
    ...(preset
      ? { systemPromptSnapshot: preset.body }
      : { systemPromptSnapshot: undefined }),
  }))
  persist(sessionId)
  return true
}

type CustomProviderRoute = { provider: CustomProvider; rates?: TokenRates }

type ChatConnection =
  | { kind: 'deepseek'; attachment: AttachmentConnection | undefined }
  | {
      kind: 'custom'
      provider: CustomProvider
      routes: CustomProviderRoute[]
      stickyProvider: boolean
    }

const chatConnectionFor = (session?: Session): ChatConnection | undefined => {
  const { enabled, provider, rates, ratesById, ...settings } = useCustomProvider.getState()
  if (enabled && !provider) {
    ensureChatConnection()
    return
  }
  if (session && !matchesChatProvider(session.customProviderId, enabled, provider?.id)) {
    showToast({ key: 'customProviderSessionMismatch' })
    return
  }
  return enabled && provider
    ? {
        kind: 'custom',
        provider,
        stickyProvider: settings.stickyProvider,
        routes: providerRoute({ ...settings, activeId: provider.id }, session?.pinnedProviderId).map(
          (candidate) => ({
            provider: candidate,
            rates: ratesById[candidate.id] ?? (candidate.id === provider.id ? rates : undefined),
          })
        ),
      }
    : { kind: 'deepseek', attachment: getAttachmentConnection() }
}

const providerLabel = (provider: CustomProvider) =>
  `${new URL(provider.baseUrl).host} · ${provider.model}`

const generationFor = (session?: Session) =>
  normalizeGenerationParams(session?.generation ?? useSettings.getState().generationParams)

const routeInfo = (
  provider: CustomProvider,
  fallback: boolean,
  primary?: CustomProvider
): MessageRoute => ({
  providerId: provider.id,
  providerName: new URL(provider.baseUrl).host,
  model: provider.model,
  fallback,
  ...(fallback && primary && primary.id !== provider.id
    ? {
        fallbackFrom: {
          providerId: primary.id,
          providerName: new URL(primary.baseUrl).host,
        },
      }
    : {}),
})

const withUsageCost = (reply: AssistantMessage, rates?: TokenRates): AssistantMessage => {
  const cost = reply.usage ? tokenUsageCost(reply.usage, rates) : undefined
  return {
    ...reply,
    retry: undefined,
    ...(cost ?? { costNanos: undefined, cacheSavedNanos: undefined }),
  }
}

const retryNotice = (notice: StreamRetryNotice): AssistantMessage['retry'] => ({
  attempt: notice.attempt,
  maxAttempts: notice.maxRetries,
  phase: 'retry',
})

const waitForChannel = (delayMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const chatConnection = chatConnectionFor(targetSessionId === null ? undefined : getSession(targetSessionId))
  if (!chatConnection) {return false}
  const connection = chatConnection.kind === 'deepseek' ? chatConnection.attachment : undefined
  if (chatConnection.kind === 'deepseek' && !connection) {return false}
  const draft = getDraft(targetSessionId)
  if (chatConnection.kind === 'custom' && draft.attachments.length > 0) {
    showToast({ key: 'customProviderTextOnly' })
    return false
  }
  const prepared = prepareDraftMessage(draft, useUploads.getState().tasks, connection?.scope)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const selectedPrompt = getSelectedPrompt(useSettings.getState().prompts)
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      systemPromptId: selectedPrompt?.id ?? null,
      ...(selectedPrompt ? { systemPromptSnapshot: selectedPrompt.body } : {}),
      ...(chatConnection.kind === 'custom'
        ? {
            customProviderId: chatConnection.provider.id,
            ...(chatConnection.stickyProvider
              ? { pinnedProviderId: chatConnection.provider.id }
              : {}),
          }
        : {}),
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const generation = generationFor(current)
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: connection ? files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId: connection.apiKey === null ? null : serverId,
      ...(connection.apiKey === null
        ? { accountFile: { id: serverId, scope: connection.scope } }
        : { serverIdScope: connection.scope }),
      name,
      size,
      isImage,
      mimeType,
    })) : [],
    createdAt: now,
  }
  const reply = createReply(chatConnection, generation)
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question }, chatConnection)
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const generation = generationFor(session)
  const chatConnection = chatConnectionFor(session)
  if (!chatConnection) {return}
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply(chatConnection, generation)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question }, chatConnection)
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const generation = generationFor(session)
  const chatConnection = chatConnectionFor(session)
  if (!chatConnection) {return false}
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply(chatConnection, generation)
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question }, chatConnection)
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 按轮删除对话（含其重新生成的回复版本），后文自动接上；流式生成与导入/整段删除期间禁止操作。 */
export const removeTurns = (sessionId: string, userIds: readonly string[]): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId) || userIds.length === 0) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const next = removeSessionTurns(session, new Set(userIds))
  if (next === session) {
    return false
  }
  updateSession(sessionId, () => ({ ...next, updatedAt: Date.now() }))
  persist(sessionId)
  return true
}

const insertSession = (session: Session) => {
  touchSession(session.id)
  set((state) => ({
    sessions: sortSessions([toSessionSummary(session), ...state.sessions]),
    sessionCache: { ...state.sessionCache, [session.id]: session },
    activeId: session.id,
  }))
  persist(session.id)
}

/** 从当前可见消息节点创建独立会话；目标为用户消息时包含当前选中的回答。 */
export const forkSession = (sessionId: string, messageId: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const source = getSession(sessionId)
  if (!source || getStreamController(sessionId)) {
    return false
  }
  const branch = forkVisibleBranch(source, messageId)
  if (!branch) {
    showToast({ key: 'forkChatFailed', type: 'error' })
    return false
  }
  const now = Date.now()
  const session: Session = {
    id: createId(),
    title: translate('forkedChatTitle', {
      title: source.title || translate('untitledChat'),
    }),
    createdAt: now,
    updatedAt: now,
    pinned: false,
    folderId: source.folderId ?? null,
    messages: branch.messages,
    rootMessageId: branch.rootMessageId,
    ...(branch.contextCheckpoint ? { contextCheckpoint: branch.contextCheckpoint } : {}),
    ...(branch.handoff ? { handoff: branch.handoff } : {}),
    ...(source.customProviderId ? { customProviderId: source.customProviderId } : {}),
  }
  insertSession(session)
  showToast({ key: 'forkChatCreated' })
  return true
}

export type SummaryHandoffResult =
  | { ok: true; sessionId: string }
  | {
      ok: false
      reason:
        | 'busy'
        | 'empty'
        | 'connection'
        | 'cancelled'
        | 'changed'
        | 'tooLong'
        | 'summaryFailed'
    }

const summaryHandoffTasks = new Map<string, AbortController>()

/** 取消正在进行的摘要续聊；只会中止摘要请求，原会话保持不变。 */
export const cancelSummaryHandoff = (sessionId: string) => {
  summaryHandoffTasks.get(sessionId)?.abort()
}

const summaryStreamFor = (connection: ChatConnection) => {
  if (connection.kind === 'custom') {
    return (body: CreateMessageRequest, signal: AbortSignal) =>
      streamCustomMessage(
        connection.provider,
        customSummaryMessages(body),
        signal,
        connection.routes[0]?.rates,
        { thinking: false }
      )
  }
  if (!connection.attachment) {
    return null
  }
  const attachment = connection.attachment
  return attachment.apiKey === null
    ? streamOfficialMessage
    : (body: CreateMessageRequest, signal: AbortSignal) =>
        streamMessage(attachment.apiKey ?? '', body, signal)
}

/**
 * 手动总结当前可见对话并创建带摘要的新会话。
 * 摘要复用 compaction 的分批和取消边界；只有完整成功后才会写入新会话，原会话不变。
 */
export const createSummaryHandoff = async (sessionId: string): Promise<SummaryHandoffResult> => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    summaryHandoffTasks.has(sessionId)
  ) {
    return { ok: false, reason: 'busy' }
  }
  const source = getSession(sessionId)
  if (!source || getStreamController(sessionId)) {
    return { ok: false, reason: 'busy' }
  }
  const path = getVisibleMessages(source)
  if (getContextRounds(path).length === 0) {
    return { ok: false, reason: 'empty' }
  }
  const connection = chatConnectionFor(source)
  if (!connection) {
    return { ok: false, reason: 'connection' }
  }
  if (connection.kind === 'deepseek' && !connection.attachment) {
    ensureChatConnection()
    return { ok: false, reason: 'connection' }
  }
  const stream = summaryStreamFor(connection)
  if (!stream) {
    return { ok: false, reason: 'connection' }
  }

  const controller = new AbortController()
  summaryHandoffTasks.set(sessionId, controller)
  const epoch = historyEpoch
  try {
    const context = await selectContext(path, source.contextCheckpoint)
    const prior = [source.handoff?.summary, context.summary]
      .map((summary) => summary?.trim())
      .filter((summary): summary is string => !!summary)
      .join('\n\n')
    controller.signal.throwIfAborted()
    const lastReply = [...path]
      .reverse()
      .find((message): message is AssistantMessage => message.role === 'assistant')
    const summary = await summarizeContext(
      { ...context, summary: prior || undefined },
      {
        model: isChatModel(lastReply?.model) ? lastReply.model : generationFor(source).model,
        safety_check: SAFETY_CHECK,
      },
      connection.kind === 'custom'
        ? inputBudget(true)
        : inputBudget(connection.attachment?.apiKey === null),
      stream,
      controller.signal
    )
    controller.signal.throwIfAborted()
    if (
      epoch !== historyEpoch ||
      get().importingHistory ||
      deletingSessions.has(sessionId) ||
      !getSession(sessionId)
    ) {
      return { ok: false, reason: 'changed' }
    }
    const now = Date.now()
    const session = createHandoffSession(
      source,
      summary,
      createId(),
      translate('handoffChatTitle', {
        title: source.title || translate('untitledChat'),
      }),
      now
    )
    insertSession(session)
    return { ok: true, sessionId: session.id }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, reason: 'cancelled' }
    }
    if (error instanceof ContextPreparationError) {
      return {
        ok: false,
        reason: error.reason === 'tooLong' ? 'tooLong' : 'summaryFailed',
      }
    }
    db.reportStorageError('summarize handoff')(error)
    return { ok: false, reason: 'summaryFailed' }
  } finally {
    if (summaryHandoffTasks.get(sessionId) === controller) {
      summaryHandoffTasks.delete(sessionId)
    }
  }
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const chatConnection = chatConnectionFor(session)
  if (chatConnection?.kind !== 'deepseek') {return}
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const generation = normalizeGenerationParams(previous.generation, generationFor(session))
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? generation.model,
    generation,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous }, chatConnection)
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const chatConnection = chatConnectionFor(session)
  if (chatConnection?.kind !== 'deepseek') {return}
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question }, chatConnection)
}

/** 更新会话级生成参数；null 表示恢复跟随全局默认。 */
export const setSessionGeneration = (
  sessionId: string,
  generation: GenerationParams | null
): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  if (!getSession(sessionId)) {
    return false
  }
  updateSession(sessionId, (session) => ({
    ...session,
    generation: generation === null ? undefined : normalizeGenerationParams(generation),
  }))
  persist(sessionId)
  return true
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string | null>, connection: AttachmentConnection) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const id = serverIds.get(file.id)
              if (id === undefined) { return file }
              return connection.apiKey === null
                ? { ...file, accountFile: id ? { id, scope: connection.scope } : undefined }
                : { ...file, serverId: id, serverIdScope: connection.scope }
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const serverIdFor = (file: FileAttachment, connection: AttachmentConnection) => {
  if (connection.apiKey === null) {
    return file.accountFile?.scope === connection.scope ? file.accountFile.id : null
  }
  return (file.serverIdScope ?? LEGACY_KEY_FILE_SCOPE) === connection.scope ? file.serverId : null
}

const ensureServerId = async (connection: AttachmentConnection, file: FileAttachment): Promise<string | null> => {
  const serverId = serverIdFor(file, connection)
  if (serverId) {
    return serverId
  }
  const task = useUploads.getState().tasks[attachmentTaskKey(file.id, connection.scope)]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(connection, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (
  sessionId: string,
  request: Request,
  connection: AttachmentConnection,
  signal: AbortSignal
) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const serverIds = new Map<string, string | null>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(connection, file)
      if (serverId && serverId !== serverIdFor(file, connection)) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds, connection)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).slice().reverse()) {
    for (const file of user.files) {
      if (!serverIdFor(file, connection) && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(connection, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]), connection)
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 请求快照只引用当前凭据上传的文件。
  const resolveUserFiles = (message: UserMessage): UserMessage => ({
    ...message,
    files: message.files.map((file) => ({
      ...file,
      serverId: serverIds.get(file.id) ?? serverIdFor(file, connection),
    })),
  })
  return {
    history: request.history.map((message) => message.role === 'user' ? resolveUserFiles(message) : message),
    question: resolveUserFiles(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (
  sessionId: string, request: Request, error: unknown, connection: AttachmentConnection
): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const sentIds = collectServerFileIds(request)
  const targets =
    mentioned.length > 0 ? new Set(mentioned.filter((id) => sentIds.has(id))) : sentIds
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const invalid = new Map<string, null>()
  for (const message of session.messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      const id = serverIdFor(file, connection)
      if (id && targets.has(id)) {
        invalid.set(file.id, null)
      }
    }
  }
  invalid.forEach((_, id) => cancelUpload(id, connection.scope))
  saveServerIds(sessionId, invalid, connection)
  return invalid.size > 0
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

const updateClientTool = (
  reply: AssistantMessage,
  toolUseId: string,
  update: (block: Extract<ReplyBlock, { type: 'client_tool_use' }>) => ReplyBlock
): AssistantMessage => ({
  ...reply,
  blocks: reply.blocks.map((block) =>
    block.type === 'client_tool_use' && block.id === toolUseId ? update(block) : block
  ),
})

const appendReplyBlock = (reply: AssistantMessage, block: ReplyBlock): AssistantMessage => ({
  ...reply,
  blocks: [...reply.blocks, block],
})

const appendClientToolResult = (
  reply: AssistantMessage,
  toolUseId: string,
  content: string,
  isError: boolean,
  denied = false
): AssistantMessage =>
  appendReplyBlock(reply, {
    type: 'client_tool_result',
    tool_use_id: toolUseId,
    content,
    isError,
    ...(denied ? { denied: true } : {}),
  })

const searchQuery = (input: Record<string, unknown>) =>
  typeof input.query === 'string' ? input.query.trim().slice(0, 1000) : ''

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (
  sessionId: string, initial: AssistantMessage, request: Request, chatConnection: ChatConnection
) => {
  const controller = new AbortController()
  const confirmationOwner = initial.id
  const connection = chatConnection.kind === 'deepseek' ? chatConnection.attachment : undefined
  if (chatConnection.kind === 'deepseek' && !getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)
  const blockIndexes = new Map<number, number>()
  const apply = (event: MessageStreamEvent) => {
    reply = applyEvent(reply, event, Date.now(), blockIndexes)
    if (document.visibilityState === 'hidden') {
      flush()
    } else {
      frame ||= requestAnimationFrame(flush)
    }
  }

  const settings = useSettings.getState()
  const session = getSession(sessionId)
  // 记忆只在本机读取；失败或超预算时静默退回纯人设，不阻断主对话。
  const memory = settings.memoryEnabled
    ? await loadMemoryPrompt(request.question.content).catch(() => null)
    : null
  // 固定为「会话人设」→「长期记忆」，不另建 System 拼装链。
  const system = buildSessionSystemPrompt(session, settings.prompts, { memory })
  const official = connection?.apiKey === null
  const stream = official
    ? streamOfficialMessage
    : (body: CreateMessageRequest, signal: AbortSignal) => streamMessage(connection?.apiKey ?? '', body, signal)
  const budget = inputBudget(official)
  const latestReminder = request.prefix
    ? request.prefix.latestReminder
    : createLatestReminder(settings)
  const fallbackGeneration = generationFor(getSession(sessionId))
  const generation = normalizeGenerationParams(initial.generation, {
    ...fallbackGeneration,
    model: isChatModel(initial.model) ? initial.model : fallbackGeneration.model,
  })
  const options = createAnthropicRequest(
    {
      system,
      messages: [],
      thinking: { type: initial.thinking ? ('enabled' as const) : ('disabled' as const) },
      safety_check: SAFETY_CHECK,
      tools: serverTools(initial.search ?? false),
    },
    generation,
    { officialAccount: official, thinking: !!initial.thinking }
  )
  const withHandoffSummary = (summary?: string) =>
    [getSession(sessionId)?.handoff?.summary, summary]
      .map((item) => item?.trim())
      .filter((item): item is string => !!item)
      .join('\n\n') || undefined
  const estimateBody = (history: Message[], summary?: string) => ({
    ...options,
    messages: estimateMessages(
      history,
      request.question,
      request.prefix,
      !!initial.thinking,
      latestReminder,
      withHandoffSummary(summary)
    ),
  })
  const epoch = historyEpoch
  let forceCompact = false
  let retriedOverflow = false
  let fileRetries = 0
  let usedRates: TokenRates | undefined
  const showRetry = (notice: StreamRetryNotice) => {
    reply = {
      ...reply,
      usage: undefined,
      costNanos: undefined,
      cacheSavedNanos: undefined,
      retry: retryNotice(notice),
    }
    updateReply(sessionId, reply)
  }
  try {
    for (;;) {
      let preparing = false
      let sent: Request | undefined
      let receivedContent = false
      try {
        if (chatConnection.kind === 'custom') {
          const messages: CustomMessage[] = []
          const handoff = withHandoffSummary()
          if (handoff) {
            messages.push({
              role: 'system',
              content: `Use the following handoff summary as background from earlier conversation:\n\n${handoff}`,
            })
          }
          messages.push(
            ...getContextRounds(request.history).flatMap(([user, assistant]) => [
              { role: 'user' as const, content: user.content },
              { role: 'assistant' as const, content: getReplyText(assistant) },
            ])
          )
          messages.push({ role: 'user', content: request.question.content })
          const externalTools = useExternalTools.getState()
          const searchEnabled = !!initial.search && isExternalSearchConfigured(externalTools.search)
          const catalog = buildMcpToolCatalog(externalTools.mcp)
          const toolDefinitions = [
            ...(searchEnabled ? [externalSearchTool] : []),
            ...catalog.definitions,
          ]
          let toolsUnsupported = false
          const usedToolIds = new Set<string>()
          let routeIndex = 0
          for (let round = 0; ; round++) {
            controller.signal.throwIfAborted()
            const roundStart = reply.blocks.length
            let streamed = false
            let activeRoute: CustomProviderRoute | undefined
            let lastError: unknown
            for (let index = routeIndex; index < chatConnection.routes.length; index++) {
              const route = chatConnection.routes[index]
              const fallback = route.provider.id !== chatConnection.provider.id
              usedRates = route.rates
              reply = {
                ...reply,
                model: route.provider.model,
                route: routeInfo(route.provider, fallback, chatConnection.provider),
                retry: undefined,
              }
              updateReply(sessionId, reply)
              let emittedContent = false
              try {
                for await (const event of streamWithPreContentRetry({
                  signal: controller.signal,
                  createStream: (signal) => {
                    blockIndexes.clear()
                    return streamCustomMessage(route.provider, messages, signal, route.rates, {
                      thinking: !!initial.thinking,
                      system,
                      generation,
                      tools: toolDefinitions,
                      onToolsUnsupported: () => {
                        if (!toolsUnsupported) {
                          toolsUnsupported = true
                          showToast({ key: 'mcpToolUnsupported' })
                        }
                      },
                    })
                  },
                  isContentEvent: (event) => event.type === 'content_block_start',
                  onRetry: showRetry,
                })) {
                  emittedContent ||= event.type === 'content_block_start'
                  receivedContent ||= emittedContent
                  apply(event)
                }
                routeIndex = index
                activeRoute = route
                streamed = true
                break
              } catch (error) {
                lastError = error
                if (controller.signal.aborted) {
                  throw error
                }
                const next = chatConnection.routes[index + 1]
                if (emittedContent || !next || !isTransientChatError(error)) {
                  throw error
                }
                reply = {
                  ...reply,
                  retry: {
                    attempt: 1,
                    maxAttempts: 1,
                    phase: 'fallback',
                    target: providerLabel(next.provider),
                  },
                }
                updateReply(sessionId, reply)
                showToast({
                  key: 'customProviderFallback',
                  params: { provider: providerLabel(next.provider) },
                })
                await waitForChannel(CHAT_RETRY_BASE_DELAY_MS, controller.signal)
                if (controller.signal.aborted) {
                  throw new DOMException('Cancelled', 'AbortError')
                }
              }
            }
            if (!streamed || !activeRoute) {
              throw lastError ?? new ApiError('http', { key: 'customProviderRequestFailed' }, 503)
            }
            const activeProviderId = activeRoute.provider.id
            if (
              chatConnection.stickyProvider &&
              getSession(sessionId)?.pinnedProviderId !== activeProviderId
            ) {
              updateSession(sessionId, (session) => ({
                ...session,
                pinnedProviderId: activeProviderId,
              }))
              persist(sessionId)
            }
            if (reply.stopReason !== 'tool_use') {
              reply = settleReply(reply, 'done', Date.now())
              break
            }
            const calls = collectToolCalls(reply.blocks, roundStart)
            if (calls.length === 0) {
              throw new ApiError('protocol', { key: 'customProviderRequestFailed' })
            }
            for (const call of calls) {
              if (usedToolIds.has(call.id)) {
                throw new ApiError('protocol', { key: 'customProviderRequestFailed' })
              }
              usedToolIds.add(call.id)
            }
            if (round >= MAX_TOOL_ROUNDS) {
              throw new ApiError('protocol', { key: 'mcpToolLimit' })
            }
            messages.push(
              assistantToolMessage(roundText(reply.blocks, roundStart), calls.map(toCustomToolCall))
            )
            for (const call of calls) {
              controller.signal.throwIfAborted()
              if (call.name === EXTERNAL_SEARCH_TOOL) {
                const valid =
                  !call.invalid &&
                  validateToolArguments(
                    { inputSchema: externalSearchTool.function.parameters },
                    call.input
                  )
                const query = valid ? searchQuery(call.input) : ''
                reply = {
                  ...reply,
                  blocks: reply.blocks.map((block) =>
                    block.type === 'client_tool_use' && block.id === call.id
                      ? externalSearchUseBlock(call.id, query)
                      : block
                  ),
                }
                updateReply(sessionId, reply)
                flush()
                let content: string
                if (!valid) {
                  reply = appendReplyBlock(reply, externalSearchFailureBlock(call.id))
                  content = 'Invalid tool arguments.'
                } else if (!query) {
                  reply = appendReplyBlock(reply, externalSearchFailureBlock(call.id))
                  content = 'External search query is empty.'
                } else {
                  try {
                    const results = await searchExternal(
                      externalTools.search,
                      query,
                      controller.signal
                    )
                    controller.signal.throwIfAborted()
                    reply = appendReplyBlock(reply, externalSearchResultBlock(call.id, results))
                    content = formatSearchToolResult(query, results)
                  } catch (error) {
                    controller.signal.throwIfAborted()
                    reply = appendReplyBlock(reply, externalSearchFailureBlock(call.id))
                    content = `External search failed: ${toolErrorMessage(error)}`
                  }
                }
                updateReply(sessionId, reply)
                flush()
                messages.push(toolResultMessage(call.id, content))
                continue
              }
              const target = catalog.byAlias.get(call.name)
              if (!target) {
                reply = updateClientTool(reply, call.id, (block) => ({
                  ...block,
                  status: 'complete',
                }))
                reply = appendClientToolResult(reply, call.id, 'Unknown tool.', true)
                updateReply(sessionId, reply)
                flush()
                messages.push(toolResultMessage(call.id, 'Unknown tool.'))
                continue
              }
              if (call.invalid || !validateToolArguments(target.tool, call.input)) {
                reply = updateClientTool(reply, call.id, (block) => ({
                  ...block,
                  name: target.tool.name,
                  serverId: target.server.id,
                  serverName: target.server.name,
                  status: 'complete',
                }))
                reply = appendClientToolResult(reply, call.id, 'Invalid tool arguments.', true)
                updateReply(sessionId, reply)
                flush()
                messages.push(toolResultMessage(call.id, 'Invalid tool arguments.'))
                continue
              }
              const confirm = toolRequiresConfirmation(target.tool)
              reply = updateClientTool(reply, call.id, (block) => ({
                ...block,
                name: target.tool.name,
                serverId: target.server.id,
                serverName: target.server.name,
                status: confirm ? 'awaiting_confirmation' : 'running',
                requiresConfirmation: confirm,
              }))
              updateReply(sessionId, reply)
              flush()
              if (confirm) {
                const decision = await requestToolConfirmation(
                  confirmationOwner,
                  call.id,
                  {
                    name: target.tool.name,
                    serverName: target.server.name,
                    input: call.input,
                  },
                  controller.signal
                )
                controller.signal.throwIfAborted()
                if (decision === 'cancel') {
                  reply = updateClientTool(reply, call.id, (block) => ({
                    ...block,
                    status: 'complete',
                  }))
                  updateReply(sessionId, reply)
                  flush()
                  controller.abort()
                  throw new DOMException('Cancelled', 'AbortError')
                }
                if (decision === 'deny') {
                  reply = updateClientTool(reply, call.id, (block) => ({
                    ...block,
                    status: 'complete',
                  }))
                  reply = appendClientToolResult(
                    reply,
                    call.id,
                    `User denied execution of ${target.tool.name}.`,
                    true,
                    true
                  )
                  updateReply(sessionId, reply)
                  flush()
                  messages.push(
                    toolResultMessage(call.id, `User denied execution of ${target.tool.name}.`)
                  )
                  continue
                }
                reply = updateClientTool(reply, call.id, (block) => ({
                  ...block,
                  status: 'running',
                }))
                updateReply(sessionId, reply)
                flush()
              }
              try {
                const result = await executeMcpTool(target, call.input, controller.signal)
                controller.signal.throwIfAborted()
                reply = updateClientTool(reply, call.id, (block) => ({
                  ...block,
                  status: 'complete',
                }))
                reply = appendClientToolResult(reply, call.id, result.content, result.isError)
                updateReply(sessionId, reply)
                flush()
                messages.push(
                  toolResultMessage(
                    call.id,
                    result.isError ? `Tool returned an error: ${result.content}` : result.content
                  )
                )
              } catch (error) {
                controller.signal.throwIfAborted()
                const detail = toolErrorMessage(error)
                reply = updateClientTool(reply, call.id, (block) => ({
                  ...block,
                  status: 'complete',
                }))
                reply = appendClientToolResult(reply, call.id, detail, true)
                updateReply(sessionId, reply)
                flush()
                messages.push(toolResultMessage(call.id, `Tool execution failed: ${detail}`))
              }
            }
          }
          break
        }
        if (!connection) {throw new ApiError('http', { key: 'replyInvalidApiKey' }, 401)}
        const context = settings.autoCompactContext
          ? await selectContext(request.history, getSession(sessionId)?.contextCheckpoint)
          : undefined
        const checkpoint = context
          ? await compactContext(
              context,
              estimateBody,
              budget,
              stream,
              controller.signal,
              forceCompact
            )
          : undefined
        controller.signal.throwIfAborted()
        forceCompact = false
        let history = context?.history ?? request.history
        let summary = context?.summary
        if (checkpoint) {
          const current = getSession(sessionId)
          const path = current && getVisibleMessages(current)
          const questionIndex =
            path?.findIndex((message) => message.id === request.question.id) ?? -1
          const selected = await selectContext(
            path && questionIndex >= 0 ? path.slice(0, questionIndex) : [],
            checkpoint
          )
          controller.signal.throwIfAborted()
          if (
            !selected.masked ||
            epoch !== historyEpoch ||
            get().importingHistory ||
            deletingSessions.has(sessionId)
          ) {
            throw new ContextPreparationError('summaryFailed')
          }
          updateSession(sessionId, (session) => ({ ...session, contextCheckpoint: checkpoint }))
          persist(sessionId)
          history = selected.history
          summary = selected.summary
        }
        preparing = true
        const prepared = await prepareFiles(
          sessionId,
          { ...request, history },
          connection,
          controller.signal
        )
        preparing = false
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          !!initial.thinking,
          latestReminder,
          withHandoffSummary(summary)
        )
        const messageBody: CreateMessageRequest = {
          ...options,
          messages,
          ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
        }
        sent = prepared
        const events = streamWithPreContentRetry({
          signal: controller.signal,
          createStream: (signal) => {
            blockIndexes.clear()
            const startedAt = new Date()
            usedRates = deepSeekRates(
              official ? OFFICIAL_API_ORIGIN : API_ORIGIN,
              options.model,
              startedAt
            )
            return stream(messageBody, signal)
          },
          isContentEvent: (event) => event.type === 'content_block_start',
          onRetry: showRetry,
        })
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          apply(event)
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        if (settings.autoCompactContext && sent && !receivedContent && !retriedOverflow && isInputContextOverflow(error)) {
          retriedOverflow = true
          forceCompact = true
          continue
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          sent && connection &&
          fileRetries < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, sent, error, connection)
        ) {
          await waitForRetry(fileRetries++, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ContextPreparationError || isInputContextOverflow(error)) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: '',
            localMessage: {
              key:
                error instanceof ContextPreparationError && error.reason === 'summaryFailed'
                  ? 'replyRequestFailed'
                  : 'replyContextTooLong',
            },
          })
        } else if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    clearToolConfirmations(confirmationOwner)
    cancelAnimationFrame(frame)
    reply = withUsageCost(reply, usedRates)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
