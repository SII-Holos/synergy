import { afterEach, describe, expect, test } from "bun:test"
import { Hosted } from "../../src/server/hosted"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("hosted auth", () => {
  test("uses runtime_jwt auth mode by default", () => {
    delete process.env["SYNERGY_RUNTIME_AUTH_MODE"]

    expect(Hosted.authMode()).toBe("runtime_jwt")
  })

  test("gateway auth mode validates Holos gateway identity headers without a JWT secret", async () => {
    process.env["SYNERGY_RUNTIME_AUTH_MODE"] = "gateway"
    process.env["HOLOS_OWNER_ID"] = "42"
    process.env["HOLOS_AGENT_ID"] = "agent-123"
    delete process.env["SYNERGY_JWT_SECRET"]

    await expect(
      Hosted.verifyGatewayHeaders({
        userId: "42",
        agentId: "agent-123",
      }),
    ).resolves.toEqual({
      user_id: "42",
      agent_id: "agent-123",
    })
  })

  test("gateway auth mode rejects missing gateway user headers", async () => {
    process.env["SYNERGY_RUNTIME_AUTH_MODE"] = "gateway"
    process.env["HOLOS_OWNER_ID"] = "42"

    await expect(Hosted.verifyGatewayHeaders({})).rejects.toThrow("missing_gateway_user")
  })

  test("gateway auth mode rejects non-owner gateway user headers", async () => {
    process.env["SYNERGY_RUNTIME_AUTH_MODE"] = "gateway"
    process.env["HOLOS_OWNER_ID"] = "42"

    await expect(Hosted.verifyGatewayHeaders({ userId: "24" })).rejects.toThrow("invalid_owner")
  })

  test("gateway auth mode rejects mismatched agent headers when HOLOS_AGENT_ID is configured", async () => {
    process.env["SYNERGY_RUNTIME_AUTH_MODE"] = "gateway"
    process.env["HOLOS_OWNER_ID"] = "42"
    process.env["HOLOS_AGENT_ID"] = "agent-123"

    await expect(
      Hosted.verifyGatewayHeaders({
        userId: "42",
        agentId: "agent-456",
      }),
    ).rejects.toThrow("invalid_agent")
  })
})
