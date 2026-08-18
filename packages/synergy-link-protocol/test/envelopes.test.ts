import { describe, expect, test } from "bun:test"
import { SynergyLinkBash } from "../src/bash"
import { SynergyLinkEnvelope } from "../src/envelope"
import { SynergyLinkError } from "../src/error"
import { SynergyLinkHost } from "../src/host"
import { SynergyLinkProcess } from "../src/process"
import { SynergyLinkSession } from "../src/session"

const requestBase = {
  version: 2,
  requestID: "req_1",
  linkID: "link_test",
} as const

describe("synergy-link error envelope", () => {
  test("creates error shapes with and without details", () => {
    expect(SynergyLinkError.create("session_not_found", "no session")).toEqual({
      code: "session_not_found",
      message: "no session",
    })
    expect(SynergyLinkError.create("execution_failed", "boom", { exitCode: 1 })).toEqual({
      code: "execution_failed",
      message: "boom",
      details: { exitCode: 1 },
    })
    expect(SynergyLinkError.Shape.parse({ code: "transport_error", message: "x", details: null })).toEqual({
      code: "transport_error",
      message: "x",
      details: null,
    })
    expect(() => SynergyLinkError.Shape.parse({ code: "not_a_code", message: "x" })).toThrow()
  })

  test("error results validate with and without tool/action", () => {
    const full = SynergyLinkEnvelope.ErrorResult.parse({
      version: 2,
      requestID: "req_1",
      ok: false,
      tool: "bash",
      action: "execute",
      error: { code: "link_inactive", message: "inactive" },
    })
    expect(full.tool).toBe("bash")
    expect(() =>
      SynergyLinkEnvelope.ErrorResult.parse({
        version: 2,
        requestID: "req_1",
        ok: false,
        error: { code: "link_inactive", message: "inactive" },
        unexpected: true,
      }),
    ).toThrow()
  })
})

describe("synergy-link envelope", () => {
  test("request base requires the current protocol version and a link-prefixed target", () => {
    expect(SynergyLinkEnvelope.RequestBase.parse({ ...requestBase, tool: "bash", action: "execute" })).toEqual({
      ...requestBase,
      tool: "bash",
      action: "execute",
    })
    expect(() =>
      SynergyLinkEnvelope.RequestBase.parse({ ...requestBase, version: 1, tool: "bash", action: "execute" }),
    ).toThrow()
    expect(() =>
      SynergyLinkEnvelope.RequestBase.parse({ ...requestBase, tool: "bash", action: "execute", extra: true }),
    ).toThrow()
    expect(() =>
      SynergyLinkEnvelope.RequestBase.parse({ ...requestBase, linkID: "no_prefix", tool: "bash", action: "execute" }),
    ).toThrow()
  })

  test("result bases enforce version and request id", () => {
    expect(SynergyLinkEnvelope.ResultBase.parse({ version: 2, requestID: "req_1", ok: true })).toEqual({
      version: 2,
      requestID: "req_1",
      ok: true,
    })
    expect(() => SynergyLinkEnvelope.ResultBase.parse({ version: 1, requestID: "req_1", ok: true })).toThrow()
    expect(() => SynergyLinkEnvelope.ResultBase.parse({ version: 2, requestID: "", ok: true })).toThrow()
  })
})

