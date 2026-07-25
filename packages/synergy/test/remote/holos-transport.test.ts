import { describe, expect, test } from "bun:test"
import { SynergyLinkBridge, SynergyLinkEnvelope } from "@ericsanchezok/synergy-link-protocol"
import { HolosRuntime } from "../../src/holos/runtime"
import { HolosSynergyLinkTransport } from "../../src/remote/holos-transport"

const caller = (agentID: string) => ({
  type: "agent",
  agent_id: agentID,
  owner_user_id: 1,
})

describe("HolosSynergyLinkTransport", () => {
  test("resolves a pending request from a valid typed response sent by the target agent", async () => {
    const requestID = crypto.randomUUID()
    const targetAgentID = "target-agent"
    const transport = new HolosSynergyLinkTransport({
      async send() {
        return { sent: true }
      },
    })

    try {
      const resultPromise = transport.request(targetAgentID, {
        version: SynergyLinkEnvelope.VERSION,
        requestID,
        linkID: "link_transport",
        tool: "session",
        action: "open",
        payload: { action: "open" },
      })
      const response = {
        version: SynergyLinkEnvelope.VERSION,
        requestID,
        ok: true,
        tool: "session",
        action: "open",
        result: {
          title: "Session opened",
          metadata: { action: "open", status: "opened", backend: "remote" },
          output: "Opened",
        },
      } as const

      await expect(
        HolosRuntime.dispatchAppEvent({
          event: SynergyLinkBridge.RESPONSE_EVENT,
          payload: response,
          caller: caller(targetAgentID),
        }),
      ).resolves.toBe(true)
      await expect(resultPromise).resolves.toEqual(response)
    } finally {
      transport.dispose()
    }
  })

  test("ignores an otherwise valid response sent by a different agent", async () => {
    const requestID = crypto.randomUUID()
    const targetAgentID = "target-agent"
    const transport = new HolosSynergyLinkTransport({
      async send() {
        return { sent: true }
      },
    })

    try {
      const resultPromise = transport.request(targetAgentID, {
        version: SynergyLinkEnvelope.VERSION,
        requestID,
        linkID: "link_transport",
        tool: "session",
        action: "open",
        payload: { action: "open" },
      })
      const response = {
        version: SynergyLinkEnvelope.VERSION,
        requestID,
        ok: true,
        tool: "session",
        action: "open",
        result: {
          title: "Session opened",
          metadata: { action: "open", status: "opened", backend: "remote" },
          output: "Opened",
        },
      } as const

      await expect(
        HolosRuntime.dispatchAppEvent({
          event: SynergyLinkBridge.RESPONSE_EVENT,
          payload: response,
          caller: caller("different-agent"),
        }),
      ).resolves.toBe(false)
      await expect(
        HolosRuntime.dispatchAppEvent({
          event: SynergyLinkBridge.RESPONSE_EVENT,
          payload: response,
          caller: caller(targetAgentID),
        }),
      ).resolves.toBe(true)
      await expect(resultPromise).resolves.toEqual(response)
    } finally {
      transport.dispose()
    }
  })
})
