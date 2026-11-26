import type { LinkedMessage, TranslationKey } from '../../i18n/index.js'
import { MAX_MEMORY_CONTENT_LENGTH, MemoryValidationError } from './validation.js'

/** 把存储校验失败转成可直接交给 Toast 或表单提示的文案。 */
export const memoryErrorMessage = (error: unknown, fallback: TranslationKey): LinkedMessage => {
  if (error instanceof MemoryValidationError) {
    switch (error.reason) {
      case 'empty':
        return { key: 'settingsMemoryEmptyError', type: 'error' }
      case 'tooLong':
        return {
          key: 'settingsMemoryTooLongError',
          params: { count: MAX_MEMORY_CONTENT_LENGTH },
          type: 'error',
        }
      case 'sensitive':
        return { key: 'settingsMemorySensitiveError', type: 'error' }
      case 'duplicate':
        return { key: 'settingsMemoryDuplicateError', type: 'error' }
      default:
        break
    }
  }
  return { key: fallback, type: 'error' }
}
