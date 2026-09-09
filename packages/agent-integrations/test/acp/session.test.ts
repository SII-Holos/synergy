import { describe, expect, test } from "bun:test"
import type { McpServer } from "@agentclientprotocol/sdk"
import { ACPSessionManager } from "../../src/acp/session"

function sdk(
  overrides: {
    controlProfile?: (directory?: string) => Promise<{ data?: { profileId?: string } }>
    sessionCreate?: (input: { directory: string }) => Promise<{ data: { id: string } }>
    sessionGet?: (input: { sessionID: string }) => Promise<{ data: { id: string; time: { created: number } } }>
  } = {},
) {
  return {
    controlProfile: {
      effective: async ({ directory }: { directory?: string }) =>
        overrides.controlProfile ? overrides.controlProfile(directory) : { data: {} },
    },
    session: {
      create: async (input: { directory: string }) =>
        overrides.sessionCreate ? overrides.sessionCreate(input) : { data: { id: `session-${input.directory}` } },
      get: async (input: { sessionID: string }) =>
        overrides.sessionGet ? overrides.sessionGet(input) : { data: { id: input.sessionID, time: { created: 1234 } } },
    },
  }
}

const servers: McpServer[] = []

describe("ACPSessionManager", () => {
  test("creates a session with directory and optional model", async () => {
    const manager = new ACPSessionManager(sdk() as never)
    const state = await manager.create("/tmp/cwd", servers, { providerID: "p", modelID: "m" })
    expect(state.id).toBe("session-/tmp/cwd")
    expect(state.cwd).toBe("/tmp/cwd")
    expect(state.mcpServers).toEqual([])
    expect(state.model).toEqual({ providerID: "p", modelID: "m" })
    expect(state.createdAt).toBeInstanceOf(Date)
    expect(manager.get(state.id)).toEqual(state)
  })

  test("attaches a control profile when the SDK reports a valid one", async () => {
    const createCalls: Array<{ controlProfile?: string }> = []
    const manager = new ACPSessionManager(
      sdk({
        controlProfile: async () => ({ data: { profileId: "guarded" } }),
        sessionCreate: async (input) => {
          createCalls.push(input as never)
          return { data: { id: "guarded-session" } }
        },
      }) as never,
    )
    const state = await manager.create("/tmp/cwd", servers)
    expect(state.id).toBe("guarded-session")
    expect(createCalls[0]).toHaveProperty("controlProfile", "guarded")
  })

  test("ignores invalid and missing control profiles", async () => {
    const invalid = new ACPSessionManager(
      sdk({ controlProfile: async () => ({ data: { profileId: "not-a-profile" } }) }) as never,
    )
    const invalidState = await invalid.create("/tmp/a", servers)
    expect(invalidState.id).toBe("session-/tmp/a")

    const rejected = new ACPSessionManager(
      sdk({
        controlProfile: async () => {
          throw new Error("backend down")
        },
      }) as never,
    )
    const rejectedState = await rejected.create("/tmp/b", servers)
    expect(rejectedState.id).toBe("session-/tmp/b")
  })

  test("loads an existing session by id", async () => {
    const manager = new ACPSessionManager(
      sdk({
        sessionGet: async ({ sessionID }) => ({
          data: { id: sessionID, time: { created: 999 } },
        }),
      }) as never,
    )
    const state = await manager.load("existing", "/tmp/cwd", servers, { providerID: "p", modelID: "m" })
    expect(state.id).toBe("existing")
    expect(state.createdAt).toEqual(new Date(999))
    expect(manager.getModel("existing")).toEqual({ providerID: "p", modelID: "m" })
  })

  test("throws an invalid-params request error for unknown sessions", () => {
    const manager = new ACPSessionManager(sdk() as never)
    let caught: unknown
    try {
      manager.get("unknown")
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: -32602, name: "RequestError" })
    expect((caught as { data?: unknown }).data).toContain("Session not found: unknown")
  })

  test("setModel and setMode update the cached state", async () => {
    const manager = new ACPSessionManager(sdk() as never)
    await manager.create("/tmp/cwd", servers)
    const id = "session-/tmp/cwd"
    manager.setModel(id, { providerID: "q", modelID: "n" })
    expect(manager.getModel(id)).toEqual({ providerID: "q", modelID: "n" })
    manager.setMode(id, "autonomous")
    expect(manager.get(id).modeId).toBe("autonomous")
  })
})
