import { expect, test } from "bun:test"
import { shouldShowBrowserPresentationSurface } from "../../../../src/components/workspace/browser/browser-presentation"
test("native surface requires an active page and ready local host", () => {
  const state = { presentation: "native" as const, hostStatus: "ready" as const, nativeAvailable: true, pageId: "page" }
  expect(shouldShowBrowserPresentationSurface(state)).toBe(true)
  expect(shouldShowBrowserPresentationSurface({ ...state, hostStatus: "detached" })).toBe(false)
  expect(shouldShowBrowserPresentationSurface({ ...state, nativeAvailable: false })).toBe(false)
  expect(shouldShowBrowserPresentationSurface({ ...state, pageId: null })).toBe(false)
})
