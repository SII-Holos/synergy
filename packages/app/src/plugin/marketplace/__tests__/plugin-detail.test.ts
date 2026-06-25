import { describe, test, expect } from "bun:test"
import { ratingStars } from "../rating-stars"

describe("ratingStars", () => {
  test("rating 0 returns all empty", () => {
    expect(ratingStars(0)).toEqual(["empty", "empty", "empty", "empty", "empty"])
  })

  test("rating 5 returns all filled", () => {
    expect(ratingStars(5)).toEqual(["filled", "filled", "filled", "filled", "filled"])
  })

  test("rating 3 returns 3 filled + 2 empty", () => {
    expect(ratingStars(3)).toEqual(["filled", "filled", "filled", "empty", "empty"])
  })

  test("rating 4.5 returns 4 filled + 1 half", () => {
    expect(ratingStars(4.5)).toEqual(["filled", "filled", "filled", "filled", "half"])
  })

  test("rating 3.3 returns 3 filled + 2 empty (no half below 0.5)", () => {
    expect(ratingStars(3.3)).toEqual(["filled", "filled", "filled", "empty", "empty"])
  })

  test("rating 3.8 returns 3 filled + 1 half + 1 empty", () => {
    expect(ratingStars(3.8)).toEqual(["filled", "filled", "filled", "half", "empty"])
  })

  test("rating 1.5 returns 1 filled + 1 half + 3 empty", () => {
    expect(ratingStars(1.5)).toEqual(["filled", "half", "empty", "empty", "empty"])
  })

  test("rating 0.7 returns 1 half + 4 empty", () => {
    expect(ratingStars(0.7)).toEqual(["half", "empty", "empty", "empty", "empty"])
  })

  test("rating negative is clamped to 0", () => {
    expect(ratingStars(-1)).toEqual(["empty", "empty", "empty", "empty", "empty"])
  })

  test("rating above max is clamped to max", () => {
    expect(ratingStars(6)).toEqual(["filled", "filled", "filled", "filled", "filled"])
  })

  test("custom max=10 returns correct array length", () => {
    const result = ratingStars(3.5, 10)
    expect(result.length).toBe(10)
    expect(result).toEqual(["filled", "filled", "filled", "half", "empty", "empty", "empty", "empty", "empty", "empty"])
  })

  test("rating rounding edge: 0.49 clamps to 0 half", () => {
    expect(ratingStars(0.49)).toEqual(["empty", "empty", "empty", "empty", "empty"])
  })

  test("rating rounding edge: 0.5 clamps to 1 half", () => {
    expect(ratingStars(0.5)).toEqual(["half", "empty", "empty", "empty", "empty"])
  })

  test("rating rounding edge: 2.99 = 2 filled + 1 half + 2 empty", () => {
    expect(ratingStars(2.99)).toEqual(["filled", "filled", "half", "empty", "empty"])
  })
})
