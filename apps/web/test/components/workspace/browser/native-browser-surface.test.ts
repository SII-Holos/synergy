import { describe, expect, test } from "bun:test"
import {
  nativeBounds,
  nativeBrowserViewVisible,
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
