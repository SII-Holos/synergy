import { describe, expect, test } from "bun:test"
import { MismatchError } from "../../src/hashline/index"
import { formatAnchoredContext } from "../../src/hashline/messages"
import { HEADTAIL_DRIFT_WARNING, RECOVERY_SESSION_REPLAY_WARNING } from "../../src/hashline/index"

// ============================================================================
// MismatchError
// ============================================================================
describe("MismatchError", () => {
  test("is an Error subclass with expected shape", () => {
    const err = new MismatchError({
      expectedFileHash: "AAAA",
      actualFileHash: "BBBB",
      fileLines: ["a", "b", "c"],
    })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(MismatchError)
    expect(err.name).toBe("MismatchError")
  })

  test("exposes path, expectedFileHash, actualFileHash, and fileLines", () => {
    const err = new MismatchError({
      path: "src/foo.ts",
      expectedFileHash: "AAAA",
      actualFileHash: "BBBB",
      fileLines: ["a", "b", "c"],
    })
    expect(err.path).toBe("src/foo.ts")
    expect(err.expectedFileHash).toBe("AAAA")
    expect(err.actualFileHash).toBe("BBBB")
    expect(err.fileLines).toEqual(["a", "b", "c"])
  })

  test("hashRecognized defaults to true and is exposed", () => {
    const err = new MismatchError({ expectedFileHash: "AAAA", actualFileHash: "BBBB", fileLines: ["x"] })
    expect(err.hashRecognized).toBe(true)
  })

  test("hashRecognized false produces 'not from this session' message", () => {
    const err = new MismatchError({
      expectedFileHash: "AAAA",
      actualFileHash: "BBBB",
      fileLines: ["x"],
      hashRecognized: false,
    })
    expect(err.message).toContain("not from this session")
  })
})

// ============================================================================
// Mismatch message formatting
// ============================================================================
describe("mismatch message formatting", () => {
  test("file-changed message includes path, tag, and current hash", () => {
    const err = new MismatchError({
      path: "src/foo.ts",
      expectedFileHash: "AAAA",
      actualFileHash: "BBBB",
      fileLines: [],
    })
    expect(err.message).toContain("src/foo.ts")
    expect(err.message).toContain("AAAA")
    expect(err.message).toContain("BBBB")
  })

  test("message includes context when anchor lines are provided", () => {
    const err = new MismatchError({
      path: "src/foo.ts",
      expectedFileHash: "AAAA",
      actualFileHash: "BBBB",
      fileLines: ["line1", "line2", "line3", "line4"],
      anchorLines: [2],
    })
    // Context formatting should be present
    expect(err.message).toContain("*2:")
  })

  test("not-from-session message includes bogus tag and guidance", () => {
    const err = new MismatchError({
      expectedFileHash: "AAAA",
      actualFileHash: "BBBB",
      fileLines: ["x"],
      hashRecognized: false,
    })
    expect(err.message).toContain("AAAA")
    expect(err.message).toContain("not from this session")
  })

  test("formatAnchoredContext includes asterisk markers at anchor lines", () => {
    const context = formatAnchoredContext([3], ["line1", "line2", "line3", "line4", "line5"])
    expect(context.some((line) => line.startsWith("*3:"))).toBe(true)
  })

  test("formatAnchoredContext silently skips out-of-range anchor lines", () => {
    const context = formatAnchoredContext([99], ["line1"])
    expect(context.length).toBe(0)
  })
})

// ============================================================================
// HEADTAIL_DRIFT_WARNING
// ============================================================================
describe("HEADTAIL_DRIFT_WARNING", () => {
  test("is a defined string with meaningful content", () => {
    expect(typeof HEADTAIL_DRIFT_WARNING).toBe("string")
    expect(HEADTAIL_DRIFT_WARNING.length).toBeGreaterThan(10)
    expect(HEADTAIL_DRIFT_WARNING).toMatch(/snapshot|stale|head|tail/i)
  })
})

// ============================================================================
// RECOVERY_SESSION_REPLAY_WARNING
// ============================================================================
describe("RECOVERY_SESSION_REPLAY_WARNING", () => {
  test("is a defined string that references verifying the diff", () => {
    expect(typeof RECOVERY_SESSION_REPLAY_WARNING).toBe("string")
    expect(RECOVERY_SESSION_REPLAY_WARNING.length).toBeGreaterThan(10)
    expect(RECOVERY_SESSION_REPLAY_WARNING).toMatch(/replay|verify|diff/i)
  })
})
