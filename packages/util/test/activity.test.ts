import { describe, expect, test } from "bun:test"
import { activityScopeForTool, isActivityGroupableTool, toolDisplayPolicy } from "../src/activity"

describe("activityScopeForTool", () => {
  test("groups modified files by package or top-level workspace directory", () => {
    const options = { family: "modify-files" as const, workspaceRoot: "/workspace" }

    expect(activityScopeForTool({ filePath: "/workspace/packages/ui/src/activity.tsx" }, {}, options)).toEqual({
      key: "path:/workspace/packages/ui",
      label: "/workspace/packages/ui",
    })
    expect(activityScopeForTool({ filePath: "/workspace/src/activity.ts" }, {}, options)).toEqual({
      key: "path:/workspace/src",
      label: "/workspace/src",
    })
    expect(activityScopeForTool({ filePath: "/workspace/README.md" }, {}, options)).toEqual({
      key: "path:/workspace",
      label: "/workspace",
    })
  })

  test("keeps directory scope outside the modified-file workspace contract", () => {
    expect(
      activityScopeForTool(
        { filePath: "/other/project/src/activity.ts" },
        {},
        { family: "modify-files", workspaceRoot: "/workspace" },
      ),
    ).toEqual({ key: "path:/other/project/src", label: "/other/project/src" })
    expect(
      activityScopeForTool(
        { filePath: "/workspace/packages/ui/src/activity.tsx" },
        {},
        { family: "inspect-local", workspaceRoot: "/workspace" },
      ),
    ).toEqual({ key: "path:/workspace/packages/ui/src", label: "/workspace/packages/ui/src" })
    expect(activityScopeForTool({ filePath: "/workspace/packages/ui/src/activity.tsx" })).toEqual({
      key: "path:/workspace/packages/ui/src",
      label: "/workspace/packages/ui/src",
    })
  })
})

describe("isActivityGroupableTool", () => {
  test("keeps dedicated, hidden, and media presentation tools outside semantic groups", () => {
    expect(isActivityGroupableTool("read", {})).toBe(true)
    expect(isActivityGroupableTool("render", {})).toBe(false)
    expect(isActivityGroupableTool("plugin_tool", { display: { toolCard: "hidden" } })).toBe(false)
    expect(isActivityGroupableTool("plugin_tool", { display: { kind: "media-generation" } })).toBe(false)
    expect(toolDisplayPolicy({ display: { toolCard: "hidden", kind: "media-generation" } })).toEqual({
      toolCardHidden: true,
      mediaGeneration: true,
    })
  })
})
