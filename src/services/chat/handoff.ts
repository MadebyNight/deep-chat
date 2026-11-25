import type { CustomMessage } from '../api/client.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import type { Session } from './types.js'

const messageText = (message: MessageParam): string => {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** 手动摘要请求走自定义供应商时，把同一份 Messages 请求转换为 Chat Completions 消息。 */
export const customSummaryMessages = (body: CreateMessageRequest): CustomMessage[] => [
  ...(body.system ? [{ role: 'system' as const, content: body.system }] : []),
  ...body.messages.flatMap((message): CustomMessage[] =>
    message.role === 'latest_reminder'
      ? []
      : [{ role: message.role, content: messageText(message) }]
  ),
]

/** 新会话只携带结构化摘要，不复制来源会话的消息或附件。 */
export const createHandoffSession = (
  source: Session,
  summary: string,
  id: string,
  title: string,
  now: number
): Session => ({
  id,
  title,
  createdAt: now,
  updatedAt: now,
  folderId: source.folderId ?? null,
  messages: [],
  rootMessageId: null,
  handoff: {
    version: 1,
    summary: summary.trim(),
    sourceSessionId: source.id,
    sourceTitle: source.title,
    createdAt: now,
  },
  ...(source.customProviderId ? { customProviderId: source.customProviderId } : {}),
})
