import { Service } from '@deepseek-ai/cordis'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

const provider = 'deepseek-account'
const client = {
  version: '0.2.2-rc.5',
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
}

async function send(frame) {
  if (!process.stdout.write(`${JSON.stringify(frame)}\n`)) await once(process.stdout, 'drain')
}

function toMessage(message) {
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content.flatMap((block) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'thinking') return [{ type: 'reasoning', text: block.thinking }]
        if (message.role === 'assistant') return []
        throw Object.assign(new Error('Unsupported attachment'), { code: 'ACCOUNT_ATTACHMENT' })
      })
  return message.role === 'assistant'
    ? { role: 'assistant', content: blocks, source: { kind: 'model', provider, model: 'deepseek-chat' } }
    : { role: 'user', content: blocks, source: { kind: 'user' } }
}

export default class DeepChatMobile extends Service {
  static inject = ['deepseekAccount', 'llm', 'webServer']

  constructor(ctx) {
    super(ctx, 'deepchatMobile')
    this.requests = new Map()
  }

  [Service.init]() {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
    input.on('line', (line) => {
      let request
      try { request = JSON.parse(line) } catch { return }
      void this.handle(request)
    })
    input.on('close', () => {
      for (const controller of this.requests.values()) controller.abort()
    })
  }

  async handle({ id, method, params = {} }) {
    const account = this.ctx.deepseekAccount
    try {
      let result
      switch (method) {
        case 'state': result = await account.getState(); break
        case 'signIn':
          result = await account.startSignIn(client, this.ctx.webServer.getOrigin(), 'desktop')
          break
        case 'cancelSignIn': {
          const { attempt } = await account.getState()
          if (attempt) await account.cancelSignIn(attempt.id)
          result = await account.getState()
          break
        }
        case 'signOut': result = await account.signOut(client); break
        case 'balance': result = { balance: await account.getBalance(client) }; break
        case 'chat':
          await this.chat(id, params)
          result = {}
          break
        case 'cancelChat':
          this.requests.get(params.id)?.abort()
          result = {}
          break
        default: throw new Error('Unknown runtime operation')
      }
      await send({ id, result })
    } catch (error) {
      const failure = error.failure ?? error
      await send({ id, error: {
        code: typeof failure.code === 'string' ? failure.code : 'ACCOUNT_RUNTIME',
        status: Number.isInteger(failure.status) ? failure.status : undefined,
      } })
    }
  }

  async chat(id, body) {
    const controller = new AbortController()
    this.requests.set(id, controller)
    try {
      const model = body.model === 'deepseek-v4-pro' ? body.model : 'deepseek-chat'
      const reminder = body.messages.findLast((message) => message.role === 'latest_reminder')
      const messages = body.messages.filter((message) => message.role !== 'latest_reminder')
        .map(toMessage).filter((message) => message.content.length)
      for await (const chunk of this.ctx.llm.stream({
        provider,
        model,
        system: reminder ? `${body.system}\n\n${reminder.content}` : body.system,
        messages,
        reasoningEffort: body.thinking.type === 'enabled' ? 'high' : 'off',
        signal: controller.signal,
      })) {
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') throw chunk.reason.failure
          await send({ id, chunk: { type: 'finish', reason: chunk.reason.kind } })
        } else if (chunk.type === 'block-end') {
          await send({ id, chunk: { type: 'block-end', index: chunk.index } })
        } else {
          await send({ id, chunk })
        }
      }
    } finally {
      this.requests.delete(id)
    }
  }
}
