import { expect, test } from "bun:test"
import { sanitizePromptValue } from "../../src/context/prompt/sanitize"
import { resolveSessionReference } from "../../src/utils/session-reference"

const scopes = [
  { id: "parent", local: { directory: "/repo", worktree: "/repo", sandboxes: ["/repo/child"] } },
  { id: "child", local: { directory: "/repo/child", worktree: "/repo/child", sandboxes: [] } },
]
test("old draft references preserve unresolved data and resolve exact bindings before aliases", () => {
  const old = { type: "session", id: "part", sessionId: "session", directory: "/repo/child", title: "Saved reference" }
  const sanitized = sanitizePromptValue([old])[0]!
  expect(sanitized).toMatchObject({ scopeID: null, legacyDirectory: "/repo/child" })
  expect(
    resolveSessionReference(sanitized as unknown as Parameters<typeof resolveSessionReference>[0], scopes),
  ).toMatchObject({ scopeID: "child", title: "Saved reference" })
  expect(() =>
    resolveSessionReference(sanitized as unknown as Parameters<typeof resolveSessionReference>[0], []),
  ).toThrow("Saved reference")
  expect(sanitized.legacyDirectory).toBe("/repo/child")
})
test("current Scope references do not depend on a directory existing", () => {
  const part = { type: "session" as const, id: "part", sessionId: "session", scopeID: "remote", title: "History" }
  expect(resolveSessionReference(part, [])).toEqual(part)
})
