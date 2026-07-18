import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { messages, workspace, panels, browser, fileWorkbench, fileExplorer, terminal, sessionReview } from "./messages"

describe("i18n message descriptors", () => {
  test("all descriptors are defined with id and message", () => {
    const all = Object.values(messages)
    for (const group of all) {
      for (const [key, desc] of Object.entries(group)) {
        expect(desc.id).toBeString()
        expect(desc.id).not.toBe("")
        expect(desc.message).toBeString()
        expect(desc.message).not.toBe("")
      }
    }
  })

  test("every id uses the app.* namespace", () => {
    const all = Object.values(messages)
    for (const group of all) {
      for (const [_key, desc] of Object.entries(group)) {
        expect(desc.id.startsWith("app.")).toBe(true)
      }
    }
  })

  test("every id is globally unique", () => {
    const ids = new Map<string, string>()
    const all = Object.values(messages)
    for (const [groupName, group] of Object.entries(all)) {
      for (const [key, desc] of Object.entries(group)) {
        if (ids.has(desc.id)) {
          const prev = ids.get(desc.id)
          throw new Error(`Duplicate message id "${desc.id}" in ${groupName}.${key} (previously in ${prev})`)
        }
        ids.set(desc.id, `${groupName}.${key}`)
      }
    }
    expect(ids.size).toBeGreaterThan(0)
  })

  test("ids resolve against an i18n instance", () => {
    const i18n = setupI18n({ locale: "en" })

    const catalog: Record<string, string> = {}
    const all = Object.values(messages)
    for (const group of all) {
      for (const [_key, desc] of Object.entries(group)) {
        catalog[desc.id] = desc.message
      }
    }
    i18n.loadAndActivate({ locale: "en", messages: catalog })

    // Spot-check representative surface-level labels.
    expect(i18n._(workspace.panelUnavailable.id)).toBe("Panel unavailable")
    expect(i18n._(workspace.noSidePanels.id)).toBe("No side panels available")
    expect(i18n._(workspace.noBottomPanels.id)).toBe("No bottom panels available")
    expect(i18n._(panels.notes.id)).toBe("Notes")
    expect(i18n._(panels.files.id)).toBe("Files")
    expect(i18n._(panels.browser.id)).toBe("Browser")
    expect(i18n._(panels.terminal.id)).toBe("Terminal")
    expect(i18n._(browser.ready.id)).toBe("Browser ready")
    expect(i18n._(browser.connecting.id)).toBe("Connecting to Browser")
    expect(i18n._(browser.disconnected.id)).toBe("Browser disconnected")
    expect(i18n._(browser.noPage.id)).toBe("No page open")
    expect(i18n._(browser.navBack.id)).toBe("Back")
    expect(i18n._(browser.navForward.id)).toBe("Forward")
    expect(i18n._(browser.enterUrl.id)).toBe("Enter URL or search")
    expect(i18n._(fileWorkbench.openAFile.id)).toBe("Open a file")
    expect(i18n._(fileWorkbench.unableToOpen.id)).toBe("Unable to open file")
    expect(i18n._(fileWorkbench.retry.id)).toBe("Retry")
    expect(i18n._(fileExplorer.label.id)).toBe("Files")
    expect(i18n._(terminal.loading.id)).toBe("Loading terminal...")
    expect(i18n._(terminal.closed.id)).toBe("Terminal closed")
    expect(i18n._(terminal.sessionLost.id)).toBe("Session lost")
    expect(i18n._(terminal.reconnecting.id)).toBe("Reconnecting...")
    expect(i18n._(sessionReview.loading.id)).toBe("Loading changes…")
  })

  test("descriptors with ICU placeholders pass through with a values bag", () => {
    const i18n = setupI18n({ locale: "en" })
    i18n.loadAndActivate({
      locale: "en",
      messages: { [browser.chooseFilesDescription.id]: browser.chooseFilesDescription.message },
    })

    expect(
      i18n._({
        id: browser.chooseFilesDescription.id,
        message: browser.chooseFilesDescription.message,
        values: { count: 1 },
      }),
    ).toBe("The page requested a file.")
    expect(
      i18n._({
        id: browser.chooseFilesDescription.id,
        message: browser.chooseFilesDescription.message,
        values: { count: 5 },
      }),
    ).toBe("The page requested one or more files.")
  })

  test("descriptors that start with {title} produce Close {title}", () => {
    const i18n = setupI18n({ locale: "en" })
    i18n.loadAndActivate({ locale: "en", messages: { [workspace.closeTab.id]: workspace.closeTab.message } })

    expect(i18n._({ id: workspace.closeTab.id, message: workspace.closeTab.message, values: { title: "Notes" } })).toBe(
      "Close Notes",
    )
  })

  test("file loading descriptor issues Loading {path}…", () => {
    const i18n = setupI18n({ locale: "en" })
    i18n.loadAndActivate({ locale: "en", messages: { [fileWorkbench.loading.id]: fileWorkbench.loading.message } })

    expect(
      i18n._({ id: fileWorkbench.loading.id, message: fileWorkbench.loading.message, values: { path: "src/app.ts" } }),
    ).toBe("Loading src/app.ts…")
  })
})
