import { describe, expect, test } from "bun:test"
import { normalizeTuiOptions } from "../src/options"

describe("TUI option normalization", () => {
  test("uses runtime defaults without inventing scope", () => {
    expect(normalizeTuiOptions({})).toEqual({
      baseUrl: "http://127.0.0.1:4096",
      directory: undefined,
      scopeID: undefined,
      sessionID: undefined,
      theme: "system",
    })
  })

  test("normalizes server URLs and trims identifiers", () => {
    expect(
      normalizeTuiOptions({
        baseUrl: "http://localhost:5000///",
        directory: " /workspace ",
        sessionID: " session_1 ",
        theme: "dark",
      }),
    ).toEqual({
      baseUrl: "http://localhost:5000",
      directory: "/workspace",
      scopeID: undefined,
      sessionID: "session_1",
      theme: "dark",
    })
  })

  test("rejects unsupported protocols, credentials, and fragments", () => {
    expect(() => normalizeTuiOptions({ baseUrl: "file:///tmp/socket" })).toThrow("http or https")
    expect(() => normalizeTuiOptions({ baseUrl: "http://user:pass@localhost:4096" })).toThrow("credentials")
    expect(() => normalizeTuiOptions({ baseUrl: "http://localhost:4096/#x" })).toThrow("path, query, or fragment")
  })

  test("rejects conflicting scope selectors and blank explicit values", () => {
    expect(() => normalizeTuiOptions({ directory: "/workspace", scopeID: "scope_1" })).toThrow("either")
    expect(() => normalizeTuiOptions({ sessionID: "   " })).toThrow("session")
  })
})
