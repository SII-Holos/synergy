import { expect, test } from "bun:test"
import { OrganizationDesktop as Desktop } from "../src/desktop"

test("native project binding accepts opaque revisions and excludes renderer paths and arbitrary failure data", () => {
  const input = {
    requestID: "request-a",
    connectionID: "a".repeat(64),
    projectID: "project-a",
    expectedRevision: "b".repeat(64),
  }
  expect(Desktop.ProjectBind.parse(input)).toEqual(input)
  expect(Desktop.ProjectBind.safeParse({ ...input, directory: "/private/path" }).success).toBe(false)
  expect(Desktop.ProjectBind.safeParse({ ...input, expectedRevision: 1 }).success).toBe(false)
  const current = {
    projectID: "project-a",
    revision: "c".repeat(64),
    binding: { label: "Project", workspaceID: "workspace-a", generation: 2 },
  }
  expect(Desktop.ProjectBindingOutcome.parse({ kind: "revision_conflict", current })).toEqual({
    kind: "revision_conflict",
    current,
  })
  expect(
    Desktop.ProjectBindingOutcome.safeParse({
      kind: "revision_conflict",
      current,
      cause: { directory: "/private/path", stack: "stack" },
    }).success,
  ).toBe(false)
  expect(
    Desktop.ProjectBindingOutcome.safeParse({ kind: "ready", summary: { ...current, directory: "/private/path" } })
      .success,
  ).toBe(false)
})
