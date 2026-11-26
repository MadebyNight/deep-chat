export const MAX_MEMORY_CONTENT_LENGTH = 600
export const MAX_MEMORY_TAGS = 8
export const MAX_MEMORY_TAG_LENGTH = 24

export type MemoryValidationReason = 'empty' | 'tooLong' | 'sensitive' | 'duplicate' | 'missing'

export class MemoryValidationError extends Error {
  readonly reason: MemoryValidationReason

  constructor(reason: MemoryValidationReason) {
    super(reason)
    this.reason = reason
  }
}

const sensitivePatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:authorization|set-cookie|cookie)\s*[:=]\s*\S{8,}/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*[^\s,;]{6,}/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
]

/** 存储时保留换行，统一 CRLF、去掉行尾空白和多余空行。 */
export const normalizeMemoryContent = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** 去重和检索共用的宽松指纹：忽略大小写、空白、标点和全半角差异。 */
export const memoryFingerprint = (value: string) =>
  normalizeMemoryContent(value)
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')

export const containsSensitiveMemory = (value: string) =>
  sensitivePatterns.some((pattern) => pattern.test(value.normalize('NFKC')))

export const normalizeMemoryTags = (tags: readonly string[] | undefined): string[] => {
  const result: string[] = []
  for (const raw of tags ?? []) {
    const tag = raw.normalize('NFKC').trim().slice(0, MAX_MEMORY_TAG_LENGTH)
    if (tag && !result.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      result.push(tag)
    }
    if (result.length === MAX_MEMORY_TAGS) {
      break
    }
  }
  return result
}

/** 校验并返回可存储文本；敏感内容在写入和注入两侧都会被拦截。 */
export const validateMemoryContent = (value: string): string => {
  const content = normalizeMemoryContent(value)
  if (!content || !memoryFingerprint(content)) {
    throw new MemoryValidationError('empty')
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new MemoryValidationError('tooLong')
  }
  if (containsSensitiveMemory(content)) {
    throw new MemoryValidationError('sensitive')
  }
  return content
}
