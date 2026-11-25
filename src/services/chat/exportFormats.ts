import { getVisibleMessages, getVisibleTurns } from './branches.js'
import { describeReply } from './describe.js'
import { buildReplyView } from './view.js'
import type { AssistantMessage, Session, UserMessage } from './types.js'

/** 导出目标只引用本地消息，不携带连接凭据或供应商配置。 */
export type ExportSelection =
  | { kind: 'message'; sessionId: string; messageId: string }
  | { kind: 'turns'; sessionId: string; userIds: readonly string[] }
  | { kind: 'session'; sessionId: string }

export type ExportTurn = {
  user: UserMessage | null
  replies: AssistantMessage[]
}

export type ExportContent = {
  title: string
  turns: ExportTurn[]
  replyCount: number
}

export type MarkdownLabels = {
  question: string
  answer: string
  model: string
  thinking: string
  sources: string
  attachments: string
}

export type MarkdownExportOptions = {
  labels: MarkdownLabels
  includeThinking: boolean
  includeSources: boolean
  now?: number
}

export class ExportSelectionError extends Error {
  constructor() {
    super('Nothing to export')
    this.name = 'ExportSelectionError'
  }
}

const citationMarkdown = (markdown: string, reply: AssistantMessage, linked: boolean) => {
  const sources = new Map(
    buildReplyView(reply, false).sources.map((source) => [source.index, source])
  )
  return markdown.replace(/\[citation:(\d+)\]/g, (_, raw: string) => {
    const source = sources.get(Number(raw))
    return source && linked ? `[[${raw}]](<${source.url}>)` : `[${raw}]`
  })
}

const replyMarkdown = (reply: AssistantMessage, options: MarkdownExportOptions) => {
  const view = buildReplyView(reply, false)
  const notice = describeReply(reply)
  const answer = view.answer?.markdown ?? notice?.text ?? ''
  const parts: string[] = []
  if (reply.model) {
    parts.push(`> ${options.labels.model}: \`${reply.model}\``)
  }
  if (options.includeThinking) {
    const thinking = view.steps
      .flatMap((step) =>
        step.type === 'thinking' ? step.blocks.map((block) => block.thinking.trim()) : []
      )
      .filter(Boolean)
      .join('\n\n')
    if (thinking) {
      parts.push(
        `<details>\n<summary>${options.labels.thinking}</summary>\n\n${thinking}\n\n</details>`
      )
    }
  }
  if (answer.trim()) {
    parts.push(citationMarkdown(answer.trim(), reply, options.includeSources))
  }
  if (options.includeSources && view.sources.length > 0) {
    parts.push(
      [
        `### ${options.labels.sources}`,
        '',
        ...view.sources.map(
          (source) => `${source.index}. [${source.title.replaceAll(']', '\\]')}](<${source.url}>)`
        ),
      ].join('\n')
    )
  }
  return parts.join('\n\n')
}

const userMarkdown = (user: UserMessage | null, labels: MarkdownLabels) => {
  if (!user) {
    return ''
  }
  const parts: string[] = []
  if (user.content.trim()) {
    parts.push(user.content.trim())
  }
  if (user.files.length > 0) {
    parts.push(
      `${labels.attachments}: ${user.files.map((file) => `\`${file.name.replaceAll('`', 'ˋ')}\``).join('、')}`
    )
  }
  return parts.join('\n\n')
}

/**
 * 选取当前可见分支上的消息。单条回答可只取一条回复；多选与整会话按提问轮次输出。
 * 分支中未选中的版本、上下文摘要和供应商配置不会进入导出内容。
 */
export const createExportContent = (
  session: Session,
  selection: ExportSelection,
  {
    includeQuestion = true,
    fallbackTitle = 'Deep Chat',
  }: { includeQuestion?: boolean; fallbackTitle?: string } = {}
): ExportContent => {
  if (selection.sessionId !== session.id) {
    throw new ExportSelectionError()
  }
  const turns = getVisibleTurns(getVisibleMessages(session))
  if (selection.kind === 'message') {
    for (const turn of turns) {
      const reply = turn.messages.find(
        (message): message is AssistantMessage =>
          message.role === 'assistant' && message.id === selection.messageId
      )
      if (reply) {
        const user = turn.messages.find(
          (message): message is UserMessage => message.role === 'user' && message.id === turn.userId
        )
        return {
          title: session.title || fallbackTitle,
          turns: [{ user: includeQuestion ? (user ?? null) : null, replies: [reply] }],
          replyCount: 1,
        }
      }
    }
    throw new ExportSelectionError()
  }

  const selectedIds = selection.kind === 'turns' ? new Set(selection.userIds) : null
  const selectedTurns = selectedIds ? turns.filter((turn) => selectedIds.has(turn.userId)) : turns
  const content = selectedTurns.map((turn) => ({
    user: includeQuestion
      ? (turn.messages.find(
          (message): message is UserMessage => message.role === 'user' && message.id === turn.userId
        ) ?? null)
      : null,
    replies: turn.messages.filter(
      (message): message is AssistantMessage => message.role === 'assistant'
    ),
  }))
  const replyCount = content.reduce((count, turn) => count + turn.replies.length, 0)
  if (replyCount === 0) {
    throw new ExportSelectionError()
  }
  return {
    title: session.title || fallbackTitle,
    turns: content,
    replyCount,
  }
}

export const hasExportText = (content: ExportContent, labels: MarkdownLabels) =>
  content.turns.some(
    (turn) =>
      !!userMarkdown(turn.user, labels) ||
      turn.replies.some((reply) => {
        const view = buildReplyView(reply, false)
        return !!(
          view.answer?.text ||
          view.steps.some((step) => step.type === 'thinking') ||
          describeReply(reply)
        )
      })
  )

export const serializeExportMarkdown = (
  content: ExportContent,
  options: MarkdownExportOptions
): string => {
  const parts = [`# ${content.title}`]
  for (const turn of content.turns) {
    const question = userMarkdown(turn.user, options.labels)
    if (question) {
      parts.push(`## ${options.labels.question}\n\n${question}`)
    }
    for (const reply of turn.replies) {
      const body = replyMarkdown(reply, options)
      if (body) {
        parts.push(`## ${options.labels.answer}\n\n${body}`)
      }
    }
  }
  return `${parts.join('\n\n').trim()}\n`
}

const safeFileBase = (title: string) => {
  const safe = title
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '-')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 64)
  return safe || 'Deep Chat'
}

export const exportDatePart = (now = Date.now()) => {
  const date = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

export const exportFileBase = (content: ExportContent, now = Date.now()) =>
  `${safeFileBase(content.title)}-${exportDatePart(now)}`

export const markdownFileName = (content: ExportContent, now = Date.now()) =>
  `${exportFileBase(content, now)}.md`
