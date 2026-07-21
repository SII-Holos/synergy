import { afterEach, describe, expect, test } from "bun:test"
import { transferRawMessagesPaneFocus, updateRawMessagesSelectAll } from "./raw-messages-interaction"

afterEach(() => {
  document.body.innerHTML = ""
})

describe("raw messages narrow-pane focus", () => {
  test("moves focus into preview and restores it to the originating row", () => {
    const row = document.createElement("button")
    const back = document.createElement("button")
    document.body.append(row, back)
    const schedule = (callback: () => void) => callback()

    row.focus()
    expect(document.activeElement).toBe(row)
    expect(transferRawMessagesPaneFocus({ narrow: true, target: back, schedule })).toBe(true)
    expect(document.activeElement).toBe(back)

    expect(transferRawMessagesPaneFocus({ narrow: true, target: row, schedule })).toBe(true)
    expect(document.activeElement).toBe(row)
  })

  test("keeps desktop row focus stable", () => {
    const row = document.createElement("button")
    const back = document.createElement("button")
    document.body.append(row, back)

    row.focus()
    expect(transferRawMessagesPaneFocus({ narrow: false, target: back, schedule: (callback) => callback() })).toBe(
      false,
    )
    expect(document.activeElement).toBe(row)
  })
})

describe("raw messages select-all state", () => {
  test("exposes partial selection as a native mixed checkbox", () => {
    const input = document.createElement("input")
    input.type = "checkbox"

    updateRawMessagesSelectAll(input, { all: false, partial: true })
    expect(input.checked).toBe(false)
    expect(input.indeterminate).toBe(true)
    expect(input.getAttribute("aria-checked")).toBe("mixed")

    updateRawMessagesSelectAll(input, { all: true, partial: false })
    expect(input.checked).toBe(true)
    expect(input.indeterminate).toBe(false)
    expect(input.getAttribute("aria-checked")).toBe("true")
  })
})
