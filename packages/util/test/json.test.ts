import { describe, expect, test } from "bun:test"
import { parsePartialJson } from "../src/json"

describe("parsePartialJson", () => {
  test("parses complete JSON directly", () => {
    expect(parsePartialJson('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] })
  })

  test("returns an empty object for invalid input", () => {
    expect(parsePartialJson("")).toEqual({})
    expect(parsePartialJson("not json at all")).toEqual({})
    expect(parsePartialJson("{broken")).toEqual({})
  })

  test("fast-path returns any complete JSON value", () => {
    expect(parsePartialJson("42") as unknown).toBe(42)
    expect(parsePartialJson('"text"') as unknown).toBe("text")
    expect(parsePartialJson("[1, 2, 3]") as unknown).toEqual([1, 2, 3])
  })

  test("closes a trailing unclosed string value", () => {
    expect(parsePartialJson('{"name": "synergy')).toEqual({ name: "synergy" })
  })

  test("recovers the last complete pair from a truncated object", () => {
    expect(parsePartialJson('{"done": 1, "missing": 2, "cut": "val')).toEqual({
      done: 1,
      missing: 2,
      cut: "val",
    })
    expect(parsePartialJson('{"first": {"nested": [1, 2]}, "second": {"unfinished')).toEqual({
      first: { nested: [1, 2] },
      second: {},
    })
  })

  test("keeps scalar tokens completed at the top level", () => {
    expect(parsePartialJson('{"count": 42, "flag": true, "nothing": null, "partial":')).toEqual({
      count: 42,
      flag: true,
      nothing: null,
    })
    expect(parsePartialJson('{"neg": -3.5, "exp": 1e2, "cut":')).toEqual({ neg: -3.5, exp: 100 })
  })

  test("handles trailing separators and whitespace", () => {
    expect(parsePartialJson('{"a": 1,}')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a": 1,  ')).toEqual({ a: 1 })
  })

  test("does not treat escaped quotes or commas inside strings as structure", () => {
    expect(parsePartialJson('{"text": "comma, brace } and \\"quote", "next": 2, "cut"')).toEqual({
      text: 'comma, brace } and "quote',
      next: 2,
    })
  })

  test("truncates trailing backslashes before repair", () => {
    expect(parsePartialJson('{"a": "value\\')).toEqual({ a: "value" })
  })

  test("recovers top-level array fragments", () => {
    expect(parsePartialJson('{"list": [1, 2, {"x": 3}]}')).toEqual({ list: [1, 2, { x: 3 }] })
    expect(parsePartialJson('{"list": [1, 2, {"x": 3}, "cut"')).toEqual({ list: [1, 2, { x: 3 }, "cut"] })
  })
})
