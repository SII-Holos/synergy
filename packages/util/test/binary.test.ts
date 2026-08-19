import { describe, expect, test } from "bun:test"
import { Binary } from "../src/binary"

interface Item {
  id: string
  label: string
}

const byId = (item: Item) => item.id

const sorted = (labels: string[]): Item[] =>
  labels.map((label, index) => ({ id: String.fromCharCode(97 + index), label }))

describe("Binary.search", () => {
  test("finds elements at every position of a sorted array", () => {
    const items = sorted(["alpha", "beta", "gamma", "delta", "epsilon"])
    for (const expected of items) {
      expect(Binary.search(items, expected.id, byId)).toEqual({ found: true, index: items.indexOf(expected) })
    }
  })

  test("returns the insertion index when the id is absent", () => {
    const items = sorted(["alpha", "gamma"])
    expect(Binary.search(items, "0", byId)).toEqual({ found: false, index: 0 })
    expect(Binary.search(items, "aa", byId)).toEqual({ found: false, index: 1 })
    expect(Binary.search(items, "z", byId)).toEqual({ found: false, index: 2 })
  })

  test("handles an empty array", () => {
    expect(Binary.search([], "a", byId)).toEqual({ found: false, index: 0 })
  })
})

describe("Binary.insert", () => {
  test("inserts in sorted position and keeps the array sorted", () => {
    const items = sorted(["alpha", "gamma"])
    const inserted = Binary.insert(items, { id: "aa", label: "alpha-two" }, byId)
    expect(inserted.map(byId)).toEqual(["a", "aa", "b"])
    expect(inserted).toBe(items)
  })

  test("inserts at the head and tail", () => {
    const items: Item[] = [{ id: "b", label: "beta" }]
    Binary.insert(items, { id: "a", label: "alpha" }, byId)
    Binary.insert(items, { id: "d", label: "delta" }, byId)
    Binary.insert(items, { id: "c", label: "gamma" }, byId)
    expect(items.map(byId)).toEqual(["a", "b", "c", "d"])
  })

  test("inserts into an empty array", () => {
    const items: Item[] = []
    Binary.insert(items, { id: "a", label: "alpha" }, byId)
    expect(items.map(byId)).toEqual(["a"])
  })
})
