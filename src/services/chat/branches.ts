import type { Message, Session } from './types.js'

/** 将线性消息列表规范化为单分支，保留消息 ID、内容及时间。 */
export const normalizeSession = (session: Session): Session =>
  session.rootMessageId !== undefined
    ? session
    : {
        ...session,
        rootMessageId: session.messages[0]?.id ?? null,
        messages: session.messages.map((message, index, messages) => ({
          ...message,
          parentId: messages[index - 1]?.id ?? null,
          selectedChildId: messages[index + 1]?.id,
        })),
      }

/** 展示内容与请求上下文共用当前选中的分支路径。 */
export const getVisibleMessages = (session: Session): Message[] => {
  if (session.rootMessageId === undefined) {
    return session.messages
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: Message[] = []
  let id = session.rootMessageId
  while (id) {
    const message = byId.get(id)
    if (!message) {
      break
    }
    path.push(message)
    byId.delete(id)
    id = message.selectedChildId ?? null
  }
  return path
}

export type MessageVersions = { ids: string[]; index: number }

export type VisibleTurn = {
  userId: string
  messages: Message[]
}

/** 将当前可见消息序列按用户提问拆分为对话轮次。 */
export const getVisibleTurns = (messages: readonly Message[]): VisibleTurn[] => {
  const turns: VisibleTurn[] = []
  let current: VisibleTurn | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      current = { userId: message.id, messages: [message] }
      turns.push(current)
    } else if (current) {
      current.messages.push(message)
    }
  }
  return turns
}

/** 一次遍历收集兄弟版本；版本列表未变化时复用旧对象与索引，避免流式正文更新重绘历史消息。 */
export const buildMessageVersions = (
  session: Session,
  previous: ReadonlyMap<string, MessageVersions>
): ReadonlyMap<string, MessageVersions> => {
  const groups = new Map<string | null | undefined, string[]>()
  for (const message of session.messages) {
    const key = session.rootMessageId === undefined ? message.id : message.parentId
    const ids = groups.get(key)
    if (ids) {
      ids.push(message.id)
    } else {
      groups.set(key, [message.id])
    }
  }

  const versions = new Map<string, MessageVersions>()
  let unchanged = previous.size === session.messages.length
  for (const ids of groups.values()) {
    const cachedIds = previous.get(ids[0])?.ids
    const stableIds =
      cachedIds?.length === ids.length && ids.every((id, index) => id === cachedIds[index])
        ? cachedIds
        : ids
    ids.forEach((id, index) => {
      const cached = previous.get(id)
      const version =
        cached?.ids === stableIds && cached.index === index ? cached : { ids: stableIds, index }
      versions.set(id, version)
      if (version !== cached) {
        unchanged = false
      }
    })
  }
  return unchanged ? previous : versions
}

/** 新消息挂在指定父节点下，并选择新分支；原节点与其后续对话保持不变。 */
export const appendBranch = (
  original: Session,
  parentId: string | null,
  messages: Message[]
): Session => {
  const session = normalizeSession(original)
  const first = messages[0]
  if (!first) {
    return session
  }
  return {
    ...session,
    rootMessageId: parentId === null ? first.id : session.rootMessageId,
    messages: [
      ...session.messages.map((message) =>
        message.id === parentId ? { ...message, selectedChildId: first.id } : message
      ),
      ...messages.map((message, index) => ({
        ...message,
        parentId: messages[index - 1]?.id ?? parentId,
        selectedChildId: messages[index + 1]?.id,
      })),
    ],
  }
}

/** 仅允许切换当前路径上某一节点的兄弟版本，恢复该版本已选中的后续分支。 */
export const selectVersion = (original: Session, messageId: string): Session => {
  const session = normalizeSession(original)
  const message = session.messages.find((item) => item.id === messageId)
  if (!message || !getVisibleMessages(session).some((item) => item.parentId === message.parentId)) {
    return original
  }
  return {
    ...session,
    rootMessageId: message.parentId === null ? message.id : session.rootMessageId,
    messages: session.messages.map((item) =>
      item.id === message.parentId ? { ...item, selectedChildId: message.id } : item
    ),
  }
}

