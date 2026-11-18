import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭 */
type HistoryMode = 'list' | 'search' | 'select'
export const useMobileSider = create(() => ({ open: false, mode: 'list' as HistoryMode }))

export const openMobileSider = () => useMobileSider.setState({ open: true, mode: 'list' })
export const setHistoryMode = (mode: HistoryMode) => useMobileSider.setState({ mode })
export const closeMobileSider = () => useMobileSider.setState({ open: false, mode: 'list' })
export const backMobileSider = () => {
  if (useMobileSider.getState().mode === 'list') {
    closeMobileSider()
  } else {
    setHistoryMode('list')
  }
}
