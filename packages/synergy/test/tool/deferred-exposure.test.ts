import { describe, expect, test } from "bun:test"
import { ToolExposure } from "../../src/tool/exposure"

describe("deferred tool exposure folding", () => {
  test("folds listed resident tools into the orchestration group", () => {
    const folded = ToolExposure.deferredExposure("task", ToolExposure.RESIDENT, ["task", "dagwrite"])
    expect(folded.mode).toBe("group")
    if (folded.mode !== "group") return
    expect(folded.group).toBe(ToolExposure.ORCHESTRATION_GROUP)
    expect(folded.title).toBeTruthy()
    expect(folded.description).toContain("delegation")
    expect(folded.whenToExpand).toContain("expand_tools")
  })

  test("leaves tools outside the deferred list untouched", () => {
    const base = ToolExposure.RESIDENT
    expect(ToolExposure.deferredExposure("bash", base, ["task", "dagwrite"])).toBe(base)
    expect(ToolExposure.deferredExposure("bash", base, undefined)).toBe(base)
    expect(ToolExposure.deferredExposure("bash", base, [])).toBe(base)
  })

  test("keeps an already-grouped exposure even when listed", () => {
    const grouped = { mode: "group" as const, group: "session" }
    expect(ToolExposure.deferredExposure("session_list", grouped, ["session_list"])).toBe(grouped)
  })

  test("orchestration group id is stable", () => {
    expect(ToolExposure.ORCHESTRATION_GROUP).toBe("orchestration")
  })
})
