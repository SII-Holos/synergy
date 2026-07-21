import { describe, expect, test } from "bun:test"
import { normalizeAllowedAgents, targetFormReady } from "./synergy-link-panel-model"

describe("Synergy Link settings form", () => {
  test("normalizes a comma-separated agent allowlist", () => {
    expect(normalizeAllowedAgents("build, synergy, build,  review ")).toEqual(["build", "synergy", "review"])
  })

  test("requires all three target locator fields", () => {
    expect(targetFormReady({ name: "Builder", targetAgentID: "agent_builder", linkID: "link_builder" })).toBe(true)
    expect(targetFormReady({ name: "Builder", targetAgentID: "", linkID: "link_builder" })).toBe(false)
    expect(targetFormReady({ name: "Builder", targetAgentID: "agent_builder", linkID: ":local" })).toBe(false)
  })
})
