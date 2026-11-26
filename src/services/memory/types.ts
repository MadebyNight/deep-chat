/** 跨会话长期记忆；仅保存在本机 IndexedDB，不进入官方历史导出。 */
export type MemoryEntry = {
  id: string
  content: string
  tags: string[]
  sourceSessionId: string | null
  createdAt: number
  updatedAt: number
  /** Unix 毫秒时间戳；读取时清理已过期条目。 */
  expiresAt?: number
}
