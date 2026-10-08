import { describe, expect, mock, test } from "bun:test"
import type { BasicToolProps } from "../../../src/components/basic-tool"

let capturedTool: BasicToolProps | undefined
let capturedOutput: string | undefined
;(globalThis as typeof globalThis & { React: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    if (typeof type === "function") {
      return type({ ...(props ?? {}), children: children.length === 1 ? children[0] : children })
    }
    return null
  },
}

mock.module("../../../src/components/basic-tool", () => ({
  BasicTool: (props: BasicToolProps) => {
    capturedTool = props
    return null
  },
  SmartTool: () => null,
  ToolResultPresentationProvider: () => null,
  useToolResultPresentation: () => undefined,
}))
mock.module("../../../src/components/tool-output-text", () => ({
  ToolTextOutput: (props: { text: string }) => {
    capturedOutput = props.text
    return null
  },
}))

const { getToolInfo, ToolRegistry } = await import("../../../src/components/message-part")
await import("../../../src/components/tool-renders")

const worktree = { id: "tree-feature", name: "Feature", path: "/work/feature", branch: "feature" }

function resetCapture() {
  capturedTool = undefined
  capturedOutput = undefined
}

describe("worktree archive presentation", () => {
  test("shows the requested target before completion without inventing a current tree", () => {
    expect(getToolInfo("worktree_archive", { target: "feature" })).toMatchObject({
      icon: "worktree-archive",
      title: { id: "tool.title.archive-worktree", message: "Archive isolated workspace" },
      subtitle: "feature",
    })
    expect(getToolInfo("worktree_archive", {}).subtitle).toBe("")
  })

  test("uses the resolved worktree rather than the restored checkout as the archived target", () => {
    const presentation = getToolInfo(
      "worktree_archive",
      { target: "tree-feature" },
      {
        action: "archived",
        worktree,
        restored: { type: "main", path: "/work/main" },
        cleanup: { performed: true },
        message: "Archived Feature and reclaimed its directory.",
      },
    )

    expect(presentation.subtitle).toBe("Feature")
    expect(presentation.args).toEqual(["feature"])
    expect(JSON.stringify(presentation)).not.toContain("/work/main")
    expect(getToolInfo("worktree_archive", {}, { worktree: { path: "/work/feature" } }).subtitle).toBe("/work/feature")
  })

  test("keeps retained cleanup reasons and errors verbatim", () => {
    const presentation = getToolInfo(
      "worktree_archive",
      {},
      {
        action: "archived",
        worktree,
        cleanup: { performed: false, reason: "dirty_worktree", error: "Git refused removal" },
        message: "Archived Feature; directory retained.",
      },
    )

    expect(presentation.args).toEqual(["feature", "dirty_worktree", "Git refused removal"])
  })

  test("registers the archive renderer in the standard bundle and preserves every receipt", () => {
    const render = ToolRegistry.render("worktree_archive")
    expect(render).toBeDefined()

    for (const action of ["archived", "noop", "denied"]) {
      const output = `Archive receipt: ${action}; conversation remains active.`
      resetCapture()
      render!({
        tool: "worktree_archive",
        input: {},
        status: "completed",
        output,
        metadata: { action, worktree, cleanup: { performed: false, reason: "retained" }, message: output },
      })

      expect(capturedTool?.trigger).toEqual({
        icon: "worktree-archive",
        title: { id: "tool.title.archive-worktree", message: "Archive isolated workspace" },
        subtitle: "Feature",
        tags: [{ label: "feature" }, { label: "retained" }],
      })
      expect(capturedOutput).toBe(output)
    }
  })
})
