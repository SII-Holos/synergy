import { expect, test } from "bun:test"
import { projectTaskIntent } from "../../../src/components/session/project-task-intent"
const directories = {
  version: 1 as const,
  scopeID: "project",
  revision: 2,
  mainWorkspaceID: "B",
  additionalWorkspaceIDs: ["A"],
  folders: [
    { workspaceID: "B", generation: 3, path: "/b", available: true, git: true },
    { workspaceID: "A", generation: 1, path: "/a", available: true, git: true },
  ],
}
test("task intent selects the real main binding and a deferred Worktree uses that source", () => {
  expect(projectTaskIntent({ directories })).toEqual({ mode: "workspace", workspaceID: "B", workspaceGeneration: 3 })
  expect(projectTaskIntent({ directories, preference: "worktree" })).toEqual({ mode: "create", sourceWorkspaceID: "B" })
  expect(projectTaskIntent({ directories, selected: { mode: "existing", target: "old-A" } })).toEqual({
    mode: "existing",
    target: "old-A",
  })
  expect(projectTaskIntent({})).toEqual({ mode: "none" })
})

test("implicit main selection follows a confirmed catalog generation while explicit drafts stay pinned", () => {
  const workspaces = [
    { id: "B", scopeID: "project", binding: { hostID: "host", path: "/b", state: "bound" as const, generation: 4 } },
  ]
  expect(projectTaskIntent({ directories, workspaces })).toEqual({
    mode: "workspace",
    workspaceID: "B",
    workspaceGeneration: 4,
  })
  expect(projectTaskIntent({ directories, workspaces, selected: { mode: "current" } })).toEqual({
    mode: "workspace",
    workspaceID: "B",
    workspaceGeneration: 4,
  })
  const selected = { mode: "workspace" as const, workspaceID: "B", workspaceGeneration: 3 }
  expect(projectTaskIntent({ directories, workspaces, selected })).toEqual(selected)
  expect(projectTaskIntent({ directories, workspaces: [{ ...workspaces[0], scopeID: "another" }] })).toEqual(selected)
  expect(
    projectTaskIntent({
      directories,
      workspaces: [{ ...workspaces[0], binding: { ...workspaces[0].binding, generation: 2 } }],
    }),
  ).toEqual(selected)
})
