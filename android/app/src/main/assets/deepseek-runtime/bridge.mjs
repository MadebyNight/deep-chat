import { Service } from '@deepseek-ai/cordis'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { openAsBlob } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const client = {
  version: '0.2.2-rc.5',
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
}

async function send(frame) {
  if (!process.stdout.write(`${JSON.stringify(frame)}\n`)) await once(process.stdout, 'drain')
}

export default class DeepChatMobile extends Service {
  static inject = ['deepseekAccount', 'webServer']

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
        case 'profile': {
          const profile = await account.getProfile(client)
          if (profile?.status !== 'ready') {
            result = { profile: null }
            break
          }
          const { name, avatarUrl } = profile.value
          const avatar = typeof avatarUrl === 'string' && URL.canParse(avatarUrl) ? new URL(avatarUrl) : null
          result = { profile: {
            name: name?.trim() || null,
            avatarUrl: avatar?.protocol === 'https:' && !avatar.username && !avatar.password ? avatar.href : null,
          } }
          break
        }
        case 'transcribe': result = await this.transcribe(id); break
        case 'upload':
        case 'messages':
        case 'synthesize': result = await this.requestAccount(id, method, params); break
        case 'cancelChat':
          this.requests.get(params.id)?.abort()
          result = {}
          break
        default: throw new Error('Unknown runtime operation')
      }
      await send({ id, result })
    } catch (error) {
      const failure = error.failure ?? error
      const networkCodes = [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_SOCKET',
      ]
      const networkFailure =
        failure instanceof TypeError ||
        failure?.name === 'TypeError' ||
        networkCodes.includes(failure?.code) ||
        networkCodes.includes(failure?.cause?.code)
      const inputOverflow = method === 'messages' && [undefined, 400, 413, 422].includes(failure.status) && (
        /^(context_length_exceeded|context_window_exceeded|input_token_limit_exceeded)$/i.test(failure.code ?? '') ||
        /maximum context length is\s+[\d,]+\s+tokens|(?:input tokens|input token count)\s*\([^)]*\)\s*exceed(?:s|ed)?\s+(?:the )?(?:maximum|context)|(?:input|prompt) (?:length|tokens).*exceed(?:s|ed)?.*(?:context window|context length|input token limit)/i.test(failure.message ?? '')
      )
      await send({ id, error: {
        code: inputOverflow ? 'context_length_exceeded'
          : networkFailure ? 'ACCOUNT_NETWORK'
            : typeof failure.code === 'string' ? failure.code : 'ACCOUNT_RUNTIME',
        status: Number.isInteger(failure.status) ? failure.status : undefined,
        ...(error.upstream && { detail: failure.message?.slice(0, 2048) }),
      } })
    }
  }

  async requestAccount(id, method, params) {
    const controller = new AbortController()
    this.requests.set(id, controller)
    const upload = method === 'upload'
    const synthesize = method === 'synthesize'
    const endpoint = synthesize ? 'https://api.deepseek.com/v1/tools/tts'
      : `https://api.deepseek.com/anthropic/v1/${upload ? 'files' : 'messages'}`
    const path = upload && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
      ? join(tmpdir(), `deepchat-upload-${id}`) : undefined
    try {
      const account = this.ctx.deepseekAccount
      const token = await account.resolveToken(endpoint)
      if (!token) throw Object.assign(new Error('Missing account authorization'), { code: 'ACCOUNT_SIGN_IN_REQUIRED' })
      const headers = { 'x-dsh-auth-token': token }
      let body
      if (upload) {
        if (!path || typeof params.name !== 'string' || !params.name || /[\r\n\0]/.test(params.name) ||
            ![null, 'user_data', 'rich_layout_recognition'].includes(params.purpose)) {
          throw new Error('Invalid upload parameters')
        }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = await file.stat()
          const limit = (params.purpose === 'user_data' ? 32 : 64) * 1024 * 1024
          if (!stat.isFile() || stat.size > limit) throw new Error('Invalid upload size')
        } finally {
          await file.close()
        }
        body = new FormData()
        if (params.purpose) body.set('purpose', params.purpose)
        body.set('file', await openAsBlob(path, { type: params.mimeType }), params.name)
        headers['anthropic-version'] = '2023-06-01'
        headers['anthropic-beta'] = 'files-api-2025-04-14'
      } else {
        headers['content-type'] = 'application/json'
        if (!synthesize) {
          headers.accept = 'text/event-stream'
          headers['anthropic-version'] = '2023-06-01'
          if (params.messages.some(({ content }) => Array.isArray(content) &&
              content.some(({ type }) => type === 'image' || type === 'document'))) {
            headers['anthropic-beta'] = 'files-api-2025-04-14'
          }
        }
        body = JSON.stringify(params)
      }
      const response = await fetch(endpoint, {
        method: 'POST', headers, body, redirect: 'error', signal: controller.signal,
      })
      if (!response.ok) {
        const { error } = await response.json().catch(() => ({}))
        if (response.status === 401) await account.rejectToken(token)
        throw Object.assign(new Error(typeof error?.message === 'string' ? error.message : ''), {
          code: response.status === 401 ? 'ACCOUNT_SIGN_IN_REQUIRED' : error?.code ?? error?.type ?? 'ACCOUNT_HTTP',
          status: response.status,
          upstream: true,
        })
      }
      if (upload) {
        const { id: fileId } = await response.json()
        if (typeof fileId !== 'string' || !fileId) throw new Error('Invalid upload response')
        return { id: fileId }
      }
      if (!response.body || (!synthesize && !response.headers.get('content-type')?.includes('text/event-stream'))) {
        await response.body?.cancel()
        throw new Error('Invalid account stream')
      }
      for await (const bytes of response.body) {
        for (let start = 0; start < bytes.length; start += 16384) {
          const data = Buffer.from(bytes.subarray(start, start + 16384)).toString('base64')
          await send({ id, chunk: { type: 'bytes', data } })
        }
      }
      return {}
    } finally {
      this.requests.delete(id)
      if (path) await unlink(path).catch(() => {})
    }
  }

  async transcribe(id) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
      throw Object.assign(new Error('Invalid recording ID'), { code: 'ACCOUNT_ASR_FAILED' })
    }
    const endpoint = 'https://api.deepseek.com/v1/tools/asr'
    const path = join(tmpdir(), `deepchat-asr-${id}.wav`)
    const controller = new AbortController()
    this.requests.set(id, controller)
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let audio
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size <= 44 || stat.size > 44 + 120 * 16000 * 2) {
          throw new Error('Invalid recording size')
        }
        audio = await file.readFile({ signal: controller.signal })
        if (audio.length !== stat.size || audio.toString('ascii', 0, 4) !== 'RIFF' ||
            audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid recording format')
      } finally {
        await file.close()
        await unlink(path).catch(() => {})
      }
      const token = await this.ctx.deepseekAccount.resolveToken(endpoint)
      if (!token) throw Object.assign(new Error('Missing account authorization'), { code: 'ACCOUNT_SIGN_IN_REQUIRED' })
      const body = new FormData()
      body.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'x-dsh-auth-token': token },
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
        body,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw Object.assign(new Error('Account transcription failed'), { code: 'ACCOUNT_ASR_FAILED', status: response.status })
      }
      const result = await response.json()
      if (typeof result?.text !== 'string') throw new Error('Invalid transcription response')
      return { text: result.text }
    } finally {
      this.requests.delete(id)
    }
  }
}
