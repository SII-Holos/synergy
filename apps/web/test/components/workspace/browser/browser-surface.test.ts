import { describe, expect, test } from "bun:test"
import {
  shouldShowBrowserPresentationSurface,
  webRTCHostStatus,
} from "../../../../src/components/workspace/browser/browser-presentation"

describe("Browser presentation recovery", () => {
  test("keeps the WebRTC surface mounted while Host signaling recovers", () => {
    expect(
      shouldShowBrowserPresentationSurface({
        presentation: "webrtc",
        hostStatus: "detached",
        nativeAvailable: false,
        pageId: "page-1",
      }),
    ).toBe(true)
    expect(
      shouldShowBrowserPresentationSurface({
        presentation: "webrtc",
        hostStatus: "pending",
        nativeAvailable: false,
        pageId: "page-1",
      }),
    ).toBe(true)
    expect(
      shouldShowBrowserPresentationSurface({
        presentation: "native",
        hostStatus: "detached",
        nativeAvailable: true,
        pageId: "page-1",
      }),
    ).toBe(false)
    expect(
      shouldShowBrowserPresentationSurface({
        presentation: "native",
        hostStatus: "ready",
        nativeAvailable: true,
        pageId: "page-1",
      }),
    ).toBe(true)
  })

  test("maps WebRTC signaling readiness back to workspace Host status", () => {
    expect(webRTCHostStatus("host_pending")).toBe("pending")
    expect(webRTCHostStatus("host_ready")).toBe("ready")
    expect(webRTCHostStatus("signaling")).toBeUndefined()
  })
})

test("an explicitly remote client can attach its first page before the initial capability snapshot refreshes", () => {
  const pending = {
    presentation: undefined,
    hostStatus: "ready" as const,
    nativeAvailable: false,
    pageId: "page-first",
  }
  expect(shouldShowBrowserPresentationSurface({ ...pending, clientPresentation: "webrtc" })).toBe(true)
  expect(shouldShowBrowserPresentationSurface({ ...pending, clientPresentation: "native" })).toBe(false)
  expect(shouldShowBrowserPresentationSurface({ ...pending, clientPresentation: "webrtc", pageId: null })).toBe(false)
  expect(
    shouldShowBrowserPresentationSurface({ ...pending, presentation: "webrtc", clientPresentation: "native" }),
  ).toBe(false)
})
