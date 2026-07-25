import { describe, expect, test } from "bun:test"
import { SynergyLinkSession } from "../src"

describe("synergy-link protocol", () => {
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
})
