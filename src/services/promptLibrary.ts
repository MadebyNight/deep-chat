import { createId } from '../utils/id.js'
import type { Locale, PromptPreferences, PromptPreset } from './settings.js'

export const PROMPT_PACK_FORMAT = 'deepchat.prompt-library'
export const PROMPT_PACK_VERSION = 1
export const MAX_PROMPT_FILE_BYTES = 512 * 1024
export const MAX_PROMPT_PRESETS = 200
export const MAX_IMPORTED_PROMPTS = 100
export const MAX_PROMPT_TITLE_LENGTH = 120
export const MAX_PROMPT_CATEGORY_LENGTH = 40
export const MAX_PROMPT_BODY_LENGTH = 30_000
export const MAX_PROMPT_STARTER_LENGTH = 4_000

export const BUILTIN_PROMPT_CATEGORIES = [
  'writing',
  'coding',
  'learning',
  'creative',
  'roleplay',
] as const

export type BuiltinPromptCategory = (typeof BUILTIN_PROMPT_CATEGORIES)[number]

type LocalizedText = Record<Locale, string>

export type BuiltinPromptTemplate = {
  id: string
  category: BuiltinPromptCategory
  title: LocalizedText
  body: LocalizedText
  starterPrompt?: LocalizedText
}

export type PromptPresetDraft = {
  title: string
  body: string
  category?: string
  starterPrompt?: string
  createdAt?: number
}

export type PromptImportSource = 'deepchat' | 'character-card'

export type PromptImportResult = {
  presets: PromptPreset[]
  source: PromptImportSource
  truncated: boolean
}

export type PromptImportErrorCode =
  | 'promptImportTooLarge'
  | 'promptImportInvalid'
  | 'promptImportUnsupported'
  | 'promptImportEmpty'
  | 'promptImportTooMany'

export class PromptImportError extends Error {
  constructor(readonly code: PromptImportErrorCode) {
    super(code)
    this.name = 'PromptImportError'
  }
}

const fail = (code: PromptImportErrorCode): never => {
  throw new PromptImportError(code)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

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

const cleanText = (value: string, limit: number) => {
  const normalized = removeControlCharacters(value.replace(/\r\n?/g, '\n')).trim()
  return {
    text: normalized.length > limit ? normalized.slice(0, limit).trimEnd() : normalized,
    truncated: normalized.length > limit,
  }
}

const optionalText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new PromptImportError('promptImportInvalid')
  }
  return value
}

const titleFromBody = (body: string) => {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return (firstLine || body).slice(0, MAX_PROMPT_TITLE_LENGTH)
}

export const readBuiltinPrompt = (
  template: BuiltinPromptTemplate,
  locale: Locale,
  createdAt = Date.now()
): PromptPreset => ({
  id: createId(),
  title: cleanText(template.title[locale], MAX_PROMPT_TITLE_LENGTH).text,
  body: cleanText(template.body[locale], MAX_PROMPT_BODY_LENGTH).text,
  category: template.category,
  ...(template.starterPrompt
    ? { starterPrompt: cleanText(template.starterPrompt[locale], MAX_PROMPT_STARTER_LENGTH).text }
    : {}),
  createdAt,
})

export const makePromptPreset = (
  draft: PromptPresetDraft,
  options: { id?: string; now?: number } = {}
): PromptPreset => {
  const body = cleanText(draft.body, MAX_PROMPT_BODY_LENGTH)
  if (!body.text) {
    throw new PromptImportError('promptImportInvalid')
  }
  const title = cleanText(draft.title || titleFromBody(body.text), MAX_PROMPT_TITLE_LENGTH)
  const category = draft.category
    ? cleanText(draft.category, MAX_PROMPT_CATEGORY_LENGTH).text
    : ''
  const starter = draft.starterPrompt
    ? cleanText(draft.starterPrompt, MAX_PROMPT_STARTER_LENGTH).text
    : ''
  return {
    id: options.id ?? createId(),
    title: title.text || titleFromBody(body.text),
    body: body.text,
    ...(category ? { category } : {}),
    ...(starter ? { starterPrompt: starter } : {}),
    createdAt:
      typeof draft.createdAt === 'number' &&
      Number.isSafeInteger(draft.createdAt) &&
      draft.createdAt >= 0
        ? draft.createdAt
        : (options.now ?? Date.now()),
  }
}

