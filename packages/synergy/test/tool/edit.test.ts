import { describe, expect, test } from "bun:test"
import { replace } from "../../src/tool/edit"

describe("tool.edit replace", () => {
  test("rejects a single anchored block when only the wrapper lines match", () => {
    const content = [
      "async function syncProfile() {",
      "  const profile = await loadProfile()",
      "  return profile",
      "}",
    ].join("\n")

    const oldString = [
      "async function syncProfile() {",
      "  await deleteEverythingFromProduction()",
      "  process.exit(1)",
      "}",
    ].join("\n")

    expect(() =>
      replace(
        content,
        oldString,
        "async function syncProfile() {\n  await deleteEverythingFromProduction()\n  process.exit(0)\n}",
      ),
    ).toThrow("oldString not found in content")
  })

  test("does not accept a single block-anchor candidate with unrelated middle lines", () => {
    const content = [
      "function example() {",
      "  const value = foo()",
      "  return value",
      "}",
      "",
      "const untouched = true",
    ].join("\n")

    const oldString = [
      "function example() {",
      "  await completelyDifferentWorkflow({ alpha: 1, beta: 2, gamma: 3 })",
      "  throw new Error('stop')",
      "}",
    ].join("\n")

    expect(() =>
      replace(
        content,
        oldString,
        "function example() {\n  await completelyDifferentWorkflow({ alpha: 1, beta: 2, gamma: 3 })\n  throw new Error('retry')\n}",
      ),
    ).toThrow("oldString not found in content")
  })

  test("accepts a single block-anchor candidate when the middle lines are still similar enough", () => {
    const content = ["function example() {", "  const value = foo()", "  return value", "}"].join("\n")

    const oldString = ["function example() {", "  const result = foo()", "  return value", "}"].join("\n")

    expect(replace(content, oldString, "function example() {\n  const result = bar()\n  return value\n}")).toContain(
      "const result = bar()",
    )
  })

  test("still rejects ambiguous matches when the same block appears twice", () => {
    const duplicated = [
      "function example() {",
      "  const value = foo()",
      "  return value",
      "}",
      "",
      "function example() {",
      "  const value = foo()",
      "  return value",
      "}",
    ].join("\n")

    const oldString = ["function example() {", "  const value = foo()", "  return value", "}"].join("\n")

    expect(() =>
      replace(duplicated, oldString, "function example() {\n  const value = bar()\n  return value\n}"),
    ).toThrow("Found multiple matches for oldString")
  })
})
