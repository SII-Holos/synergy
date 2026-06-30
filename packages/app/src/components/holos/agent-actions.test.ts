import { describe, expect, test } from "bun:test"

const agentActions = await Bun.file(new URL("./agent-actions.tsx", import.meta.url)).text()

describe("Holos agent actions", () => {
  test("create agent collects initial remote profile before starting Holos login", () => {
    expect(agentActions).toContain("DialogCreateHolosAgent")
    expect(agentActions).toContain("profile")
    expect(agentActions).toContain("Holos agent profile")
    expect(agentActions).toContain("avatarUrl")
    expect(agentActions).toContain("globalSDK.client.holos.login")
    expect(agentActions).not.toContain('name="sparkles"')
    expect(agentActions).not.toContain('name="shield-check"')
  })

  test("import agent accepts only the secret and lets the server fetch canonical identity", () => {
    expect(agentActions).toContain("globalSDK.client.holos.credentials({ agentSecret }")
    expect(agentActions).not.toContain('label="Agent ID"')
    expect(agentActions).not.toContain("agentIdError")
    expect(agentActions).not.toContain("{ agentId, agentSecret }")
    expect(agentActions).not.toContain('name="key-round"')
  })

  test("agent switching is presented as a focused dialog", () => {
    expect(agentActions).toContain("DialogSwitchHolosAgent")
    expect(agentActions).toContain("openAgentSwitcher")
    expect(agentActions).toContain("Switch Agent")
    expect(agentActions).toContain("Saved on this device")
    expect(agentActions).not.toContain('? "Active" : "Switch"')
  })
})
