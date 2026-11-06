import { describe, expect, test } from "bun:test"
import {
  nativeBounds,
  nativeBrowserViewVisible,
  shouldCaptureCover,
  coverMatchesPage,
} from "../../../../src/components/workspace/browser/native-browser-surface"

describe("nativeBounds", () => {
  test("returns finite integer bounds only after the Browser surface has a real size", () => {
    expect(nativeBounds({ x: 10.4, y: 20.6, width: 800.2, height: 600.8 })).toEqual({
      x: 10,
      y: 21,
      width: 800,
      height: 601,
    })
    expect(nativeBounds({ x: 0, y: 0, width: 0, height: 600 })).toBeNull()
    expect(nativeBounds({ x: 0, y: 0, width: Number.NaN, height: 600 })).toBeNull()
  })
})

describe("nativeBrowserViewVisible", () => {
  test("hides the native view behind blocking DOM overlays", () => {
    expect(
      nativeBrowserViewVisible({
        appDialogOpen: false,
        fileChooserOpen: false,
        pageDialogOpen: false,
      }),
    ).toBe(true)
    expect(
      nativeBrowserViewVisible({
        appDialogOpen: true,
        fileChooserOpen: false,
        pageDialogOpen: false,
      }),
    ).toBe(false)
    expect(
      nativeBrowserViewVisible({
        appDialogOpen: false,
        fileChooserOpen: true,
        pageDialogOpen: false,
      }),
    ).toBe(false)
    expect(
      nativeBrowserViewVisible({
        appDialogOpen: false,
        fileChooserOpen: false,
        pageDialogOpen: true,
      }),
    ).toBe(false)
  })
})

test("native presentation stays hidden until every Browser overlay closes", () => {
  const base = { appDialogOpen: false, fileChooserOpen: false, pageDialogOpen: false }
  expect(nativeBrowserViewVisible({ ...base, controlsOpen: true })).toBe(false)
  expect(nativeBrowserViewVisible({ ...base, annotationOpen: true })).toBe(false)
  expect(nativeBrowserViewVisible({ ...base, workspaceMenuOpen: true })).toBe(false)
  expect(nativeBrowserViewVisible({ ...base, workspaceMenuOpen: false, controlsOpen: true })).toBe(false)
  expect(nativeBrowserViewVisible({ ...base, workspaceMenuOpen: true, controlsOpen: false })).toBe(false)
  expect(nativeBrowserViewVisible({ ...base, controlsOpen: false, annotationOpen: false })).toBe(true)
})

describe("shouldCaptureCover", () => {
  const ready = {
    visible: true,
    hostReady: true,
    hasBounds: true,
    page: { status: "active", isLoading: false, url: "https://example.test" },
  }

  test("precaptures only while a settled page is actually shown", () => {
    expect(shouldCaptureCover(ready)).toBe(true)
    expect(shouldCaptureCover({ ...ready, visible: false })).toBe(false)
    expect(shouldCaptureCover({ ...ready, hostReady: false })).toBe(false)
    expect(shouldCaptureCover({ ...ready, hasBounds: false })).toBe(false)
    expect(shouldCaptureCover({ ...ready, page: null })).toBe(false)
  })

  test("skips pages that cannot produce a useful still", () => {
    expect(shouldCaptureCover({ ...ready, page: { status: "suspended", url: "https://example.test" } })).toBe(false)
    expect(
      shouldCaptureCover({ ...ready, page: { status: "active", isLoading: true, url: "https://example.test" } }),
    ).toBe(false)
    expect(shouldCaptureCover({ ...ready, page: { status: "active", url: "about:blank" } })).toBe(false)
    expect(shouldCaptureCover({ ...ready, page: { status: "active", url: "" } })).toBe(false)
  })
})

describe("coverMatchesPage", () => {
  test("accepts a still only for the page and URL it was captured from", () => {
    const page = { id: "page-1", url: "https://example.test" }
    expect(coverMatchesPage({ pageId: "page-1", url: "https://example.test" }, page)).toBe(true)
    expect(coverMatchesPage({ pageId: "page-2", url: "https://example.test" }, page)).toBe(false)
    expect(coverMatchesPage({ pageId: "page-1", url: "https://example.test/next" }, page)).toBe(false)
    expect(coverMatchesPage(undefined, page)).toBe(false)
    expect(coverMatchesPage({ pageId: "page-1", url: "https://example.test" }, null)).toBe(false)
  })
})
