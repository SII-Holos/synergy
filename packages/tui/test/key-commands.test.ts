import { describe, expect, test } from "bun:test"
import { resolveKeyCommand, type KeyContext } from "../src/key-commands"

const context: KeyContext = {
  modalOpen: false,
  composerFocused: true,
  sessionActive: true,
  sessionBusy: false,
}

describe("key command resolution", () => {
  test("submits the composer with Enter", () => {
    expect(resolveKeyCommand({ name: "return" }, context)).toBe("send-input")
  })

  test("inserts a newline with Shift+Enter", () => {
    expect(resolveKeyCommand({ name: "return", shift: true }, context)).toBe("insert-newline")
  })

  test("aborts a busy session and otherwise exits", () => {
    expect(resolveKeyCommand({ name: "c", ctrl: true }, { ...context, sessionBusy: true })).toBe("abort-session")
    expect(resolveKeyCommand({ name: "c", ctrl: true }, context)).toBe("quit")
  })

  test("navigates composer history", () => {
    expect(resolveKeyCommand({ name: "up" }, context)).toBe("history-previous")
    expect(resolveKeyCommand({ name: "down" }, context)).toBe("history-next")
  })

  test("maps global session and navigation shortcuts", () => {
    expect(resolveKeyCommand({ name: "n", ctrl: true }, context)).toBe("create-session")
    expect(resolveKeyCommand({ name: "p", ctrl: true }, context)).toBe("toggle-pin")
    expect(resolveKeyCommand({ name: "k", ctrl: true }, context)).toBe("open-command-palette")
    expect(resolveKeyCommand({ name: "tab" }, context)).toBe("focus-next")
    expect(resolveKeyCommand({ name: "tab", shift: true }, context)).toBe("focus-previous")
  })

  test("dismisses a modal before blurring the composer", () => {
    expect(resolveKeyCommand({ name: "escape" }, { ...context, modalOpen: true })).toBe("dismiss-modal")
    expect(resolveKeyCommand({ name: "escape" }, context)).toBe("blur-composer")
  })

  test("does not hijack ordinary text or unsupported combinations", () => {
    expect(resolveKeyCommand({ name: "a" }, context)).toBeUndefined()
    expect(resolveKeyCommand({ name: "n", ctrl: true, alt: true }, context)).toBeUndefined()
  })
})