describe("synergy-link bash protocol", () => {
  test("execution payloads validate with and without detach/background options", () => {
    expect(SynergyLinkBash.ExecutePayload.parse({ command: "ls", description: "list" })).toEqual({
      command: "ls",
      description: "list",
    })
    const detached = SynergyLinkBash.ExecutePayload.parse({
      command: "run",
      description: "long",
      background: true,
      detach: true,
      yieldSeconds: 5,
      workdir: "/tmp",
    })
    expect(detached.detach).toBe(true)
    expect(() => SynergyLinkBash.ExecutePayload.parse({ command: "ls", description: "list", extra: 1 })).toThrow()
    expect(() => SynergyLinkBash.ExecutePayload.parse({ command: "ls" })).toThrow()
  })

  test("results validate with process metadata and warnings", () => {
    const result = SynergyLinkBash.Result.parse({
      title: "ran",
      metadata: {
        output: "out",
        exit: 0,
        processId: "proc_1",
        background: false,
        durationMs: 12,
        hostSessionID: "host_1",
        linkID: "link_test",
        backend: "remote",
        warnings: [
          {
            code: "synergy_link.not_connected",
            message: "offline",
            reminder: "reconnect",
            retryable: true,
          },
        ],
      },
      output: "out",
    })
    expect(result.metadata.backend).toBe("remote")
    expect(SynergyLinkBash.Result.parse({ title: "t", metadata: {}, output: "" }).metadata).toEqual({})
    expect(() =>
      SynergyLinkBash.Result.parse({
        title: "t",
        metadata: { warnings: [{ code: "bogus", message: "m", reminder: "r", retryable: false }] },
        output: "",
      }),
    ).toThrow()
  })

  test("execute requests only accept the bash tool with a session", () => {
    const request = SynergyLinkBash.ExecuteRequest.parse({
      ...requestBase,
      tool: "bash",
      action: "execute",
      sessionID: "session_1",
      payload: { command: "echo hi", description: "hi" },
    })
    expect(request.tool).toBe("bash")
    expect(() =>
      SynergyLinkBash.ExecuteRequest.parse({
        ...requestBase,
        tool: "bash",
        action: "execute",
        sessionID: "session_1",
        payload: { command: "echo hi", description: "hi" },
        targetAgentID: "agent_x",
      }),
    ).toThrow()
  })

  test("execute results accept ok success payloads only", () => {
    expect(
      SynergyLinkBash.ExecuteResult.parse({
        version: 2,
        requestID: "req_1",
        ok: true,
        tool: "bash",
        action: "execute",
        result: { title: "t", metadata: {}, output: "" },
      }).ok,
    ).toBe(true)
    expect(() =>
      SynergyLinkBash.ExecuteResult.parse({
        version: 2,
        requestID: "req_1",
        ok: false,
        tool: "bash",
        action: "execute",
        result: { title: "t", metadata: {}, output: "" },
      }),
    ).toThrow()
  })
})

describe("synergy-link host capabilities", () => {
  test("hello validates shells, runtimes, and line endings", () => {
    const hello = SynergyLinkHost.Hello.parse({
      type: "synergy_link.host.hello",
      linkID: "link_test",
      hostSessionID: "host_1",
      capabilities: {
        platform: "darwin",
        arch: "arm64",
        runtime: "bun",
        defaultShell: "sh",
        supportedShells: ["sh"],
        supportsPty: true,
        supportsSendKeys: true,
        supportsSoftKill: true,
        supportsProcessGroups: true,
        envCaseInsensitive: false,
        lineEndings: "lf",
      },
    })
    expect(hello.capabilities.supportsBashDetach).toBeUndefined()
    expect(() =>
      SynergyLinkHost.Capabilities.parse({
        platform: "darwin",
        arch: "arm64",
        runtime: "bun",
        defaultShell: "sh",
        supportedShells: ["sh"],
        supportsPty: true,
        supportsSendKeys: true,
        supportsSoftKill: true,
        supportsProcessGroups: true,
        envCaseInsensitive: false,
        lineEndings: "weird",
      }),
    ).toThrow()
  })
})

