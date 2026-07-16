import { describe, expect, test } from "bun:test"
import { navigateResolvedSession, type SessionNavigate } from "./use-navigate-to-session-model"

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
