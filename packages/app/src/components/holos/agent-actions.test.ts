import { describe, expect, test } from "bun:test"

const agentActions = await Bun.file(new URL("./agent-actions.tsx", import.meta.url)).text()

describe("Holos agent actions", () => {
  test("create agent collects initial remote profile before starting Holos login", () => {
    expect(agentActions).toContain("DialogCreateHolosAgent")
    expect(agentActions).toContain("profile")
    expect(agentActions).toContain("Choose how this agent should appear in Holos")
    expect(agentActions).toContain("avatarUrl")
    expect(agentActions).toContain("globalSDK.client.holos.login")
    expect(agentActions).toContain("clientSurface: platform.platform")
    expect(agentActions).toContain("platform.openLink(authUrl)")
    expect(agentActions).not.toContain('name="sparkles"')
    expect(agentActions).not.toContain('name="shield-check"')
    expect(agentActions).not.toContain("not stored in local Synergy settings")
  })

  test("import agent accepts only the secret and lets the server fetch canonical identity", () => {
    expect(agentActions).toContain("globalSDK.client.holos.credentials({ agentSecret }")
    expect(agentActions).not.toContain('label="Agent ID"')
    expect(agentActions).not.toContain("agentIdError")
    expect(agentActions).not.toContain("{ agentId, agentSecret }")
    expect(agentActions).not.toContain('name="key-round"')
    expect(agentActions).not.toContain("canonical agent ID")
    expect(agentActions).not.toContain("Profile stays in Holos")
  })

  test("agent switching is presented as a focused dialog", () => {
    expect(agentActions).toContain("DialogSwitchHolosAgent")
    expect(agentActions).toContain("openAgentSwitcher")
    expect(agentActions).toContain("Switch Agent")
    expect(agentActions).toContain("account.profile")
    expect(agentActions).toContain("Saved on this device")
    expect(agentActions).not.toContain("if (!isActive(account)) return `Agent ${shortID(account.agentId)}`")
  })
})