/**
 * 整轮删除当前路径上的指定轮次（包含其回答与重新生成的各版本），并将后续可见轮次接回前驱节点；
 * 若删除覆盖了上下文摘要检查点范围内的消息，则一并清除失效检查点。
 */
export const removeTurns = (original: Session, userIds: ReadonlySet<string>): Session => {
  if (userIds.size === 0) {
    return original
  }
  const session = normalizeSession(original)
  const path = getVisibleMessages(session)
  const turns = getVisibleTurns(path)
  const removedTurns = turns.filter((turn) => userIds.has(turn.userId))
  if (removedTurns.length === 0) {
    return original
  }

  const deletedSpanIds = new Set(
    removedTurns.flatMap((turn) => turn.messages.map((message) => message.id))
  )
  const survivingPath = path.filter((message) => !deletedSpanIds.has(message.id))

  const reparented = new Map<string, string | null>()
  const reselected = new Map<string, string | undefined>()
  for (let i = 0; i < survivingPath.length; i++) {
    const curr = survivingPath[i]
    const prev = i === 0 ? null : survivingPath[i - 1]
    const expectedParentId = prev?.id ?? null
    if ((curr.parentId ?? null) !== expectedParentId) {
      reparented.set(curr.id, expectedParentId)
      if (prev) {
        reselected.set(prev.id, curr.id)
      }
    }
  }

  const originalById = new Map(session.messages.map((message) => [message.id, message]))
  const stitchedIds = new Set(reparented.keys())
  const shouldKeep = (message: Message): boolean => {
    if (deletedSpanIds.has(message.id)) {
      return false
    }
    let cursor: Message | undefined = message
    const seen = new Set<string>()
    while (cursor) {
      if (stitchedIds.has(cursor.id)) {
        return true
      }
      if (deletedSpanIds.has(cursor.id)) {
        return false
      }
      if (!cursor.parentId || seen.has(cursor.parentId)) {
        return true
      }
      seen.add(cursor.parentId)
      cursor = originalById.get(cursor.parentId)
    }
    return true
  }

  const kept = session.messages.filter(shouldKeep)
  const effectiveParent = (message: Message) =>
    reparented.has(message.id) ? (reparented.get(message.id) ?? null) : (message.parentId ?? null)
  const keptIds = new Set(kept.map((message) => message.id))

  const messages = kept.map((message) => {
    const nextParentId = reparented.has(message.id) ? reparented.get(message.id) : message.parentId
    let nextSelectedChildId = message.selectedChildId
    if (reselected.has(message.id)) {
      nextSelectedChildId = reselected.get(message.id)
    } else if (message.selectedChildId && !keptIds.has(message.selectedChildId)) {
      nextSelectedChildId = kept.find((item) => effectiveParent(item) === message.id)?.id
    }
    if (nextParentId === message.parentId && nextSelectedChildId === message.selectedChildId) {
      return message
    }
    return { ...message, parentId: nextParentId, selectedChildId: nextSelectedChildId }
  })

  const rootMessageId =
    survivingPath[0]?.id ?? kept.find((message) => effectiveParent(message) === null)?.id ?? null

  const checkpoint = session.contextCheckpoint
  const checkpointIndex = checkpoint
    ? path.findIndex((message) => message.id === checkpoint.throughReplyId)
    : -1
  const checkpointStale =
    checkpoint !== undefined &&
    (checkpointIndex === -1 || path.slice(0, checkpointIndex + 1).some((m) => deletedSpanIds.has(m.id)))

  return {
    ...session,
    rootMessageId,
    messages,
    contextCheckpoint: checkpointStale ? undefined : checkpoint,
  }
}
