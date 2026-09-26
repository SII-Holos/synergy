import { describe, expect, test } from "bun:test"
import {
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
