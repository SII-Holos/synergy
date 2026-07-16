import { describe, expect, test } from "bun:test"
import {
  isSessionNavigationRequestCurrent,
  navigateResolvedSession,
  replaceSessionHistoryUrl,
  sessionRouteReplaceOptions,
  type SessionNavigate,
} from "./use-navigate-to-session-model"

type NavigationCall = [to: string | number, options?: { replace?: boolean; state?: unknown }]

function navigationRecorder() {
  const calls: NavigationCall[] = []
  const navigate = ((to: string | number, options?: NavigationCall[1]) => {
    calls.push([to, options])
  }) as SessionNavigate
  return { calls, navigate }
}

describe("resolved session navigation", () => {
  test("opens a session with the current path as its Back target", () => {
    const { calls, navigate } = navigationRecorder()

    navigateResolvedSession(navigate, {
      intent: "open",
      targetPath: "/scope/session/ses_target",
      currentPath: "/scope/session/ses_source",
      from: undefined,
    })

    expect(calls).toEqual([["/scope/session/ses_target", { state: { from: "/scope/session/ses_source" } }]])
  })

  test("stores and compares Router-relative paths behind a proxy base", () => {
    const opened = navigationRecorder()

    navigateResolvedSession(opened.navigate, {
      intent: "open",
      targetPath: "/scope/session/ses_child",
      currentPath: "/proxy/scope/session/ses_parent",
      from: undefined,
      basePath: "/proxy",
    })

    expect(opened.calls).toEqual([["/scope/session/ses_child", { state: { from: "/scope/session/ses_parent" } }]])

    const returned = navigationRecorder()
    navigateResolvedSession(returned.navigate, {
      intent: "return-to-parent",
      targetPath: "/scope/session/ses_parent",
      currentPath: "/proxy/scope/session/ses_child",
      from: "/scope/session/ses_parent",
      basePath: "/proxy",
    })

    expect(returned.calls).toEqual([[-1, undefined]])
  })

  test("restores the parent history entry when the Back target matches it", () => {
    const { calls, navigate } = navigationRecorder()

    navigateResolvedSession(navigate, {
      intent: "return-to-parent",
      targetPath: "/scope/session/ses_parent",
      currentPath: "/scope/session/ses_child",
      from: "/scope/session/ses_parent",
    })

    expect(calls).toEqual([[-1, undefined]])
  })

  test("replaces a direct child entry when it has no Back target", () => {
    const { calls, navigate } = navigationRecorder()

    navigateResolvedSession(navigate, {
      intent: "return-to-parent",
      targetPath: "/scope/session/ses_parent",
      currentPath: "/scope/session/ses_child",
      from: undefined,
    })

    expect(calls).toEqual([["/scope/session/ses_parent", { replace: true }]])
  })

  test("replaces a child entry when its Back target is not the resolved parent", () => {
    const { calls, navigate } = navigationRecorder()

    navigateResolvedSession(navigate, {
      intent: "return-to-parent",
      targetPath: "/scope-a/session/ses_parent",
      currentPath: "/scope-a/session/ses_child",
      from: "/scope-b/session/ses_parent",
    })

    expect(calls).toEqual([["/scope-a/session/ses_parent", { replace: true }]])
  })
})

describe("session navigation request freshness", () => {
  const depth = 2

  test("accepts the original Router entry", () => {
    expect(
      isSessionNavigationRequestCurrent({
        requestedPath: "/proxy/scope/session/ses_child",
        requestedDepth: depth,
        currentPath: "/proxy/scope/session/ses_child",
        currentDepth: depth,
        basePath: "/proxy",
      }),
    ).toBe(true)
  })

  test("rejects a response after the route changes", () => {
    expect(
      isSessionNavigationRequestCurrent({
        requestedPath: "/scope/session/ses_child",
        requestedDepth: depth,
        currentPath: "/scope/session/ses_other",
        currentDepth: depth,
      }),
    ).toBe(false)
  })

  test("rejects a response for a different history entry at the same path", () => {
    expect(
      isSessionNavigationRequestCurrent({
        requestedPath: "/scope/session/ses_child",
        requestedDepth: depth,
        currentPath: "/scope/session/ses_child",
        currentDepth: depth + 1,
      }),
    ).toBe(false)
  })
})

test("canonical session route replacement preserves navigation state", () => {
  const state = { from: "/scope/session/ses_parent" }
  expect(sessionRouteReplaceOptions(state)).toEqual({ replace: true, state })
})

test("session hash updates preserve the current history state", () => {
  const state = { from: "/scope/session/ses_parent", _depth: 2 }
  const calls: Array<[unknown, string, string]> = []
  const history = {
    state,
    replaceState: (nextState: unknown, title: string, url: string) => calls.push([nextState, title, url]),
  }

  replaceSessionHistoryUrl(history, "/scope/session/ses_child#message-1")

  expect(calls).toEqual([[state, "", "/scope/session/ses_child#message-1"]])
})
