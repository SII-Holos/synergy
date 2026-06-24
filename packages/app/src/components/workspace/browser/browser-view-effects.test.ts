import { describe, expect, test } from "bun:test"
import { applyBrowserViewCommand, type BrowserWorkspaceController } from "./browser-view-command"

function controller() {
  const calls: string[] = []
  const workspace: BrowserWorkspaceController = {
    setActive(id) {
      calls.push(`active:${id}`)
    },
    openPanel() {
      calls.push("open")
    },
    closePanel() {
      calls.push("close")
    },
  }
  return { calls, workspace }
}

describe("applyBrowserViewCommand", () => {
  test("show and focus activate the Browser workspace", () => {
    const show = controller()
    expect(applyBrowserViewCommand({ workspaceCommand: "show" }, show.workspace)).toBe(true)
    expect(show.calls).toEqual(["active:browser", "open"])

    const focus = controller()
    expect(applyBrowserViewCommand({ action: "focus" }, focus.workspace)).toBe(true)
    expect(focus.calls).toEqual(["active:browser", "open"])
  })

  test("hide closes the workspace", () => {
    const hide = controller()
    expect(applyBrowserViewCommand({ workspaceCommand: "hide" }, hide.workspace)).toBe(true)
    expect(hide.calls).toEqual(["close"])
  })

  test("status has no frontend side effect", () => {
    const status = controller()
    expect(applyBrowserViewCommand({ workspaceCommand: "status" }, status.workspace)).toBe(false)
    expect(status.calls).toEqual([])
  })
})
