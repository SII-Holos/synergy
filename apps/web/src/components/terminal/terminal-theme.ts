import type { ITheme } from "ghostty-web"

export type TerminalTheme = ITheme

interface ThemeableTerminal {
  renderer?: {
    setTheme(theme: TerminalTheme): void
  }
}

export function applyTerminalTheme(terminal: ThemeableTerminal, theme: TerminalTheme) {
  terminal.renderer?.setTheme(theme)
}
