import { describe, expect, test } from "bun:test"
import { SessionInvoke } from "../../src/session/invoke"

describe("SessionInvoke external permission mapping", () => {
  test("maps Claude Code allowAll to bypass/default modes", () => {
    const allowAllConfig = SessionInvoke.applyExternalPermissionMode({}, "claude-code", true)
    expect(allowAllConfig.permissionMode).toBe("bypassPermissions")
    expect(allowAllConfig.skipPermissions).toBeUndefined()

    const askConfig = SessionInvoke.applyExternalPermissionMode({ skipPermissions: true }, "claude-code", false)
    expect(askConfig.permissionMode).toBe("default")
    expect(askConfig.skipPermissions).toBeUndefined()
  })

  test("maps Codex allowAll to never/on-request approval policy", () => {
    const allowAllConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", true)
    expect(allowAllConfig.approvalPolicy).toBe("never")

    const askConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", false)
    expect(askConfig.approvalPolicy).toBe("on-request")
  })

  test("requests restart when coarse permission mode drifts", () => {
    expect(SessionInvoke.externalAdapterNeedsRestart("claude-code", { permissionMode: "default" }, true)).toBe(true)
    expect(
      SessionInvoke.externalAdapterNeedsRestart("claude-code", { permissionMode: "bypassPermissions" }, true),
    ).toBe(false)
    expect(SessionInvoke.externalAdapterNeedsRestart("claude-code", { skipPermissions: true }, false)).toBe(true)

    expect(SessionInvoke.externalAdapterNeedsRestart("codex", { approvalPolicy: "on-request" }, true)).toBe(true)
    expect(SessionInvoke.externalAdapterNeedsRestart("codex", { approvalPolicy: "never" }, true)).toBe(false)
  })
})