const readStoredText = (
  value: unknown,
  limit: number,
  field: string,
  optional = false
): string | undefined => {
  if (value === undefined || value === null) {
    if (optional) {
      return undefined
    }
    throw new TypeError(`${field} is required`)
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`)
  }
  return cleanText(value, limit).text
}

export const readStoredPromptPreset = (value: unknown): PromptPreset | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
    return null
  }
  try {
    const body = readStoredText(value.body, MAX_PROMPT_BODY_LENGTH, 'body')
    if (!body) {
      return null
    }
    const title = readStoredText(value.title, MAX_PROMPT_TITLE_LENGTH, 'title', true) ?? ''
    const category = readStoredText(
      value.category,
      MAX_PROMPT_CATEGORY_LENGTH,
      'category',
      true
    )
    const starterPrompt = readStoredText(
      value.starterPrompt,
      MAX_PROMPT_STARTER_LENGTH,
      'starterPrompt',
      true
    )
    return {
      id: value.id,
      title: title || titleFromBody(body),
      body,
      ...(category ? { category } : {}),
      ...(starterPrompt ? { starterPrompt } : {}),
      ...(typeof value.createdAt === 'number' &&
      Number.isSafeInteger(value.createdAt) &&
      value.createdAt >= 0
        ? { createdAt: value.createdAt }
        : {}),
    }
  } catch {
    return null
  }
}

/** 读取本机旧数据；坏条目跳过，其余字段仍可继续使用。 */
export const readPromptPreferences = (value: unknown): PromptPreferences | null => {
  if (!isRecord(value) || !Array.isArray(value.presets)) {
    return null
  }
  const presets: PromptPreset[] = []
  const ids = new Set<string>()
  for (const item of value.presets.slice(0, MAX_PROMPT_PRESETS)) {
    const preset = readStoredPromptPreset(item)
    if (preset && !ids.has(preset.id)) {
      ids.add(preset.id)
      presets.push(preset)
    }
  }
  const selectedId =
    typeof value.selectedId === 'string' && ids.has(value.selectedId) ? value.selectedId : null
  return { presets, selectedId }
}

const deepchatPack = (value: Record<string, unknown>, now: number): PromptImportResult => {
  if (value.format !== PROMPT_PACK_FORMAT) {
    return fail('promptImportUnsupported')
  }
  if (value.version !== PROMPT_PACK_VERSION) {
    return fail('promptImportUnsupported')
  }
  if (!Array.isArray(value.presets)) {
    return fail('promptImportInvalid')
  }
  if (value.presets.length === 0) {
    return fail('promptImportEmpty')
  }
  if (value.presets.length > MAX_IMPORTED_PROMPTS) {
    return fail('promptImportTooMany')
  }
  let truncated = false
  const presets = value.presets.map((item) => {
    if (!isRecord(item)) {
      return fail('promptImportInvalid')
    }
    const body = optionalText(item.body)
    if (body === undefined) {
      return fail('promptImportInvalid')
    }
    const title = optionalText(item.title) ?? ''
    const category = optionalText(item.category)
    const starterPrompt = optionalText(item.starterPrompt)
    const cleanedBody = cleanText(body, MAX_PROMPT_BODY_LENGTH)
    const cleanedTitle = cleanText(title || titleFromBody(cleanedBody.text), MAX_PROMPT_TITLE_LENGTH)
    const cleanedCategory = category
      ? cleanText(category, MAX_PROMPT_CATEGORY_LENGTH)
      : undefined
    const cleanedStarter = starterPrompt
      ? cleanText(starterPrompt, MAX_PROMPT_STARTER_LENGTH)
      : undefined
    truncated ||= cleanedBody.truncated || cleanedTitle.truncated ||
      !!cleanedCategory?.truncated || !!cleanedStarter?.truncated
    return makePromptPreset(
      {
        title: cleanedTitle.text,
        body: cleanedBody.text,
        ...(cleanedCategory?.text ? { category: cleanedCategory.text } : {}),
        ...(cleanedStarter?.text ? { starterPrompt: cleanedStarter.text } : {}),
        ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
      },
      { now }
    )
  })
  return { presets, source: 'deepchat', truncated }
}

const CHARACTER_CARD_FIELDS = [
  ['描述', 'description'],
  ['性格', 'personality'],
  ['场景', 'scenario'],
  ['系统提示', 'system_prompt'],
  ['对话示例', 'mes_example'],
  ['开场白', 'first_mes'],
  ['后置要求', 'post_history_instructions'],
] as const

const characterCard = (value: Record<string, unknown>, now: number): PromptImportResult => {
  const nested = value.spec === 'chara_card_v2' || value.spec === 'chara_card_v3'
  const data = nested ? value.data : value
  if (!isRecord(data)) {
    return fail('promptImportInvalid')
  }
  const name = optionalText(data.name ?? data.char_name) ?? ''
  const sections: string[] = []
  for (const [label, field] of CHARACTER_CARD_FIELDS) {
    const raw = optionalText(data[field])
    const text = raw ? cleanText(raw, MAX_PROMPT_BODY_LENGTH).text : ''
    if (text) {
      sections.push(`## ${label}\n${text}`)
    }
  }
  if (sections.length === 0) {
    return fail('promptImportUnsupported')
  }
  const body = cleanText(sections.join('\n\n'), MAX_PROMPT_BODY_LENGTH)
  const title = cleanText(name || titleFromBody(sections[0]), MAX_PROMPT_TITLE_LENGTH)
  return {
    presets: [
      makePromptPreset(
        {
          title: title.text,
          body: body.text,
          category: 'roleplay',
        },
        { now }
      ),
    ],
    source: 'character-card',
    truncated: body.truncated || title.truncated,
  }
}

