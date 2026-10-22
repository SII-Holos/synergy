import { describe, expect, test } from "bun:test"
import type { PluginTextSelectionSnapshot } from "@ericsanchezok/synergy-plugin"
import {
  canQuoteSelection,
  opensOnSelection,
  selectionOrigin,
  selectionOwner,
} from "../../../src/components/text-selection/selection-dom"

const snapshot = (overrides: Partial<PluginTextSelectionSnapshot> = {}): PluginTextSelectionSnapshot => ({
  selectionId: "sel",
  text: "quoted paragraph",
  source: "document",
  origin: "assistant_message",
  editable: false,
  wholeContainer: false,
  ...overrides,
})

describe("selection toolbar eligibility", () => {
  test("opens for conversation prose, code and terminal output", () => {
    expect(opensOnSelection(snapshot())).toBe(true)
    expect(opensOnSelection(snapshot({ origin: "user_message" }))).toBe(true)
    expect(opensOnSelection(snapshot({ origin: "other", source: "code" }))).toBe(true)
    expect(opensOnSelection(snapshot({ origin: "other", source: "terminal" }))).toBe(true)
  })

  test("stays closed for editors and unrelated page chrome", () => {
    expect(opensOnSelection(snapshot({ editable: true, origin: "editable" }))).toBe(false)
    expect(opensOnSelection(snapshot({ origin: "other", source: "document" }))).toBe(false)
  })

  test("quotes only reading-surface selections", () => {
    expect(canQuoteSelection(snapshot())).toBe(true)
    expect(canQuoteSelection(snapshot({ origin: "other", source: "code" }))).toBe(true)
    expect(canQuoteSelection(snapshot({ editable: true, origin: "editable" }))).toBe(false)
  })
})

/**
 * The transcript nests a role-less `[data-message]` container inside the row
 * that carries `data-message-role`. Reading the role from the nearest owner
 * alone classified every real transcript selection as unknown, which silently
 * suppressed the toolbar.
 */
describe("selection origin across the transcript's nested message containers", () => {
  const transcript = (role: "user" | "assistant") => {
    const row = document.createElement("div")
    row.className = "conversation-display-row"
    row.setAttribute("data-message-id", "msg_1")
    row.setAttribute("data-message-role", role)
    const container = document.createElement("div")
    container.setAttribute("data-message", "msg_1")
    const paragraph = document.createElement("p")
    paragraph.textContent = "nighttime clouds, 18°C, no precipitation"
    container.append(paragraph)
    row.append(container)
    document.body.append(row)
    return { row, container, paragraph }
  }

  test("resolves the role from an ancestor row when the owner has none", () => {
    const { container, paragraph } = transcript("assistant")
    const text = paragraph.firstChild!

    expect(selectionOwner(text)).toBe(container)
    expect(selectionOrigin(selectionOwner(text), [text])).toBe("assistant_message")
    expect(opensOnSelection(snapshot({ origin: selectionOrigin(selectionOwner(text), [text]) }))).toBe(true)
  })

  test("resolves a user quote from the same nested shape", () => {
    const { container, paragraph } = transcript("user")
    const text = paragraph.firstChild!
    expect(selectionOrigin(container, [text])).toBe("user_message")
  })

  test("keeps unrelated page chrome out even though an owner exists", () => {
    const chrome = document.createElement("div")
    chrome.setAttribute("data-message", "")
    const label = document.createElement("span")
    label.textContent = "sidebar label"
    chrome.append(label)
    document.body.append(chrome)
    const text = label.firstChild!

    const origin = selectionOrigin(selectionOwner(text), [text])
    expect(origin).toBe("other")
    expect(opensOnSelection(snapshot({ origin }))).toBe(false)
  })
})
