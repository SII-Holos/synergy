import { describe, expect, test } from "bun:test"
import {
  formatResolveCap,
  formatToolAllowlist,
  isDestructiveRemoval,
  parseResolveCap,
  parseToolAllowlist,
  secretSourceLabel,
  validateSecretDraft,
  type SecretEntryLike,
} from "../../../../src/components/settings/panels/secrets-panel-model"

function entry(input?: Partial<SecretEntryLike>): SecretEntryLike {
  return {
    id: "abc123def456",
    source: { kind: "user" },
    resolvedCount: 0,
    createdAt: 1,
    ...input,
  }
}

describe("secrets panel model", () => {
  test("secretSourceLabel falls back to user for unknown shapes", () => {
    expect(secretSourceLabel(entry())).toBe("user")
    expect(secretSourceLabel(entry({ source: { kind: "config", path: "provider.x" } }))).toBe("config")
    expect(secretSourceLabel(entry({ source: { kind: "heuristic", context: "tool_output" } }))).toBe("heuristic")
    expect(secretSourceLabel(entry({ source: {} }))).toBe("user")
  })

  test("removal is destructive exactly when the key has resolved", () => {
    expect(isDestructiveRemoval(entry())).toBe(false)
    expect(isDestructiveRemoval(entry({ resolvedCount: 3 }))).toBe(true)
  })

  test("parseToolAllowlist trims, drops empties, and yields undefined for blank input", () => {
    expect(parseToolAllowlist("bash, mcp , ,save_file")).toEqual(["bash", "mcp", "save_file"])
    expect(parseToolAllowlist("  ")).toBeUndefined()
    expect(parseToolAllowlist("")).toBeUndefined()
  })

  test("parseResolveCap accepts only positive integers", () => {
    expect(parseResolveCap("5")).toBe(5)
    expect(parseResolveCap(" 12 ")).toBe(12)
    expect(parseResolveCap("0")).toBeUndefined()
    expect(parseResolveCap("-2")).toBeUndefined()
    expect(parseResolveCap("abc")).toBeUndefined()
    expect(parseResolveCap("")).toBeUndefined()
  })

  test("format helpers round-trip policy fields", () => {
    expect(formatToolAllowlist({ tools: ["bash", "mcp"] })).toBe("bash, mcp")
    expect(formatToolAllowlist({})).toBe("")
    expect(formatResolveCap({ maxResolvesPerSession: 4 })).toBe("4")
    expect(formatResolveCap({})).toBe("")
  })

  test("validateSecretDraft rejects blank values", () => {
    expect(validateSecretDraft("sk-abc")).toBeUndefined()
    expect(validateSecretDraft("   ")).toBe("empty")
    expect(validateSecretDraft("")).toBe("empty")
  })
})