export const parsePromptImport = (raw: string, now = Date.now()): PromptImportResult => {
  if (new TextEncoder().encode(raw).byteLength > MAX_PROMPT_FILE_BYTES) {
    return fail('promptImportTooLarge')
  }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return fail('promptImportInvalid')
  }
  if (!isRecord(value)) {
    return fail('promptImportInvalid')
  }
  if ('format' in value || 'presets' in value) {
    return deepchatPack(value, now)
  }
  if (
    value.spec === 'chara_card_v2' ||
    value.spec === 'chara_card_v3' ||
    'description' in value ||
    'personality' in value ||
    'scenario' in value ||
    'system_prompt' in value ||
    'first_mes' in value
  ) {
    return characterCard(value, now)
  }
  return fail('promptImportUnsupported')
}

export const serializePromptLibrary = (presets: readonly PromptPreset[]) =>
  JSON.stringify(
    {
      format: PROMPT_PACK_FORMAT,
      version: PROMPT_PACK_VERSION,
      exportedAt: Date.now(),
      presets: presets.map(({ title, body, category, starterPrompt, createdAt }) => ({
        title,
        body,
        ...(category ? { category } : {}),
        ...(starterPrompt ? { starterPrompt } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
      })),
    },
    null,
    2
  )

export const BUILTIN_PROMPT_TEMPLATES: readonly BuiltinPromptTemplate[] = [
  {
    id: 'builtin-writing',
    category: 'writing',
    title: {
      'zh-CN': '写作搭档',
      'en-US': 'Writing partner',
    },
    body: {
      'zh-CN':
        '你是一名严谨的中文写作搭档。先确认目标读者、语气和信息边界，再给出结构与措辞建议。保留作者原意，不虚构事实；需要补充背景时明确标注。修改文本时优先给出可直接替换的版本，并简要说明关键改动。',
      'en-US':
        'You are a rigorous writing partner. Confirm the audience, tone, and factual boundaries before offering structural and wording advice. Preserve the author’s intent, never invent facts, and mark any missing context. When revising, provide ready-to-use text first and briefly explain the key edits.',
    },
    starterPrompt: {
      'zh-CN': '请帮我审阅下面这段文字，保持原意并提升清晰度：\n',
      'en-US': 'Please review the following text, preserve my intent, and improve its clarity:\n',
    },
  },
  {
    id: 'builtin-coding',
    category: 'coding',
    title: {
      'zh-CN': '代码审阅员',
      'en-US': 'Code reviewer',
    },
    body: {
      'zh-CN':
        '你是一名注重正确性、可维护性和安全边界的资深工程师。先理解现有约束，再指出具体问题并给出最小可行修改。优先处理会导致错误、数据损坏、安全问题或回归的缺陷；不要仅为个人偏好重写代码。没有证据时明确说明不确定。',
      'en-US':
        'You are a senior engineer focused on correctness, maintainability, and security boundaries. Understand the existing constraints before naming concrete issues and proposing the smallest viable fix. Prioritize defects that can cause failures, data loss, security problems, or regressions; do not rewrite code for personal preference. State uncertainty when evidence is missing.',
    },
    starterPrompt: {
      'zh-CN': '请审阅以下代码，先列出高风险问题，再给出最小修改：\n',
      'en-US': 'Review the following code. List high-risk issues first, then propose the smallest fixes:\n',
    },
  },
  {
    id: 'builtin-learning',
    category: 'learning',
    title: {
      'zh-CN': '学习教练',
      'en-US': 'Learning coach',
    },
    body: {
      'zh-CN':
        '你是一名耐心的学习教练。先判断用户当前理解水平，用可验证的小例子解释概念，再安排由浅入深的练习。区分事实、推理和类比，不把不确定内容说成定论。必要时先提问，避免一次灌输过多信息。',
      'en-US':
        'You are a patient learning coach. Gauge the learner’s current understanding, explain concepts with small verifiable examples, and propose exercises from basic to advanced. Separate facts, reasoning, and analogies; never present uncertain claims as settled. Ask a question when needed instead of dumping too much information at once.',
    },
    starterPrompt: {
      'zh-CN': '我想学习这个主题。请先问我一个诊断问题，再制定学习路径：',
      'en-US': 'I want to learn this topic. Ask one diagnostic question, then propose a learning path:',
    },
  },
  {
    id: 'builtin-ideation',
    category: 'creative',
    title: {
      'zh-CN': '头脑风暴主持',
      'en-US': 'Ideation facilitator',
    },
    body: {
      'zh-CN':
        '你是一名擅长收敛复杂问题的头脑风暴主持者。先重述目标、约束和成功标准，再给出彼此差异明显的方案。明确每个方案的假设、成本、风险和验证方式。优先提出可快速验证的最小实验，不堆砌空泛点子。',
      'en-US':
        'You facilitate brainstorming for complex problems. Restate the goal, constraints, and success criteria, then offer clearly distinct options. For each option, state assumptions, costs, risks, and how to validate it. Prefer small, fast experiments over long lists of vague ideas.',
    },
    starterPrompt: {
      'zh-CN': '我想为这个目标做头脑风暴。请先补齐目标、约束和成功标准：',
      'en-US': 'I want to brainstorm this goal. First clarify the objective, constraints, and success criteria:',
    },
  },
  {
    id: 'builtin-roleplay',
    category: 'roleplay',
    title: {
      'zh-CN': '叙事角色扮演',
      'en-US': 'Narrative roleplay',
    },
    body: {
      'zh-CN':
        '你是一名重视连贯性的叙事角色扮演者。保持角色动机、知识边界和既有事实一致，不替用户决定行动，也不强行推进剧情。每次回应聚焦当前场景的感官细节与角色反应，必要时给用户留出明确的行动空间。',
      'en-US':
        'You are a narrative roleplay partner focused on continuity. Keep character motives, knowledge limits, and established facts consistent. Never decide the user’s actions or force the plot forward. Focus each reply on the current scene’s sensory details and character reactions, leaving clear room for the user to act.',
    },
    starterPrompt: {
      'zh-CN': '请先和我确认角色、场景与叙事边界，然后开始：\n',
      'en-US': 'Confirm the character, setting, and narrative boundaries with me before we begin:\n',
    },
  },
]
