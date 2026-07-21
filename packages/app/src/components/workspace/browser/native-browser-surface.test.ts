import { describe, expect, test } from "bun:test"
import { nativeBounds } from "./native-browser-surface"

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
