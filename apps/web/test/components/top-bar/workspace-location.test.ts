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

test("stored Workspaces have a location without claiming a controller path", () => {
  const record = {
    id: "wsp_objects",
    scopeID: "scope",
    type: "objects",
    revision: 1,
    binding: { state: "bound" as const, hostID: "host", path: null, generation: 2 },
    backend: { provider: "objects", spec: {} },
    metadata: { name: "Research" },
    sharedWritableWorkspaceIDs: [],
    lifecycle: "active" as const,
    createdAt: 1,
    updatedAt: 1,
  }
  expect(workspaceLocation({ session: { workspace: null, workspaceID: record.id }, records: [record] })).toEqual({
    state: "bound",
    stored: true,
    name: "Research",
  })
  expect(
    workspaceLocation({
      selection: { mode: "workspace", workspaceID: record.id, workspaceGeneration: 1 },
      records: [record],
    }),
  ).toEqual({ state: "unavailable" })
})
