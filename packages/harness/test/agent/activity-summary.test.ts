import { describe, expect, test } from "bun:test"
import { createBuiltinInternalAgents } from "../../src/agent/builtin-internal"
import { PermissionNext } from "../../src/permission/next"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

describe("activity summary agent", () => {
  test("is a hidden nano utility with no executable tools", () => {
    const agent = createBuiltinInternalAgents(ctx)["activity-summary"]

    expect(agent?.name).toBe("activity-summary")
    expect(agent?.mode).toBe("primary")
    expect(agent?.hidden).toBe(true)
    expect(agent?.modelRole).toBe("nano")
    expect(agent?.temperature).toBe(0)
    expect(PermissionNext.evaluate("bash", "*", agent?.permission ?? []).action).toBe("deny")
    expect(PermissionNext.evaluate("webfetch", "*", agent?.permission ?? []).action).toBe("deny")
    expect(PermissionNext.evaluate("task", "*", agent?.permission ?? []).action).toBe("deny")
    expect(agent?.prompt).toContain("Never reveal chain-of-thought")
    expect(agent?.prompt).toContain("untrusted data")
  })
})