describe("synergy-link process protocol", () => {
  test("payloads discriminate by action and reject unknown fields", () => {
    expect(SynergyLinkProcess.ExecutePayload.parse({ action: "list" })).toEqual({ action: "list" })
    expect(
      SynergyLinkProcess.ExecutePayload.parse({ action: "poll", processId: "proc_1", block: true, timeout: 5 }),
    ).toEqual({ action: "poll", processId: "proc_1", block: true, timeout: 5 })
    expect(() => SynergyLinkProcess.ExecutePayload.parse({ action: "poll" })).toThrow()
    expect(() => SynergyLinkProcess.ExecutePayload.parse({ action: "list", processId: "proc_1" })).toThrow()
  })

  test("process info and results validate statuses and metadata", () => {
    const info = SynergyLinkProcess.ProcessInfo.parse({
      processId: "proc_1",
      status: "running",
      command: "sleep 5",
      runtimeMs: 100,
    })
    expect(info.status).toBe("running")
    expect(() =>
      SynergyLinkProcess.ProcessInfo.parse({ processId: "proc_1", status: "weird", command: "x", runtimeMs: 1 }),
    ).toThrow()

    const result = SynergyLinkProcess.Result.parse({
      title: "polled",
      metadata: {
        action: "poll",
        processId: "proc_1",
        status: "running",
        exitCode: undefined,
        nextOffset: 10,
        processes: [info],
      },
      output: "out",
    })
    expect(result.metadata.processes).toHaveLength(1)
    expect(() =>
      SynergyLinkProcess.Result.parse({ title: "t", metadata: { action: "not_an_action" }, output: "" }),
    ).toThrow()
  })

  test("process requests accept every action and results mirror them", () => {
    const actions = ["list", "poll", "log", "write", "send-keys", "kill", "clear", "remove"] as const
    for (const action of actions) {
      const payload: Record<string, unknown> = { action }
      if (action !== "list") payload.processId = "proc_1"
      if (action === "write") payload.data = "yes\n"
      if (action === "send-keys") payload.keys = ["C-c"]
      const request = SynergyLinkProcess.ExecuteRequest.parse({
        ...requestBase,
        tool: "process",
        action,
        sessionID: "session_1",
        payload,
      })
      expect(request.action).toBe(action)

      const result = SynergyLinkProcess.ExecuteResult.parse({
        version: 2,
        requestID: "req_1",
        ok: true,
        tool: "process",
        action,
        result: { title: "t", metadata: { action, processId: "proc_1", status: "running" }, output: "" },
      })
      expect(result.action).toBe(action)
    }
    expect(() =>
      SynergyLinkProcess.ExecuteRequest.parse({
        ...requestBase,
        tool: "bash",
        action: "list",
        sessionID: "session_1",
        payload: { action: "list" },
      }),
    ).toThrow()
  })
})

describe("synergy-link session protocol", () => {
  test("session payloads discriminate open/close/heartbeat", () => {
    expect(SynergyLinkSession.ExecutePayload.parse({ action: "open", label: "pairing" })).toEqual({
      action: "open",
      label: "pairing",
    })
    expect(SynergyLinkSession.ExecutePayload.parse({ action: "open" })).toEqual({ action: "open" })
    expect(SynergyLinkSession.ExecutePayload.parse({ action: "close", sessionID: "session_1" })).toEqual({
      action: "close",
      sessionID: "session_1",
    })
    expect(() => SynergyLinkSession.ExecutePayload.parse({ action: "close" })).toThrow()
    expect(() => SynergyLinkSession.ExecutePayload.parse({ action: "open", sessionID: "session_1" })).toThrow()
  })

  test("session requests accept a nested host hello and strict envelopes", () => {
    const hostHello = {
      type: "synergy_link.host.hello",
      linkID: "link_test",
      hostSessionID: "host_1",
      capabilities: {
        platform: "linux",
        arch: "x64",
        runtime: "bun",
        defaultShell: "sh",
        supportedShells: ["sh"],
        supportsPty: false,
        supportsSendKeys: true,
        supportsSoftKill: true,
        supportsProcessGroups: true,
        envCaseInsensitive: false,
        lineEndings: "lf",
      },
    } as const

    for (const action of ["open", "close", "heartbeat"] as const) {
      const payload: Record<string, unknown> = { action }
      if (action !== "open") payload.sessionID = "session_1"
      const request = SynergyLinkSession.ExecuteRequest.parse({
        ...requestBase,
        tool: "session",
        action,
        payload,
      })
      expect(request.action).toBe(action)
    }

    const result = SynergyLinkSession.ExecuteResult.parse({
      version: 2,
      requestID: "req_1",
      ok: true,
      tool: "session",
      action: "open",
      result: {
        title: "opened",
        metadata: {
          action: "open",
          status: "opened",
          sessionID: "session_1",
          reused: false,
          remoteAgentID: "agent_1",
          remoteOwnerUserID: 1,
          label: "pairing",
          backend: "remote",
          host: hostHello,
        },
        output: "ok",
      },
    })
    expect(result.result.metadata.host?.capabilities.supportsBashDetach).toBeUndefined()
    expect(() =>
      SynergyLinkSession.ExecuteResult.parse({
        version: 2,
        requestID: "req_1",
        ok: true,
        tool: "session",
        action: "open",
        result: { title: "t", metadata: { action: "open", status: "refused" }, output: "" },
      }),
    ).not.toThrow()
    expect(() =>
      SynergyLinkSession.ExecuteResult.parse({
        version: 2,
        requestID: "req_1",
        ok: true,
        tool: "session",
        action: "open",
        result: { title: "t", metadata: { action: "open", status: "alive", reused: "yes" }, output: "" },
      }),
    ).toThrow()
  })
})
