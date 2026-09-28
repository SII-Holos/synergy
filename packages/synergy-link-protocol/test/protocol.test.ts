import { describe, expect, test } from "bun:test"
import { SynergyLinkBash, SynergyLinkHost, SynergyLinkSession } from "../src"

describe("synergy-link protocol", () => {
  test("bash completion signal is optional for older hosts", () => {
    const result = { title: "command", metadata: { exit: null }, output: "stopped" }
    expect(SynergyLinkBash.Result.parse(result)).toEqual(result)
    expect(
      SynergyLinkBash.Result.parse({ ...result, metadata: { exit: null, signal: "SIGTERM" } }).metadata.signal,
    ).toBe("SIGTERM")
  })

  test("session requests enforce the current version and strict envelope", () => {
    const request = {
      version: 2,
      requestID: "request_protocol_test",
      linkID: "link_protocol_test",
      tool: "session",
      action: "open",
      payload: { action: "open", label: "protocol test" },
    } as const

    expect(SynergyLinkSession.ExecuteRequest.parse(request)).toEqual(request)
    expect(() => SynergyLinkSession.ExecuteRequest.parse({ ...request, version: 1 })).toThrow()
    expect(() => SynergyLinkSession.ExecuteRequest.parse({ ...request, targetAgentID: "agent_host" })).toThrow()
    expect(() =>
      SynergyLinkSession.ExecuteRequest.parse({ ...request, payload: { ...request.payload, unexpected: true } }),
    ).toThrow()
  })

  test("host capabilities remain compatible when bash detach support is omitted", () => {
    const hello = {
      type: "synergy_link.host.hello",
      linkID: "link_protocol_test",
      hostSessionID: "host_protocol_test",
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

    expect(SynergyLinkHost.Hello.parse(hello)).toEqual(hello)
    expect(
      SynergyLinkHost.Hello.parse({
        ...hello,
        capabilities: { ...hello.capabilities, supportsBashDetach: true },
      }).capabilities.supportsBashDetach,
    ).toBe(true)
  })
})
