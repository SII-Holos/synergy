import { describe, expect, test } from "bun:test"
import { ExternalAgentProcessTracker } from "../../src/external-agent/process-tracker"
import { ProcessRegistry } from "../../src/process/registry"

describe("ExternalAgentProcessTracker", () => {
  test("associates a child PID with its external-agent session without retaining prompt data", () => {
    const restore = ProcessRegistry.setProcessInspector(() => ({ alive: true, rssBytes: 4096 }))
    const tracked = ExternalAgentProcessTracker.attach({
      adapter: "codex",
      pid: 1234,
      cwd: "/tmp/project",
      platform: "linux",
      context: {
        sessionID: "ses_owner",
        messageID: "msg_owner",
        prompt: "must not be retained by the process tracker",
      },
    })

    try {
      expect(ProcessRegistry.resourceSnapshot()).toContainEqual(
        expect.objectContaining({
          id: tracked.processId,
          pid: 1234,
          rssBytes: 4096,
          owner: {
            sessionID: "ses_owner",
            messageID: "msg_owner",
            tool: "external-agent:codex",
          },
        }),
      )
      expect(ProcessRegistry.get(tracked.processId!)?.command).toBe("codex")
      expect(ProcessRegistry.get(tracked.processId!)).not.toHaveProperty("prompt")
    } finally {
      tracked.dispose()
      restore()
    }

    expect(ProcessRegistry.get(tracked.processId!)).toBeUndefined()
  })

  test("does not register external-agent processes on non-Linux platforms", () => {
    const before = ProcessRegistry.listActive().length
    const tracked = ExternalAgentProcessTracker.attach({
      adapter: "codex",
      pid: 1234,
      cwd: "/tmp/project",
      platform: "darwin",
      context: { sessionID: "ses_owner", messageID: "msg_owner", prompt: "not retained" },
    })

    expect(tracked.processId).toBeUndefined()
    expect(ProcessRegistry.listActive()).toHaveLength(before)
    tracked.dispose()
  })
})
