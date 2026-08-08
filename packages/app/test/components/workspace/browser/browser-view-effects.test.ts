import { describe, expect, test } from "bun:test"
import {
  applyBrowserViewCommand,
  browserNavigationRequestFromTabState,
  resolvePendingBrowserNavigation,
  shouldAutoShowBrowserTool,
  type BrowserWorkspaceController,
} from "../../../../src/components/workspace/browser/browser-view-command"

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
    expect(shouldAutoShowBrowserTool("browser_navigation", { pageId: "page-1" })).toBe(true)
    expect(shouldAutoShowBrowserTool("browser_navigation", { page: { id: "page-1" } })).toBe(true)
  })

  test("ignores non-browser tools and browser metadata without a page identity", () => {
    expect(shouldAutoShowBrowserTool("read", { pageId: "page-1" })).toBe(false)
    expect(shouldAutoShowBrowserTool("browser_navigation", {})).toBe(false)
  })
})
describe("browserNavigationRequestFromTabState", () => {
  test("extracts a navigation request with nonce from tab state", () => {
    expect(browserNavigationRequestFromTabState({ url: "http://127.0.0.1:4097/asset/abc.html", nonce: 3 })).toEqual({
      url: "http://127.0.0.1:4097/asset/abc.html",
      nonce: 3,
    })
  })

  test("ignores missing, empty, or non-string URLs", () => {
    expect(browserNavigationRequestFromTabState(undefined)).toBeUndefined()
    expect(browserNavigationRequestFromTabState(null)).toBeUndefined()
    expect(browserNavigationRequestFromTabState({})).toBeUndefined()
    expect(browserNavigationRequestFromTabState({ url: 42, nonce: 1 })).toBeUndefined()
    expect(browserNavigationRequestFromTabState({ url: "", nonce: 1 })).toBeUndefined()
    expect(browserNavigationRequestFromTabState([])).toBeUndefined()
  })

  test("ignores state without a numeric nonce", () => {
    expect(browserNavigationRequestFromTabState({ url: "http://example.com", nonce: "x" })).toBeUndefined()
    expect(browserNavigationRequestFromTabState({ url: "http://example.com" })).toBeUndefined()
  })
})

describe("resolvePendingBrowserNavigation", () => {
  test("returns a request with an unhandled nonce", () => {
    expect(resolvePendingBrowserNavigation({ url: "http://example.com/page", nonce: 7 }, undefined)).toEqual({
      url: "http://example.com/page",
      nonce: 7,
    })
    expect(resolvePendingBrowserNavigation({ url: "http://example.com/page", nonce: 7 }, 3)).toEqual({
      url: "http://example.com/page",
      nonce: 7,
    })
  })

  test("returns undefined for an already-handled nonce", () => {
    expect(resolvePendingBrowserNavigation({ url: "http://example.com/page", nonce: 7 }, 7)).toBeUndefined()
  })

  test("returns undefined without a valid request", () => {
    expect(resolvePendingBrowserNavigation(undefined, undefined)).toBeUndefined()
    expect(resolvePendingBrowserNavigation({}, undefined)).toBeUndefined()
  })
})
