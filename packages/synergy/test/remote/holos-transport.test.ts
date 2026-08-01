import { describe, expect, test } from "bun:test"
import { SynergyLinkBridge, SynergyLinkEnvelope } from "@ericsanchezok/synergy-link-protocol"
import { HolosRuntime } from "../../src/holos/runtime"
import { HolosSynergyLinkTransport } from "../../src/remote/holos-transport"
import type { SynergyLinkRequest } from "../../src/remote/client"

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

describe("HolosSynergyLinkTransport error preservation", () => {
  const request = (requestID: string): SynergyLinkRequest => ({
    version: SynergyLinkEnvelope.VERSION,
    requestID,
    linkID: "link_transport",
    tool: "session",
    action: "open",
    payload: { action: "open" },
  })

  test("preserves not_connected when the tunnel is not connected", async () => {
    const transport = new HolosSynergyLinkTransport({
      async send() {
        return { sent: false, reason: "not_connected" }
      },
    })
    try {
      await expect(transport.request("target-agent", request(crypto.randomUUID()))).rejects.toMatchObject({
        name: "SynergyLinkRemoteError",
        details: { reason: "not_connected", dispatched: false },
      })
    } finally {
      transport.dispose()
    }
  })

  test("preserves delivery_failed and allows a retry to succeed in the same process", async () => {
    let sendCount = 0
    const transport = new HolosSynergyLinkTransport({
      async send() {
        sendCount++
        if (sendCount === 1) return { sent: false, reason: "delivery_failed" }
        return { sent: true }
      },
    })
    try {
      await expect(transport.request("target-agent", request(crypto.randomUUID()))).rejects.toMatchObject({
        details: { reason: "delivery_failed", dispatched: false },
      })

      const secondRequest = request(crypto.randomUUID())
      const second = transport.request("target-agent", secondRequest)
      const response = {
        version: SynergyLinkEnvelope.VERSION,
        requestID: secondRequest.requestID,
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
          caller: caller("target-agent"),
        }),
      ).resolves.toBe(true)
      await expect(second).resolves.toEqual(response)
    } finally {
      transport.dispose()
    }
  })

  test("reports result-unknown wording when the response times out after dispatch", async () => {
    const transport = new HolosSynergyLinkTransport(
      {
        async send() {
          return { sent: true }
        },
      },
      { timeoutMs: 20 },
    )
    try {
      await expect(transport.request("target-agent", request(crypto.randomUUID()))).rejects.toThrow(/result is unknown/)
    } finally {
      transport.dispose()
    }
  })
})
