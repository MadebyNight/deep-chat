import type { TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorKind } from '../api/client.js'
import type {
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../api/types.js'
import type { GenerationParams } from '../generation.js'

/**
 * 消息附件。id 是本地标识（IndexedDB files 表的主键，原件按它存储，所有引用同一 id 的消息共用一份），
 * 导入的附件沿用导出产物里的文件 ID；本地没有原件的附件只展示文件名，不进入请求。
 * serverId 是 Files API 返回的 file_id，导入的数据或尚未上传成功的文件为 null，发送前补传。
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  serverIdScope?: string
  accountFile?: { id: string; scope: string }
  name: string
  size: number
  /** 附件类别；导入时沿用归档的 is_image，不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME；导入时没有原件或无法识别的为空字符串，不影响图片身份。 */
  mimeType: string
}

/** 本地消息的分支关系；字段缺省时按线性消息列表处理。 */
type MessageBranch = {
  parentId?: string | null
  /** 当前选中的下一条消息；切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
}

/** 思考块：thinking_delta 累积，签名随 signature_delta 到达；历史轮次的思考服务端会丢弃，不回传 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** content_block_start 的时间；没有事件时间的历史块缺省 */
  startedAt?: number
  /** content_block_stop（或回复结束）的时间 */
  endedAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块：text_delta 累积，citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案，仅用于展示，不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 客户端工具调用：参数流式拼接，执行完成后再追加结果块。 */
export type ClientToolUseBlock = {
  type: 'client_tool_use'
  id: string
  name: string
  serverId?: string
  serverName?: string
  input: Record<string, unknown>
  /** 原始 JSON 参数，用于流式累积与解析失败诊断；只在本地保存。 */
  arguments: string
  status: 'streaming' | 'awaiting_confirmation' | 'running' | 'complete'
  invalid?: boolean
  requiresConfirmation?: boolean
}

export type ClientToolResultBlock = {
  type: 'client_tool_result'
  tool_use_id: string
  content: string
  isError: boolean
  denied?: boolean
}

/** 服务端工具调用与结果块按协议原样保存；历史请求只回传 read_link 调用与结果 */
export type ReplyBlock =
  | ThinkingPart
  | TextPart
  | ServerToolBlock
  | ClientToolUseBlock
  | ClientToolResultBlock

/**
 * pending：已发出请求，还没收到事件；streaming：正在接收；
 * done：收到 message_stop；stopped：用户停止或页面关闭；error：请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

/** 实际完成本轮的自定义供应商线路，用于历史记录与 fallback 提示 */
export type MessageRoute = {
  providerId: string
  providerName: string
  model: string
  fallback: boolean
  /** fallback 时记录被跳过的主线路，便于历史说明 */
  fallbackFrom?: { providerId: string; providerName: string }
}

export type ReplyRetry = {
  /** 即将进行第几次重试，从 1 开始 */
  attempt: number
  maxAttempts: number
  phase: 'retry' | 'fallback'
  /** fallback 时展示目标线路 */
  target?: string
}

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 未记录模型时为 null，续写使用当前默认模型。 */
  model: string | null
  /** 本轮请求的生成参数快照；旧消息缺省时使用会话当前参数。 */
  generation?: GenerationParams
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  /** 请求时是否声明 deepseek_web_search；关闭时仍声明 deepseek_read_url */
  search?: boolean
  /** 本轮请求的系统信息快照；各回答版本独立保存，续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  /** 是否允许作为续写前缀；仍需满足回复状态与内容限制。 */
  prefix: boolean
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列；续写产生的块追加在已有块之后 */
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 最近一次请求的用量，续写后更新 */
  usage?: MessageUsage
  /** 按实际请求时间与费率计算的单轮估算费用快照 */
  costNanos?: number
  /** 缓存命中相对未命中输入价节省的估算金额快照 */
  cacheSavedNanos?: number
  /** 自定义供应商实际命中的线路；旧消息缺省 */
  route?: MessageRoute
  /** 仅流式期间展示的重试/切线路状态 */
  retry?: ReplyRetry
  error?: {
    /** upload：发送前补传附件失败，请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    localMessage?: TranslationMessage
    /** 仅 upload：重新上传是否可能成功（网络、限流、服务端繁忙）；过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

export type ContextCheckpoint = {
  version: 1
  throughReplyId: string
  fingerprint: string
  summary: string
}

/** 本地会话分组；不写入 DeepSeek 官方历史导出。 */
export type Folder = {
  id: string
  name: string
  createdAt: number
  order: number
}

/** 摘要续聊带入新会话的背景，来源会话只用于追溯，不复制原消息。 */
export type SessionHandoff = {
  version: 1
  summary: string
  sourceSessionId: string
  sourceTitle: string
  createdAt: number
}

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  /** 缺省或 null 表示未分组；旧会话无需迁移即可继续展示。 */
  folderId?: string | null
  /**
   * 会话绑定的人设预设。undefined 为旧会话（沿用全局选择），
   * null 表示显式使用默认助手，字符串表示绑定预设 ID。
   */
  systemPromptId?: string | null
  /** 绑定时保存的人设正文；预设被删除后仍可继续追溯与发送。 */
  systemPromptSnapshot?: string
  /** 包含所有分支的消息，按创建顺序存储。 */
  messages: Message[]
  contextCheckpoint?: ContextCheckpoint
  /** 手动摘要续聊写入的结构化背景；不进入官方历史导出。 */
  handoff?: SessionHandoff
  customProviderId?: string
  /** 粘性会话当前优先使用自定义供应商线路；缺省表示使用主线路 */
  pinnedProviderId?: string
  /** 会话级生成参数覆盖；缺省时使用全局默认。 */
  generation?: GenerationParams
  /** undefined 表示线性消息列表；null 表示空会话。 */
  rootMessageId?: string | null
}

/** 会话列表元数据；消息只在打开会话时加载。 */
export type SessionSummary = Pick<
  Session,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'pinned' | 'folderId'
>

/** 显式提取字段，避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  pinned: session.pinned ?? false,
  folderId: session.folderId ?? null,
})
