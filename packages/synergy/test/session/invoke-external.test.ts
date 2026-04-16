import { describe, expect, test } from "bun:test"
import { SessionInvoke } from "../../src/session/invoke"

describe("SessionInvoke external permission mapping", () => {
  test("maps Claude Code allowAll to bypass/default modes", () => {
    const allowAllConfig = SessionInvoke.applyExternalPermissionMode({}, "claude-code", true)
    expect(allowAllConfig.allowAll).toBe(true)
    expect(allowAllConfig.permissionMode).toBe("bypassPermissions")
    expect(allowAllConfig.skipPermissions).toBeUndefined()

    const askConfig = SessionInvoke.applyExternalPermissionMode({ skipPermissions: true }, "claude-code", false)
    expect(askConfig.allowAll).toBe(false)
    expect(askConfig.permissionMode).toBe("default")
    expect(askConfig.skipPermissions).toBeUndefined()
  })

  test("maps Codex to coarse allowAll mode without approval policy", () => {
    const allowAllConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", true)
    expect(allowAllConfig.allowAll).toBe(true)
    expect(allowAllConfig.approvalPolicy).toBeUndefined()

    const askConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", false)
    expect(askConfig.allowAll).toBe(false)
    expect(askConfig.approvalPolicy).toBeUndefined()
  })
})
