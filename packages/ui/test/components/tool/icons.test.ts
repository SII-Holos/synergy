import { describe, expect, test } from "bun:test"
import { getToolIcon } from "../../../src/components/tool/icons"
import { getSemanticIcon } from "../../../src/components/semantic-icon"

describe("tool icon identity", () => {
  test("shared businesses use the settings identity across tool aliases", () => {
    expect(getToolIcon("skill")).toBe(getSemanticIcon("settings.skills"))
    expect(getToolIcon("memory_search")).toBe(getSemanticIcon("memory.main"))
    expect(getToolIcon("memory_write")).toBe(getToolIcon("memory_search"))
    expect(getToolIcon("worktree_archive")).toBe(getSemanticIcon("workspace.worktree"))
    expect(getToolIcon("bash")).toBe("square-terminal")
    expect(getToolIcon("process")).toBe("monitor-cog")
    expect(getToolIcon("read")).toBe(getToolIcon("view_file"))
    expect(getToolIcon("write")).toBe(getToolIcon("save_file"))
    expect(getToolIcon("read")).not.toBe(getToolIcon("write"))
  })

  test("input-dependent operations retain their business identity", () => {
    expect(getToolIcon("note_read")).toBe("notebook-text")
    expect(getToolIcon("note_read", { kind: "blueprint" })).toBe(getSemanticIcon("blueprint.main"))
    expect(getToolIcon("session_control", { action: "compact" })).toBe(getSemanticIcon("settings.compaction"))
    expect(getToolIcon("session_control", { action: "permission_reply", reply: "reject" })).toBe("shield-x")
    expect(getToolIcon("session_control", { action: "permission_reply", reply: "once" })).toBe(
      getSemanticIcon("settings.permissions"),
    )
  })

  test("unknown external tools retain their integration identity", () => {
    expect(getToolIcon("mcp__example__custom_operation")).toBe(getSemanticIcon("mcp.main"))
    expect(getToolIcon("unrecognized_operation")).toBe("wrench")
    expect(getToolIcon("mcp__scholight__extract_url")).toBe("telescope")
  })
})
