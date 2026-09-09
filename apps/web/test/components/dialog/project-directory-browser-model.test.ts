import { describe, expect, test } from "bun:test"
import {
  createInitialDirectoryBrowserState,
  directoryBrowserCanSubmit,
  directoryBrowserClearDraft,
  directoryBrowserSetDraft,
  directoryBrowserStatusCopy,
  directoryBrowserSubmitError,
  directoryBrowserSubmitStart,
  directoryBrowserSubmitSuccess,
  resolveDirectorySearch,
} from "../../../src/components/dialog/project-directory-browser-model"

const home = "/home/user"

describe("project directory browser model", () => {
  test("typing updates draft without browsing", () => {
    const state = directoryBrowserSetDraft(createInitialDirectoryBrowserState(home), "focus")
    expect(state.draft).toBe("focus")
    expect(state.status).toBe("idle")
    expect(state.requestID).toBe(0)
  })

  test("submit resolves path and query once before browsing", () => {
    const typed = directoryBrowserSetDraft(createInitialDirectoryBrowserState(home), "~/projects/synergy")
    const loading = directoryBrowserSubmitStart(typed, home)
    expect(loading.submitted).toBe("~/projects/synergy")
    expect(loading.resolved).toEqual({ path: "/home/user/projects", query: "synergy" })
    expect(loading.status).toBe("loading")
    expect(loading.requestID).toBe(1)
  })

  test("enter and button share the same submit path", () => {
    const typed = directoryBrowserSetDraft(createInitialDirectoryBrowserState(home), "focus")
    expect(directoryBrowserSubmitStart(typed, home)).toEqual(directoryBrowserSubmitStart(typed, home))
  })

  test("loading state appears only for submitted searches", () => {
    const idle = directoryBrowserSetDraft(createInitialDirectoryBrowserState(home), "focus")
    expect(idle.status).toBe("idle")
    expect(directoryBrowserSubmitStart(idle, home).status).toBe("loading")
  })

  test("idle state does not show no-results copy", () => {
    const copy = directoryBrowserStatusCopy(createInitialDirectoryBrowserState(home))
    expect(copy.title.message).toBe("Search the server filesystem")
  })

  test("empty submitted result shows no-folders copy", () => {
    const loading = directoryBrowserSubmitStart(createInitialDirectoryBrowserState(home), home)
    const empty = directoryBrowserSubmitSuccess(loading, loading.requestID, [])
    const copy = directoryBrowserStatusCopy(empty)
    expect(empty.status).toBe("empty")
    expect(copy.title.message).toBe("No folders found")
  })

  test("failed browse gives recoverable error state", () => {
    const loading = directoryBrowserSubmitStart(createInitialDirectoryBrowserState(home), home)
    const failed = directoryBrowserSubmitError(loading, loading.requestID, new Error("denied"))
    const copy = directoryBrowserStatusCopy(failed)
    expect(failed.status).toBe("error")
    expect(failed.error).toBe("denied")
    expect(copy.title.message).toBe("Search failed")
  })

  test("stale request result is ignored", () => {
    const first = directoryBrowserSubmitStart(createInitialDirectoryBrowserState(home), home)
    const second = directoryBrowserSubmitStart({ ...first, status: "ready" }, home)
    const stale = directoryBrowserSubmitSuccess(second, first.requestID, ["/stale"])
    expect(stale.results).toEqual([])
    expect(stale.status).toBe("loading")
  })

  test("clear with a non-empty draft preserves visible search state", () => {
    const loading = directoryBrowserSubmitStart(
      directoryBrowserSetDraft(createInitialDirectoryBrowserState(home), "focus"),
      home,
    )
    const ready = directoryBrowserSubmitSuccess(loading, loading.requestID, ["/home/user/focus"])
    const edited = directoryBrowserSetDraft(ready, "different")
    const cleared = directoryBrowserClearDraft(edited, home)

    expect(cleared.draft).toBe("")
    expect(cleared.submitted).toBe("focus")
    expect(cleared.resolved).toEqual(ready.resolved)
    expect(cleared.status).toBe("ready")
    expect(cleared.results).toEqual(["/home/user/focus"])
    expect(cleared.requestID).toBe(ready.requestID)
  })

  test("clear with an empty draft resets visible search state and invalidates stale requests", () => {
    const loading = directoryBrowserSubmitStart(
      directoryBrowserSetDraft(createInitialDirectoryBrowserState(home), "focus"),
      home,
    )
    const ready = directoryBrowserSubmitSuccess(loading, loading.requestID, ["/home/user/focus"])
    const draftCleared = directoryBrowserClearDraft(ready, home)
    const cleared = directoryBrowserClearDraft(draftCleared, home)

    expect(draftCleared.draft).toBe("")
    expect(draftCleared.status).toBe("ready")
    expect(cleared.draft).toBe("")
    expect(cleared.status).toBe("idle")
    expect(cleared.results).toEqual([])
    expect(cleared.requestID).toBe(ready.requestID + 1)
    expect(directoryBrowserSubmitSuccess(cleared, ready.requestID, ["/stale"])).toEqual(cleared)
  })

  test("empty draft can submit when home is available", () => {
    expect(directoryBrowserCanSubmit(createInitialDirectoryBrowserState(home), home)).toBe(true)
    expect(directoryBrowserCanSubmit(createInitialDirectoryBrowserState(home), undefined)).toBe(false)
  })

  test("submitted results are not filtered by the draft query in the model", () => {
    const loading = directoryBrowserSubmitStart(createInitialDirectoryBrowserState(home), home)
    const ready = directoryBrowserSetDraft(
      directoryBrowserSubmitSuccess(loading, loading.requestID, ["/home/user/projects/synergy"]),
      "different",
    )
    expect(ready.results).toEqual(["/home/user/projects/synergy"])
  })

  test("resolveDirectorySearch delegates path parsing", () => {
    expect(resolveDirectorySearch("~/projects/synergy", home)).toEqual({
      path: "/home/user/projects",
      query: "synergy",
    })
  })
})
