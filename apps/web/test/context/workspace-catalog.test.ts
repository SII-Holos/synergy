import { expect, test } from "bun:test"
import type { SessionWorkspace, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"
import { projectWorkspaceBinding } from "../../src/context/workspace-catalog"
import { ScopeWriteTracker } from "../../src/context/scope-snapshot-merge"

const first: WorkspaceInfo = {
  id: "wsp_first",
  scopeID: "scope",
  type: "directory",
  revision: 2,
  binding: { hostID: "host", path: "/moved", state: "bound", generation: 2 },
  metadata: {},
  sharedWritableWorkspaceIDs: [],
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 2,
}
const previous: SessionWorkspace = { id: first.id, scopeID: "scope", type: "directory", generation: 1, path: "/old" }

test("Workspace projection adopts catalog bindings without retargeting another owner or newer generation", () => {
  expect(projectWorkspaceBinding(previous, first)).toMatchObject({ id: first.id, path: "/moved", generation: 2 })
  expect(projectWorkspaceBinding(previous, { ...first, scopeID: "other" })).toBe(previous)
  expect(projectWorkspaceBinding(previous, { ...first, id: "wsp_other" })).toBe(previous)
  const newer = { ...previous, generation: 3 }
  expect(projectWorkspaceBinding(newer, first)).toBe(newer)
  expect(
    projectWorkspaceBinding(previous, { ...first, binding: { ...first.binding, state: "unbound" } }),
  ).toMatchObject({ bindingState: "unbound", path: "/moved" })
})

test("a delayed Scope snapshot retains only newer Workspace events from its own epoch", () => {
  const tracker = new ScopeWriteTracker()
  tracker.workspaceWrite({ epoch: "run", seq: 5 }, first.id)
  const old = { ...first, revision: 1, binding: { ...first.binding, path: "/old", generation: 1 } }
  expect(tracker.mergeWorkspaces({ epoch: "run", seq: 4 }, [old], [first])).toEqual([first])
  expect(tracker.mergeWorkspaces({ epoch: "run", seq: 5 }, [old], [first])).toEqual([old])
  expect(tracker.mergeWorkspaces({ epoch: "restart", seq: 0 }, [old], [first])).toEqual([old])
})

test("unresolved historical bindings clear stale paths and recover only the matching catalog identity", () => {
  const missing = { ...first, binding: { ...first.binding, state: "unbound" as const, path: null } }
  expect(projectWorkspaceBinding(previous, missing)).toBeNull()
  const owner = { workspaceID: first.id, scopeID: first.scopeID }
  expect(projectWorkspaceBinding(null, first, owner)).toMatchObject({ id: first.id, path: "/moved" })
  expect(projectWorkspaceBinding(null, { ...first, id: "wsp_other" }, owner)).toBeNull()
  expect(projectWorkspaceBinding(null, { ...first, scopeID: "other" }, owner)).toBeNull()
})
