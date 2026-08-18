import { describe, expect, test } from "bun:test"
import { lazy } from "../src/lazy"

describe("lazy", () => {
  test("computes the value once and reuses it", () => {
    let computations = 0
    const getValue = lazy(() => {
      computations++
      return { stable: true }
    })
    const first = getValue()
    const second = getValue()
    expect(first).toBe(second)
    expect(computations).toBe(1)
  })

  test("is per-instance", () => {
    const left = lazy(() => "left")
    const right = lazy(() => "right")
    expect(left()).toBe("left")
    expect(right()).toBe("right")
  })

  test("supports falsy cached values", () => {
    const getValue = lazy(() => 0)
    expect(getValue()).toBe(0)
    expect(getValue()).toBe(0)
  })

  test("does not swallow errors from the factory", () => {
    const getValue = lazy(() => {
      throw new Error("factory failed")
    })
    expect(() => getValue()).toThrow("factory failed")
  })
})
