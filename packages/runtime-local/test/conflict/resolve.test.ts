import { describe, expect, test } from "bun:test"
import { resolveAllConflicts } from "../../src/conflict/resolve"

describe("resolveAllConflicts", () => {
  test("preserves mixed line endings outside resolved conflict blocks", () => {
    const original =
      "before-crlf\r\nbefore-lf\n<<<<<<< HEAD\r\nlocal\r\n=======\nremote\r\n>>>>>>> main\nafter-crlf\r\nafter-lf\n"

    expect(resolveAllConflicts(original, [{ conflict: 1, strategy: "ours" }])).toBe(
      "before-crlf\r\nbefore-lf\nlocal\r\nafter-crlf\r\nafter-lf\n",
    )
  })

  test("preserves marker-like ours content in a standard conflict", () => {
    const original = [
      "before",
      "<<<<<<< HEAD",
      "||||||| literal",
      "keep",
      "=======",
      "remote",
      ">>>>>>> main",
      "after",
      "",
    ].join("\n")

    expect(resolveAllConflicts(original, [{ conflict: 1, strategy: "ours" }])).toBe(
      ["before", "||||||| literal", "keep", "after", ""].join("\n"),
    )
  })

  test("removes a diff3 base only when the resolution declares diff3 format", () => {
    const original = [
      "before",
      "<<<<<<< HEAD",
      "local",
      "||||||| base",
      "ancestor",
      "=======",
      "remote",
      ">>>>>>> main",
      "after",
      "",
    ].join("\n")

    expect(resolveAllConflicts(original, [{ conflict: 1, strategy: "ours", conflictStyle: "diff3" }])).toBe(
      "before\nlocal\nafter\n",
    )
  })

  test("rejects diff3 declarations without exactly one base marker", () => {
    const original = ["<<<<<<< HEAD", "local", "=======", "remote", ">>>>>>> main", ""].join("\n")

    expect(() => resolveAllConflicts(original, [{ conflict: 1, strategy: "ours", conflictStyle: "diff3" }])).toThrow(
      /conflict 1.*exactly one diff3 base marker/i,
    )
  })

  test("preserves standalone marker-like lines outside complete conflicts", () => {
    const original = [
      "Heading",
      "=======",
      "before",
      "<<<<<<< HEAD",
      "local",
      "=======",
      "remote",
      ">>>>>>> main",
      "after",
      "",
    ].join("\n")

    expect(resolveAllConflicts(original, [{ conflict: 1, strategy: "theirs" }])).toBe(
      ["Heading", "=======", "before", "remote", "after", ""].join("\n"),
    )
  })
})
