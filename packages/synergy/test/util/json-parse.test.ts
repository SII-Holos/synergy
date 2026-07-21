import { describe, expect, test } from "bun:test"
import { parseJson } from "../../src/util/json-parse"

describe("parseJson", () => {
  test("returns empty object for null input", () => {
    expect(Object.keys(parseJson(null))).toEqual([])
  })

  test("returns empty object for undefined input", () => {
    expect(Object.keys(parseJson(undefined))).toEqual([])
  })

  test("returns empty object for empty string input", () => {
    expect(Object.keys(parseJson(""))).toEqual([])
  })

  test("parses valid JSON string", () => {
    const result = parseJson<{ key: string; num: number }>('{"key":"value","num":42}')
    expect(result.key).toBe("value")
    expect(result.num).toBe(42)
  })

  test("returns empty object for invalid JSON string", () => {
    expect(Object.keys(parseJson("{invalid json}"))).toEqual([])
  })

  test("parses non-object JSON (array) as-is", () => {
    expect(parseJson<unknown[]>("[1,2,3]")).toEqual([1, 2, 3])
  })

  test("returns empty object for non-object JSON (number)", () => {
    expect(Object.keys(parseJson("42"))).toEqual([])
  })

  test("returns empty object for non-object JSON (string)", () => {
    expect(Object.keys(parseJson('"hello"'))).toEqual([])
  })

  test("parses JSON with nested objects", () => {
    const result = parseJson<{ nested: { value: string } }>('{"nested":{"value":"deep"}}')
    expect(result.nested?.value).toBe("deep")
  })
})
