import { describe, expect, test } from "bun:test"
import { getVisiblePrimaryAgents } from "./local-agent"

describe("getVisiblePrimaryAgents", () => {
  test("treats uninitialized agent data as an empty list", () => {
    expect(getVisiblePrimaryAgents(undefined)).toEqual([])
    expect(getVisiblePrimaryAgents(null)).toEqual([])
  })

  test("filters hidden and subagent entries", () => {
    const agents = [
      { name: "synergy", mode: "all" },
      { name: "hidden", mode: "all", hidden: true },
      { name: "worker", mode: "subagent" },
      { name: "master", mode: "primary", hidden: false },
    ]

    expect(getVisiblePrimaryAgents(agents).map((agent) => agent.name)).toEqual(["synergy", "master"])
  })
})
