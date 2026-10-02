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
