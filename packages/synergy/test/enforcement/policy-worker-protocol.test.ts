import { describe, expect, test } from "bun:test"
import { PolicyWorkerProtocol } from "@/enforcement/policy-worker/protocol"

function input(command = "ls") {
  return {
    context: {
      activeWorkspace: "/tmp/project",
      workspaceType: "worktree",
      registeredMcpTools: [],
      registeredPluginTools: [],
      pluginToolCapabilities: {},
    },
    toolName: "bash",
    args: { command },
  }
}

describe("PolicyWorkerProtocol", () => {
  test("round-trips bounded classification inputs", () => {
    const encoded = PolicyWorkerProtocol.serializeInput(input("ls |& cat"))

    expect(PolicyWorkerProtocol.deserializeInput(encoded)).toEqual(input("ls |& cat"))
    expect(encoded.byteLength).toBeLessThanOrEqual(PolicyWorkerProtocol.REQUEST_MAX_BYTES)
  })

  test("rejects oversized classification inputs before IPC", () => {
    expect(() =>
      PolicyWorkerProtocol.serializeInput(input("x".repeat(PolicyWorkerProtocol.REQUEST_MAX_BYTES))),
    ).toThrow("Policy classification request exceeded")
  })

  test("validates conservative classification results", () => {
    expect(
      PolicyWorkerProtocol.ClassifyResultSchema.parse({
        capabilities: [
          {
            class: "protected_op",
            nonBypassable: true,
            opaque: true,
            reason: "policy classification unavailable",
          },
        ],
      }),
    ).toEqual({
      capabilities: [
        {
          class: "protected_op",
          nonBypassable: true,
          opaque: true,
          reason: "policy classification unavailable",
        },
      ],
    })
  })
})
