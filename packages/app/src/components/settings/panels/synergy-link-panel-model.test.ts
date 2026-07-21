import { describe, expect, test } from "bun:test"
import { normalizeAllowedAgents, reconcileTargetDraft, targetFormReady } from "./synergy-link-panel-model"

describe("Synergy Link settings form", () => {
  test("normalizes a comma-separated agent allowlist", () => {
    expect(normalizeAllowedAgents("build, synergy, build,  review ")).toEqual(["build", "synergy", "review"])
  })

  test("requires all three target locator fields", () => {
    expect(targetFormReady({ name: "Builder", targetAgentID: "agent_builder", linkID: "link_builder" })).toBe(true)
    expect(targetFormReady({ name: "Builder", targetAgentID: "", linkID: "link_builder" })).toBe(false)
    expect(targetFormReady({ name: "Builder", targetAgentID: "agent_builder", linkID: ":local" })).toBe(false)
  })
  test("preserves dirty target fields across background refreshes", () => {
    expect(
      reconcileTargetDraft({
        current: "Unsaved name",
        previousServer: "Old name",
        nextServer: "Old name",
        targetChanged: false,
      }),
    ).toBe("Unsaved name")
    expect(
      reconcileTargetDraft({
        current: "Old name",
        previousServer: "Old name",
        nextServer: "Updated elsewhere",
        targetChanged: false,
      }),
    ).toBe("Updated elsewhere")
    expect(
      reconcileTargetDraft({
        current: "Unsaved name",
        previousServer: "Old name",
        nextServer: "Different target",
        targetChanged: true,
      }),
    ).toBe("Different target")
  })
})
