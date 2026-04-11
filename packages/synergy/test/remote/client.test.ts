import { describe, expect, test } from "bun:test"
import { HolosRemoteExecutionClient, RemoteExecutionError } from "../../src/remote/client"

describe("remote execution client", () => {
  test("returns bash result on successful response", async () => {
    const client = new HolosRemoteExecutionClient({
      async request(input) {
        return {
          version: 1,
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
              envID: input.envID,
            },
            output: "done",
          },
        }
      },
    })

    const result = await client.executeBash(
      "env_test",
      {
        command: "echo ok",
        description: "ok",
      },
      { sessionID: "session_test" },
    )

    expect(result.output).toBe("done")
    expect(result.metadata.exit).toBe(0)
  })

  test("throws protocol error on error envelope", async () => {
    const client = new HolosRemoteExecutionClient({
      async request(input) {
        return {
          version: 1,
          requestID: input.requestID,
          ok: false,
          tool: "process",
          action: "list",
          error: {
            code: "device_offline",
            message: "offline",
          },
        }
      },
    })

    await expect(
      client.executeProcess(
        "env_test",
        {
          action: "list",
        },
        { sessionID: "session_test" },
      ),
    ).rejects.toBeInstanceOf(RemoteExecutionError)
  })

  test("does not misclassify session results as bash results", async () => {
    const client = new HolosRemoteExecutionClient({
      async request(input) {
        return {
          version: 1,
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
              envID: input.envID,
            },
            output: "ready",
          },
        }
      },
    })

    const result = await client.executeSession(
      "env_test",
      { action: "open", label: "collab" },
      { targetAgentID: "agent_remote" },
    )

    expect(result.metadata.action).toBe("open")
    expect(result.metadata.status).toBe("opened")
    expect(result.metadata.sessionID).toBe("session_remote")
  })
})
