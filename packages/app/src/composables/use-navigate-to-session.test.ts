import { describe, expect, test } from "bun:test"
import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { HOME_SCOPE_KEY } from "@/utils/scope"
import { createSessionNavigator } from "./session-navigator"
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

const session = (id: string, scope: Session["scope"]): Session =>
  ({
    id,
    scope,
  }) as Session

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

describe("global session navigation", () => {
  test("navigates from a global host using a cached session scope", async () => {
    const paths: string[] = []
    const target = session("session-1", { id: "scope-clarus", type: "project", directory: "/workspace/clarus" })
    const navigate = createSessionNavigator({
      findCachedSession: (sessionID) => (sessionID === target.id ? target : undefined),
      getSession: async () => undefined,
      fallbackDir: base64Encode(HOME_SCOPE_KEY),
      fallbackScopeKey: HOME_SCOPE_KEY,
      currentPath: () => "/clarus",
      navigate: (path) => paths.push(path),
    })

    await navigate(target.id)

    expect(paths).toEqual([`/${base64Encode("/workspace/clarus")}/session/${target.id}`])
  })

  test("resolves an uncached session through the global SDK", async () => {
    const paths: string[] = []
    const target = session("session-2", { id: "scope-home", type: "home" })
    const navigate = createSessionNavigator({
      findCachedSession: () => undefined,
      getSession: async () => target,
      fallbackDir: base64Encode(HOME_SCOPE_KEY),
      fallbackScopeKey: HOME_SCOPE_KEY,
      currentPath: () => "/clarus",
      navigate: (path) => paths.push(path),
    })

    await navigate(target.id)

    expect(paths).toEqual([`/${base64Encode(HOME_SCOPE_KEY)}/session/${target.id}`])
  })

  test("falls back to the supplied route when lookup fails", async () => {
    const paths: string[] = []
    const fallbackDir = base64Encode(HOME_SCOPE_KEY)
    const navigate = createSessionNavigator({
      findCachedSession: () => undefined,
      getSession: async () => {
        throw new Error("unavailable")
      },
      fallbackDir,
      fallbackScopeKey: HOME_SCOPE_KEY,
      currentPath: () => "/clarus",
      navigate: (path) => paths.push(path),
    })

    await navigate("missing-session")

    expect(paths).toEqual([`/${fallbackDir}/session/missing-session`])
  })
})
