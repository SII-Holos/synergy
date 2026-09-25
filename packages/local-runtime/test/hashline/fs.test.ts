import { describe, expect, test } from "bun:test"
import { InMemoryFilesystem, NotFoundError, isNotFound } from "../../src/hashline/fs"

// ============================================================================
// InMemoryFilesystem
// ============================================================================
describe("InMemoryFilesystem", () => {
  test("stores and retrieves file content", async () => {
    const fs = new InMemoryFilesystem([["a.ts", "hello\n"]])
    const content = await fs.readText("a.ts")
    expect(content).toBe("hello\n")
  })

  test("get helper returns sync access", () => {
    const fs = new InMemoryFilesystem([["a.ts", "hello\n"]])
    expect(fs.get("a.ts")).toBe("hello\n")
  })

  test("writes content to a file", async () => {
    const fs = new InMemoryFilesystem()
    await fs.writeText("a.ts", "world\n")
    expect(fs.get("a.ts")).toBe("world\n")
  })

  test("throws NotFoundError for non-existent read", async () => {
    const fs = new InMemoryFilesystem()
    await expect(fs.readText("ghost.ts")).rejects.toThrow(NotFoundError)
  })

  test("exists returns true for existing files", async () => {
    const fs = new InMemoryFilesystem([["a.ts", "hello\n"]])
    expect(await fs.exists("a.ts")).toBe(true)
  })

  test("exists returns false for missing files", async () => {
    const fs = new InMemoryFilesystem()
    expect(await fs.exists("ghost.ts")).toBe(false)
  })

  test("clear removes all entries", () => {
    const fs = new InMemoryFilesystem([["a.ts", "hello"]])
    fs.clear()
    expect(fs.get("a.ts")).toBeUndefined()
  })

  test("delete removes a single entry", () => {
    const fs = new InMemoryFilesystem([["a.ts", "hello"]])
    expect(fs.delete("a.ts")).toBe(true)
    expect(fs.get("a.ts")).toBeUndefined()
  })

  test("entries iterates over all pairs", () => {
    const fs = new InMemoryFilesystem([
      ["a.ts", "hello"],
      ["b.ts", "world"],
    ])
    const pairs = [...fs.entries()]
    expect(pairs).toHaveLength(2)
  })
})

// ============================================================================
// NotFoundError
// ============================================================================
describe("NotFoundError", () => {
  test("is a proper error with the file path", () => {
    const err = new NotFoundError("ghost.ts")
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("ghost.ts")
  })

  test("has ENOENT code", () => {
    const err = new NotFoundError("ghost.ts")
    expect(err.code).toBe("ENOENT")
  })
})

// ============================================================================
// isNotFound
// ============================================================================
describe("isNotFound", () => {
  test("returns true for NotFoundError instances", () => {
    expect(isNotFound(new NotFoundError("x"))).toBe(true)
  })

  test("returns true for Error with ENOENT code", () => {
    const err = new Error("Not found")
    ;(err as Error & { code: string }).code = "ENOENT"
    expect(isNotFound(err)).toBe(true)
  })

  test("returns false for regular errors", () => {
    expect(isNotFound(new Error("other"))).toBe(false)
  })

  test("returns false for null/undefined", () => {
    expect(isNotFound(null)).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
  })
})
