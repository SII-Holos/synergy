import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")

const WORKSPACE = "/Users/test/synergy-control-profile"

async function evaluate(command: string) {
  const gate = await EnforcementGate.create({
    activeWorkspace: WORKSPACE,
    workspaceType: "worktree",
    profileId: "autonomous",
  })
  return gate.evaluate("bash", { command, workdir: WORKSPACE })
}

function pathsFor(envelope: any, ...classes: string[]) {
  return envelope.capabilities.filter((c: any) => classes.includes(c.class)).flatMap((c: any) => c.paths ?? [])
}

describe("network capability and sandbox network parity (PR #1308 follow-up)", () => {
  test.each([
    "git fetch",
    "git pull",
    "git push",
    "git clone https://example.com/r.git",
    "git ls-remote origin",
    "npm install",
    "bun install",
    "pnpm install",
    "yarn add left-pad",
    "go get example.com/mod",
  ])("network-bearing developer command mints network_request: %j", async (command: string) => {
    const envelope = await evaluate(command)
    expect(envelope.capabilities.some((c: any) => c.class === "network_request")).toBe(true)
  })

  test("sandbox network mode is full after a network capability is granted", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: "curl -sS https://example.com", workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(gate.getSandboxPolicy()?.network.mode).toBe("full")
  })

  test("sandbox network mode stays restricted without a network capability", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: WORKSPACE,
      workspaceType: "worktree",
      profileId: "autonomous",
    })
    const envelope = gate.evaluate("bash", { command: "git status", workdir: WORKSPACE })
    expect(envelope.decision).toBe("allow")
    expect(gate.getSandboxPolicy()?.network.mode).toBe("restricted")
  })
})
