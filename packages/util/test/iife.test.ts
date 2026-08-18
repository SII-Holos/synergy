import { describe, expect, test } from "bun:test"
import { iife } from "../src/iife"

describe("iife", () => {
  test("invokes the callback immediately and returns its result", () => {
    let calls = 0
    const value = iife(() => {
      calls++
      return 42
    })
    expect(calls).toBe(1)
    expect(value).toBe(42)
  })

  test("keeps the inner scope private", () => {
    const value = iife(() => {
      const secret = "hidden"
      return secret.length
    })
    expect(value).toBe(6)
  })
})
