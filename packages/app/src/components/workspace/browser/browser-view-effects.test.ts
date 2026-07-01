import { describe, expect, test } from "bun:test"
import {
  applyBrowserViewCommand,
  shouldAutoShowBrowserTool,
  type BrowserWorkspaceController,
} from "./browser-view-command"

function controller() {
  const calls: string[] = []
  const workspace: BrowserWorkspaceController = {
    openPanel(panelId, options) {
      calls.push(`open:${panelId}:${options?.reuseExisting === true}`)
    },
    surface(surface) {
      return {
        close() {
          calls.push(`close:${surface}`)
        },
      }
    },
  }
  return { calls, workspace }
}

describe("applyBrowserViewCommand", () => {
  test("show and focus activate the Browser workspace", () => {
    const show = controller()
    expect(applyBrowserViewCommand({ workspaceCommand: "show" }, show.workspace)).toBe(true)
    expect(show.calls).toEqual(["open:browser:true"])

    const focus = controller()
    expect(applyBrowserViewCommand({ action: "focus" }, focus.workspace)).toBe(true)
    expect(focus.calls).toEqual(["open:browser:true"])
  })

  test("hide closes the workspace", () => {
    const hide = controller()
    expect(applyBrowserViewCommand({ workspaceCommand: "hide" }, hide.workspace)).toBe(true)
    expect(hide.calls).toEqual(["close:side"])
  })

  test("status has no frontend side effect", () => {
    const status = controller()
    expect(applyBrowserViewCommand({ workspaceCommand: "status" }, status.workspace)).toBe(false)
    expect(status.calls).toEqual([])
  })
})

describe("shouldAutoShowBrowserTool", () => {
  test("shows Browser workspace for completed browser tool metadata with page identity", () => {
    expect(shouldAutoShowBrowserTool("browser_navigate", { pageId: "page-1" })).toBe(true)
    expect(shouldAutoShowBrowserTool("browser_navigate", { page: { id: "page-1" } })).toBe(true)
  })

  test("ignores non-browser tools and browser metadata without a page identity", () => {
    expect(shouldAutoShowBrowserTool("read", { pageId: "page-1" })).toBe(false)
    expect(shouldAutoShowBrowserTool("browser_navigate", {})).toBe(false)
  })
})
