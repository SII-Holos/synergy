import { describe, expect, test } from "bun:test"
import { SynergyLinkBash, SynergyLinkProcess, SynergyLinkSession } from "@ericsanchezok/synergy-link-protocol"
import { HolosSynergyLinkClient, SynergyLinkRemoteError } from "../../src/remote/client"

describe("Synergy Link remote client", () => {
  test("serializes bash requests with linkID and protocol version 2", async () => {
    const client = new HolosSynergyLinkClient({
      async request(targetAgentID, input) {
        expect(targetAgentID).toBeUndefined()
        expect(input).not.toHaveProperty("envID")
        expect(input).not.toHaveProperty("targetAgentID")
        expect(input.version).toBe(2)
        expect(input.linkID).toBe("link_test")
        expect(SynergyLinkBash.ExecuteRequest.safeParse(input).success).toBe(true)
        return {
          version: 2,
          requestID: input.requestID,
          ok: true,
          tool: "bash",
          action: "execute",
          result: {
            title: "ok",
            metadata: {
              description: "ok",
              exit: 0,
              backend: "remote",
              linkID: input.linkID,
            },
            output: "done",
          },
        }
      },
    })

    const result = await client.executeBash(
      "link_test",
      {
        command: "echo ok",
        description: "ok",
      },
      { sessionID: "session_test" },
    )

    expect(result.output).toBe("done")
    expect(result.metadata.linkID).toBe("link_test")
  })

  test("keeps targetAgentID out of the request body and passes it to the transport", async () => {
    let routedTo: string | undefined
    const client = new HolosSynergyLinkClient({
      async request(targetAgentID, input) {
        routedTo = targetAgentID
        expect(input).not.toHaveProperty("targetAgentID")
        expect(SynergyLinkProcess.ExecuteRequest.safeParse(input).success).toBe(true)
        return {
          version: 2,
          requestID: input.requestID,
          ok: true,
          tool: "process",
          action: "list",
          result: {
            title: "ok",
            metadata: { action: "list", backend: "remote", linkID: input.linkID, processes: [] },
            output: "",
          },
        }
      },
    })

    await client.executeProcess(
      "link_test",
      { action: "list" },
      { sessionID: "session_test", targetAgentID: "agent_remote" },
    )

    expect(routedTo).toBe("agent_remote")
  })

  test("session open body matches the strict protocol schema", async () => {
    const client = new HolosSynergyLinkClient({
      async request(targetAgentID, input) {
        expect(targetAgentID).toBe("agent_remote")
        expect(input).not.toHaveProperty("targetAgentID")
        expect(SynergyLinkSession.ExecuteRequest.safeParse(input).success).toBe(true)
        return {
          version: 2,
          requestID: input.requestID,
          ok: true,
          tool: "session",
          action: "open",
          result: {
            title: "Session opened",
            metadata: {
              action: "open",
              status: "opened",
              sessionID: "session_remote",
              remoteAgentID: "agent_remote",
              backend: "remote",
              linkID: input.linkID,
            },
            output: "ready",
          },
        }
      },
    })

    const result = await client.executeSession(
      "link_test",
      { action: "open", label: "collab" },
      { targetAgentID: "agent_remote" },
    )

    expect(result.metadata.action).toBe("open")
    expect(result.metadata.status).toBe("opened")
    expect(result.metadata.sessionID).toBe("session_remote")
  })

  test("throws protocol error on error envelope", async () => {
    const client = new HolosSynergyLinkClient({
      async request(_targetAgentID, input) {
        return {
          version: 2,
          requestID: input.requestID,
          ok: false,
          tool: "process",
          action: "list",
          error: {
            code: "transport_error",
            message: "offline",
          },
        }
      },
    })

    await expect(
      client.executeProcess(
        "link_test",
        {
          action: "list",
        },
        { sessionID: "session_test" },
      ),
    ).rejects.toBeInstanceOf(SynergyLinkRemoteError)
  })

  test("disposes the underlying transport", () => {
    let disposed = 0
    const client = new HolosSynergyLinkClient({
      async request() {
        throw new Error("unexpected request")
      },
      dispose() {
        disposed++
      },
    })

    client.dispose()

    expect(disposed).toBe(1)
  })
})
