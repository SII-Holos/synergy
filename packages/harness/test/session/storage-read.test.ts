import { describe, expect, test } from "bun:test"
import { emptyOnNotFound } from "../../src/session/storage-read"
import { Storage } from "../../src/storage/storage"

describe("emptyOnNotFound", () => {
  test("returns empty array for Storage.NotFoundError", () => {
    const err = new Storage.NotFoundError({ message: "missing" })
    const result = emptyOnNotFound<never>(err)
    expect(result).toEqual([])
  })

  test("throws for a generic Error", () => {
    const err = new Error("disk full")
    expect(() => emptyOnNotFound(err)).toThrow("disk full")
  })

  test("throws for a non-Error value", () => {
    expect(() => emptyOnNotFound("not an error")).toThrow("not an error")
  })

  test("throws for an Error subclass that is not NotFoundError", () => {
    const err = new TypeError("bad type")
    expect(() => emptyOnNotFound(err)).toThrow("bad type")
  })
})
