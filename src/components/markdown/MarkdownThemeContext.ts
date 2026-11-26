import { createContext, useContext } from 'react'
import type { Theme } from '../../app/theme.js'

export const MarkdownThemeContext = createContext<Theme | null>(null)

export const useMarkdownTheme = (fallback: Theme): Theme =>
  useContext(MarkdownThemeContext) ?? fallback
