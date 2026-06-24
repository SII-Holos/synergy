import { describe, expect, test } from "bun:test"
import { SessionInvoke } from "../../src/session/invoke"

describe("SessionInvoke external permission mapping", () => {
  test("maps Claude Code control profile to bypass/default modes", () => {
    const fullAccessConfig = SessionInvoke.applyExternalPermissionMode({}, "claude-code", "full_access")
    expect(fullAccessConfig.controlProfile).toBe("full_access")
    expect(fullAccessConfig.permissionMode).toBe("bypassPermissions")
    expect(fullAccessConfig.skipPermissions).toBeUndefined()

    const guardedConfig = SessionInvoke.applyExternalPermissionMode({ skipPermissions: true }, "claude-code", "guarded")
    expect(guardedConfig.controlProfile).toBe("guarded")
    expect(guardedConfig.permissionMode).toBe("default")
    expect(guardedConfig.skipPermissions).toBeUndefined()
  })

  test("passes control profile through to Codex without approval policy", () => {
    const fullAccessConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", "full_access")
    expect(fullAccessConfig.controlProfile).toBe("full_access")
    expect(fullAccessConfig.approvalPolicy).toBeUndefined()

    const guardedConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", "guarded")
    expect(guardedConfig.controlProfile).toBe("guarded")
    expect(guardedConfig.approvalPolicy).toBeUndefined()
  })
})
