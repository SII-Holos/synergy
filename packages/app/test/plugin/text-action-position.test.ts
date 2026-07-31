import { describe, expect, test } from "bun:test"
import { placeTextActionSurface } from "../../src/plugin/text-action-position"

describe("text-action result placement", () => {
  test("stays by the selection when the result fits below", () => {
    expect(
      placeTextActionSurface({ x: 120, y: 140 }, { width: 300, height: 200 }, { width: 900, height: 700 }),
    ).toEqual({ x: 120, y: 140 })
  })

  test("flips above and clamps at viewport edges", () => {
    expect(
      placeTextActionSurface({ x: 780, y: 620 }, { width: 300, height: 240 }, { width: 900, height: 700 }),
    ).toEqual({ x: 592, y: 380 })
    expect(placeTextActionSurface({ x: -20, y: 5 }, { width: 300, height: 900 }, { width: 900, height: 700 })).toEqual({
      x: 8,
      y: 8,
    })
  })
})
