import { create } from 'zustand'

type TurnSelectionState = {
  sessionId: string | null
  selectedUserIds: string[]
}

/** 当前会话的按轮多选删除状态 */
export const useTurnSelection = create<TurnSelectionState>(() => ({
  sessionId: null,
  selectedUserIds: [],
}))

export const startTurnSelection = (sessionId: string, userId?: string) =>
  useTurnSelection.setState({
    sessionId,
    selectedUserIds: userId ? [userId] : [],
  })

export const toggleTurnSelection = (sessionId: string, userId: string) =>
  useTurnSelection.setState((state) => {
    if (state.sessionId !== sessionId) {
      return { sessionId, selectedUserIds: [userId] }
    }
    const exists = state.selectedUserIds.includes(userId)
    return {
      sessionId,
      selectedUserIds: exists
        ? state.selectedUserIds.filter((id) => id !== userId)
        : [...state.selectedUserIds, userId],
    }
  })

export const selectAllTurns = (sessionId: string, userIds: string[]) =>
  useTurnSelection.setState({ sessionId, selectedUserIds: userIds })

export const clearTurnSelection = () =>
  useTurnSelection.setState({ sessionId: null, selectedUserIds: [] })
