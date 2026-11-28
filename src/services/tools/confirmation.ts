import { create } from 'zustand'

export type ToolConfirmationRequest = {
  replyId: string
  toolUseId: string
  name: string
  serverName?: string
  input: Record<string, unknown>
}

export type ToolConfirmationDecision = 'allow' | 'deny' | 'cancel'

type PendingConfirmation = {
  resolve: (decision: ToolConfirmationDecision) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

const pending = new Map<string, PendingConfirmation>()

const keyFor = (replyId: string, toolUseId: string) => `${replyId}:${toolUseId}`

export const useToolConfirmation = create<{ requests: ToolConfirmationRequest[] }>(() => ({
  requests: [],
}))

const clearRequest = (replyId: string, toolUseId: string) => {
  useToolConfirmation.setState((state) => ({
    requests: state.requests.filter(
      (request) => request.replyId !== replyId || request.toolUseId !== toolUseId
    ),
  }))
}

export const requestToolConfirmation = (
  replyId: string,
  toolUseId: string,
  details: Omit<ToolConfirmationRequest, 'replyId' | 'toolUseId'>,
  signal: AbortSignal
): Promise<ToolConfirmationDecision> => {
  signal.throwIfAborted()
  const key = keyFor(replyId, toolUseId)
  pending.get(key)?.reject(new DOMException('Superseded', 'AbortError'))
  return new Promise<ToolConfirmationDecision>((resolve, reject) => {
    const abort = () => {
      pending.delete(key)
      clearRequest(replyId, toolUseId)
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    pending.set(key, {
      resolve: (decision) => {
        cleanup()
        pending.delete(key)
        clearRequest(replyId, toolUseId)
        resolve(decision)
      },
      reject: (error) => {
        cleanup()
        pending.delete(key)
        clearRequest(replyId, toolUseId)
        reject(error)
      },
      cleanup,
    })
    useToolConfirmation.setState((state) => ({
      requests: [...state.requests, { replyId, toolUseId, ...details }],
    }))
  })
}

export const answerToolConfirmation = (
  replyId: string,
  toolUseId: string,
  decision: ToolConfirmationDecision
) => {
  pending.get(keyFor(replyId, toolUseId))?.resolve(decision)
}

export const clearToolConfirmations = (replyId: string) => {
  for (const [key, item] of pending) {
    if (key.startsWith(`${replyId}:`)) {
      item.reject(new DOMException('Cancelled', 'AbortError'))
    }
  }
}
