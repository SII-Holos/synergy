import { describe, expect, test } from "bun:test"
import {
  selectedFileWorkspace,
  fileWorkspaceKey,
  fileWorkspace,
  workspaceFileOwner,
  workspaceFilePath,
  workspaceFileResource,
} from "../../../src/context/file/workspace"

const workspace = { id: "wsp_first", generation: 1, scopeID: "scope", type: "directory", path: "/one" }
describe("Workspace file identity", () => {
  test("unbound and retired catalog projections cannot open local files", () => {
    expect(fileWorkspace({ ...workspace, bindingState: "unbound" })).toBeUndefined()
    expect(fileWorkspace({ ...workspace, lifecycle: "retired" })).toBeUndefined()
    expect(fileWorkspace({ ...workspace, bindingState: "bound", lifecycle: "active" })).toMatchObject(workspace)
    expect(fileWorkspace(workspace)).toEqual(workspace)
  })
  test("same relative filename in another Workspace, binding, or server has a different identity", () => {
    const keys = [
      fileWorkspaceKey("server", "scope", workspace),
      fileWorkspaceKey("server", "scope", { ...workspace, id: "wsp_second" }),
      fileWorkspaceKey("server", "scope", { ...workspace, generation: 2 }),
      fileWorkspaceKey("other-server", "scope", workspace),
    ]
    expect(new Set(keys).size).toBe(4)
    expect(workspaceFileResource(workspace, "same.txt")).not.toBe(
      workspaceFileResource({ ...workspace, generation: 2 }, "same.txt"),
    )
  })
  test("tabs retain their opening Workspace and preserve unusual filenames", () => {
    const path = "目录/a?b#c % d.ts"
    const tab = { resourceId: workspaceFileResource(workspace, path), state: { workspace } }
    expect(workspaceFilePath(tab.resourceId)).toBe(path)
    expect(workspaceFileOwner(tab)).toEqual(workspace)
    expect(workspaceFileOwner({ ...tab, state: { workspace: { ...workspace, generation: 2 } } })).toBeUndefined()
    expect(workspaceFileOwner({ resourceId: "same.txt" })).toBeUndefined()
  })
})

const objects = {
  id: "wsp_objects",
  scopeID: "scope",
  type: "objects",
  revision: 1,
  binding: { state: "bound" as const, hostID: "host", path: null, generation: 3 },
  backend: { provider: "objects", spec: {} },
  metadata: { name: "Research" },
  sharedWritableWorkspaceIDs: [],
  lifecycle: "active" as const,
  createdAt: 1,
  updatedAt: 1,
}
test("logical file ownership needs no local path and cannot inherit a missing session's directory", () => {
  const selected = selectedFileWorkspace({ workspaceID: objects.id, workspace: null }, [objects])
  expect(selected).toMatchObject({ id: objects.id, path: "", generation: 3, name: "Research" })
  expect(selectedFileWorkspace({ workspaceID: objects.id, workspace: null }, [])).toBeUndefined()
  expect(selectedFileWorkspace({ workspaceID: null, workspace: null }, [objects])).toBeUndefined()
  expect(
    selectedFileWorkspace({ workspaceID: objects.id, workspace: null }, [{ ...objects, lifecycle: "deleted" }]),
  ).toBeUndefined()
  expect(workspaceFileOwner({ state: { workspace: selected } })).toEqual(selected)
})

test("project file roots follow explicit shared bindings and preserve a Worktree's own primary", async () => {
  const { projectFileWorkspaces } = await import("../../../src/context/file/workspace")
  const main = {
    ...objects,
    id: "wsp_tree",
    type: "git_worktree",
    binding: { ...objects.binding, path: "/tree" },
    sharedWritableWorkspaceIDs: ["wsp_extra"],
  }
  const extra = { ...objects, id: "wsp_extra", type: "directory", binding: { ...objects.binding, path: "/extra" } }
  const unrelated = { ...objects, id: "wsp_other", type: "directory", binding: { ...objects.binding, path: "/other" } }
  expect(
    projectFileWorkspaces({ ...workspace, id: main.id, path: "/tree" }, [main, extra, unrelated]).map(
      (item) => item.path,
    ),
  ).toEqual(["/tree", "/extra"])
  expect(projectFileWorkspaces(undefined, [main, extra])).toEqual([])
})
