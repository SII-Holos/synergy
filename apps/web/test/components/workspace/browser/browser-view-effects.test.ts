import { describe, expect, test } from "bun:test"
import {
  browserNavigationRequestFromTabState,
  resolvePendingBrowserNavigation,
} from "../../../../src/components/workspace/browser/browser-view-command"

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
