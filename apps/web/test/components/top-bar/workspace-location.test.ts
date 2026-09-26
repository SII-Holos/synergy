import { expect, test } from "bun:test"
import { workspaceLocation } from "../../../src/components/top-bar/workspace-location"

const current = { id: "ws_main", type: "directory", scopeID: "project", path: "/main" }
test("an explicit session without local files never inherits the project's directory", () => {
  expect(workspaceLocation({ session: { workspace: null, workspaceID: null }, current })).toEqual({ state: "none" })
})
test("an unavailable session binding does not fall back to the main checkout", () => {
  expect(workspaceLocation({ session: { workspace: null, workspaceID: "ws_missing" }, current })).toEqual({
    state: "unavailable",
  })
  expect(workspaceLocation({ session: { workspace: { ...current, bindingState: "unbound" } }, current })).toEqual({
    state: "unavailable",
  })
})
test("the current session binding takes precedence over a new-session preference", () => {
  expect(
    workspaceLocation({
      session: { workspace: { ...current, type: "git_worktree", path: "/worktree" } },
      selection: { mode: "none" },
      current,
    }),
  ).toEqual({ state: "bound", path: "/worktree", isolated: true })
})
test("a worktree request stays pending until the actual directory is created", () => {
  expect(workspaceLocation({ selection: { mode: "create" }, current })).toEqual({ state: "planned", isolated: true })
  expect(workspaceLocation({ selection: { mode: "existing", target: "/other" }, current })).toEqual({
    state: "planned",
    isolated: true,
    path: "/other",
  })
})
