import { describe, expect, test } from "bun:test"
import {
  SynergyLinkBash,
  SynergyLinkProcess,
  SynergyLinkSession,
  SynergyLinkIdentity,
} from "@ericsanchezok/synergy-link-protocol"

describe("Synergy Link identity", () => {
  test("resolves omitted and blank input as local", () => {
    expect(SynergyLinkIdentity.resolve(undefined)).toEqual({ kind: "local", reason: "omitted" })
    expect(SynergyLinkIdentity.resolve("   ")).toEqual({ kind: "local", reason: "blank" })
  })

  test("resolves valid link IDs by trimming whitespace", () => {
    expect(SynergyLinkIdentity.resolve("  link_test  ")).toEqual({ kind: "remote", linkID: "link_test" })
    expect(SynergyLinkIdentity.requireLinkID("link_abc123")).toBe("link_abc123")
  })

  test("marks old env IDs and placeholders invalid without throwing from resolve", () => {
    expect(SynergyLinkIdentity.resolve("env_test")).toEqual({
      kind: "invalid",
      input: "env_test",
      reason: "placeholder_alias",
    })
    expect(SynergyLinkIdentity.resolve("undefined")).toEqual({
      kind: "invalid",
      input: "undefined",
      reason: "placeholder_alias",
    })
  })

  test("requireLinkID rejects local aliases and invalid formats", () => {
    expect(() => SynergyLinkIdentity.requireLinkID(":local")).toThrow(SynergyLinkIdentity.InvalidLinkIDError)
    expect(() => SynergyLinkIdentity.requireLinkID("random_string")).toThrow('must start with "link_"')
  })
})

describe("Synergy Link protocol strict payloads", () => {
  test("rejects unknown fields inside bash payloads", () => {
    const result = SynergyLinkBash.ExecuteRequest.safeParse({
      version: 2,
      requestID: "req_test",
      linkID: "link_test",
      tool: "bash",
      action: "execute",
      sessionID: "session_test",
      payload: {
        command: "echo ok",
        description: "Echo ok",
        envID: "env_legacy",
      },
    })

    expect(result.success).toBe(false)
  })

  test("rejects unknown fields inside process payloads", () => {
    const result = SynergyLinkProcess.ExecuteRequest.safeParse({
      version: 2,
      requestID: "req_test",
      linkID: "link_test",
      tool: "process",
      action: "list",
      sessionID: "session_test",
      payload: { action: "list", envID: "env_legacy" },
    })

    expect(result.success).toBe(false)
  })

  test("rejects unknown fields inside session payloads", () => {
    const result = SynergyLinkSession.ExecuteRequest.safeParse({
      version: 2,
      requestID: "req_test",
      linkID: "link_test",
      tool: "session",
      action: "open",
      payload: { action: "open", envID: "env_legacy" },
    })

    expect(result.success).toBe(false)
  })
})
