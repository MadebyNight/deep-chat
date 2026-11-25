import { create } from 'zustand'
import type { ExportSelection } from '../../services/chat/exportFormats.js'

export type ExportFormat = 'markdown' | 'image' | 'print'

type ExportDialogState = {
  target: ExportSelection | null
  initialFormat: ExportFormat
}

export const useExportDialog = create<ExportDialogState>(() => ({
  target: null,
  initialFormat: 'markdown',
}))

export const openExportDialog = (
  target: ExportSelection,
  initialFormat: ExportFormat = 'markdown'
) => {
  useExportDialog.setState({ target, initialFormat })
}

export const closeExportDialog = () => {
  useExportDialog.setState({ target: null })
}
