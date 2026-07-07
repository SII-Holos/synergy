import { describe, expect, test } from "bun:test"
import type { Agent } from "@ericsanchezok/synergy-sdk/client"
import { hasSelectedDefaultAgent, selectableDefaultAgents } from "./AgentsPanel.model"

describe("agents settings panel", () => {
  test("limits selectable defaults to visible primary agents", () => {
    const selectable = selectableDefaultAgents([
      agent("synergy", "Synergy", "primary"),
      agent("synergy-max", "Synergy Max", "primary"),
      agent("hidden-primary", "Hidden", "primary", true),
      agent("developer", "Developer", "subagent"),
    ])

    expect(selectable.map((item) => item.name)).toEqual(["synergy", "synergy-max"])
  })

  test("detects whether the configured default is still selectable", () => {
    const agents = [agent("synergy", "Synergy", "primary")]

    expect(hasSelectedDefaultAgent(agents, "synergy")).toBe(true)
    expect(hasSelectedDefaultAgent(agents, "custom-primary")).toBe(false)
  })
})

function agent(name: string, description: string, mode: Agent["mode"], hidden = false): Agent {
  return {
    name,
    description,
    mode,
    hidden,
  } as Agent
}
