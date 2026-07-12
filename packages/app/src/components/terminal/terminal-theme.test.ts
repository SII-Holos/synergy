import { describe, expect, test } from "bun:test"
import { applyTerminalTheme, type TerminalTheme } from "./terminal-theme"

describe("terminal theme application", () => {
  test("updates the live Ghostty renderer", () => {
    const applied: TerminalTheme[] = []
    const theme: TerminalTheme = {
      background: "#111111",
      foreground: "#eeeeee",
      cursor: "#eeeeee",
      selectionBackground: "#eeeeee40",
    }

    applyTerminalTheme(
      {
        renderer: {
          setTheme(next) {
            applied.push(next)
          },
        },
      },
      theme,
    )

    expect(applied).toEqual([theme])
  })

  test("does nothing before the renderer is ready", () => {
    expect(() => applyTerminalTheme({}, { background: "#111111" })).not.toThrow()
  })
})
