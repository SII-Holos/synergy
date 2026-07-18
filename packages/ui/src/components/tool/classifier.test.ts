import { describe, expect, test } from "bun:test"
import { TOOL_LABEL_DESC, TOOL_TITLE_DESC } from "../tool-title-descriptors"
import { classifyTool } from "./classifier"

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
})
