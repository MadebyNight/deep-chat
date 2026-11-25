import type { PromptPreset } from '../settings.js'
import type { Session } from './types.js'

/** 未选择自定义人设时使用的基础身份说明。 */
export const DEFAULT_SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 下游 #17 的长期记忆块从这里开始，顺序固定为「会话人设」在前。 */
export const PERSONA_SECTION_HEADER = '[会话人设]'
export const MEMORY_SECTION_HEADER = '[长期记忆]'

export type SystemPromptSections = {
  persona?: string | null
  memory?: string | null
}

const removeControlCharacters = (value: string) => {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) {
      result += value[index]
    }
  }
  return result
}

const normalizeSection = (value: string | null | undefined) =>
  removeControlCharacters((value ?? '').replace(/\r\n?/g, '\n')).trim()

/**
 * 统一组装 System Prompt。无长期记忆时保持原来的纯人设输出；
 * 出现记忆时固定为「[会话人设] → [长期记忆]」，供 #17 直接追加。
 */
export const assembleSystemPrompt = ({ persona, memory }: SystemPromptSections): string => {
  const personaText = normalizeSection(persona) || DEFAULT_SYSTEM_PROMPT
  const memoryText = normalizeSection(memory)
  if (!memoryText) {
    return personaText
  }
  return `${PERSONA_SECTION_HEADER}\n${personaText}\n\n${MEMORY_SECTION_HEADER}\n${memoryText}`
}

export type PromptSelection = {
  presets: readonly PromptPreset[]
  selectedId: string | null
}

/**
 * 解析会话实际使用的人设。
 * - 旧会话没有 systemPromptId：沿用全局选择；
 * - 显式 null：默认助手；
 * - 预设仍存在：读取最新正文；
 * - 预设被删除：回退到绑定时保存的快照。
 */
export const resolveSessionPersona = (
  session: Pick<Session, 'systemPromptId' | 'systemPromptSnapshot'> | undefined,
  prompts: PromptSelection
): string => {
  if (!session || session.systemPromptId === undefined) {
    return (
      normalizeSection(prompts.presets.find((preset) => preset.id === prompts.selectedId)?.body) ||
      DEFAULT_SYSTEM_PROMPT
    )
  }
  if (session.systemPromptId === null) {
    return DEFAULT_SYSTEM_PROMPT
  }
  const preset = prompts.presets.find((item) => item.id === session.systemPromptId)
  return (
    normalizeSection(preset?.body) ||
    normalizeSection(session.systemPromptSnapshot) ||
    DEFAULT_SYSTEM_PROMPT
  )
}

/**
 * 会话 System Prompt 的唯一组装入口。
 * #17 接入长期记忆时通过 options.memory 传入，不要自行改变分段顺序。
 */
export const buildSessionSystemPrompt = (
  session: Pick<Session, 'systemPromptId' | 'systemPromptSnapshot'> | undefined,
  prompts: PromptSelection,
  options: { memory?: string | null } = {}
): string =>
  assembleSystemPrompt({
    persona: resolveSessionPersona(session, prompts),
    memory: options.memory,
  })
