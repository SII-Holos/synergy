import { describe, expect, test } from "bun:test"
import { Identifier } from "../src/identifier"

describe("Identifier.create", () => {
  test("produces 26-character ids with a hex timestamp prefix and base62 tail", () => {
    const id = Identifier.create(false)
    expect(id).toHaveLength(26)
    expect(id.slice(0, 12)).toMatch(/^[0-9a-f]{12}$/)
    expect(id.slice(12)).toMatch(/^[0-9A-Za-z]{14}$/)
  })

  test("keeps the same timestamp prefix and bumps the monotonic counter", () => {
    const timestamp = 1_700_000_000_000
    const first = Identifier.create(false, timestamp)
    const second = Identifier.create(false, timestamp)
    expect(first.slice(0, 11)).toBe(second.slice(0, 11))
    expect(first).not.toBe(second)
    expect(first.slice(0, 12)).toMatch(/^[0-9a-f]{12}$/)
  })

  test("different timestamps produce different time prefixes", () => {
    const first = Identifier.create(false, 1_700_000_000_000)
    const second = Identifier.create(false, 1_700_000_100_000)
    expect(first.slice(0, 12)).not.toBe(second.slice(0, 12))
  })
})

describe("Identifier ordering helpers", () => {
  test("ascending ids sort by time prefix while descending ids invert it", () => {
    const early = Identifier.ascending()
    const late = Identifier.ascending()
    expect(early.slice(0, 12) <= late.slice(0, 12)).toBe(true)

    const descendingEarly = Identifier.descending()
    const descendingLate = Identifier.descending()
    expect(descendingEarly.slice(0, 12) >= descendingLate.slice(0, 12)).toBe(true)
  })

  test("descending ids invert the timestamp bits", () => {
    const timestamp = 1_700_000_000_000
    const ascending = Identifier.create(false, timestamp).slice(0, 12)
    const descending = Identifier.create(true, timestamp).slice(0, 12)
    expect(descending).not.toBe(ascending)
    expect(descending).toMatch(/^[0-9a-f]{12}$/)
  })
})
