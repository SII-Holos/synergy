import { describe, expect, test } from "bun:test"
import { TOOL_LABEL_DESC, TOOL_TITLE_DESC } from "../../../src/components/tool-title-descriptors"
import { classifyTool } from "../../../src/components/tool/classifier"

describe("tool classifier localization", () => {
  test("returns a localized count descriptor instead of an English badge", () => {
    const classified = classifyTool("session_list", {}, { count: 2 })

    expect(classified.titleDescriptor).toBe(TOOL_TITLE_DESC.session_list)
    expect(classified.countDescriptor).toBe(TOOL_LABEL_DESC.sessions)
    expect(classified.countValues).toEqual({ count: 2 })
    expect(classified.args).toBeUndefined()
  })

  test("returns a composite search count descriptor for blueprint matches", () => {
    const classified = classifyTool("blueprint_search", {}, { matchCount: 3, noteCount: 2 })

    expect(classified.countDescriptor).toBe(TOOL_LABEL_DESC.matchesInBlueprints)
    expect(classified.countValues).toEqual({ matchCount: 3, noteCount: 2 })
  })

  test("keeps unknown external tool names outside the host catalog", () => {
    const classified = classifyTool("plugin_custom_action")

    expect(classified.title).toBe("Plugin Custom Action")
    expect(classified.titleDescriptor).toBeUndefined()
  })

  test("classifies every Lattice tool with an explicit localized title", () => {
    const read = classifyTool("pathway_read")
    const write = classifyTool("pathway_write", { futureSteps: [{ title: "Build" }] })
    const submit = classifyTool("lattice_submit", { action: "approve_execution", reason: "Reviewed" })

    expect(read.category).toBe("dag")
    expect(read.titleDescriptor?.message).toBe("Read Pathway")
    expect(write.category).toBe("dag")
    expect(write.titleDescriptor?.message).toBe("Write Pathway")
    expect(submit.category).toBe("task")
    expect(submit.titleDescriptor?.message).toBe("Submit Lattice action")
    expect(submit.subtitle).toBe("approve_execution")
  })
})
