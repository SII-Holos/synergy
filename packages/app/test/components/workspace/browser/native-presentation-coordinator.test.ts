import { describe, expect, test } from "bun:test"
import type { BrowserNativeViewBridge } from "../../../../src/context/platform"
import {
  NativePresentationCoordinator,
  resolveBrowserClientPresentation,
} from "../../../../src/components/workspace/browser/native-presentation-coordinator"

function bridge(overrides: Partial<BrowserNativeViewBridge> = {}): BrowserNativeViewBridge {
  return {
    async attachView() {},
    async detachView() {},
    async focusView() {},
    async resizeView() {},
    async retryPage() {},
    async presentationCapability() {
      return { protocolVersion: 2, managedLocal: true, status: "ready" }
    },
    async createPresentationTicket() {
      return { ok: true, protocolVersion: 2, ticket: "native-ticket" }
    },
    ...overrides,
  }
}

describe("native presentation coordinator", () => {
  test("selects native only when Desktop owns the connected server", async () => {
    expect(await resolveBrowserClientPresentation({ bridge: bridge(), serverUrl: "http://127.0.0.1:4096" })).toBe(
      "native",
    )
    expect(
      await resolveBrowserClientPresentation({
        bridge: bridge({
          async presentationCapability() {
            return { protocolVersion: 2, managedLocal: false, status: "failed" }
          },
        }),
        serverUrl: "https://remote.example.com",
      }),
    ).toBe("webrtc")
    expect(await resolveBrowserClientPresentation({ serverUrl: "https://web.example.com" })).toBe("webrtc")
  })

  test("retries Host registration before issuing an owner-bound ticket", async () => {
    let capabilityCalls = 0
    const delays: number[] = []
    const states: string[] = []
    const coordinator = new NativePresentationCoordinator({
      bridge: bridge({
        async presentationCapability() {
          capabilityCalls++
          return {
            protocolVersion: 2,
            managedLocal: true,
            status: capabilityCalls === 1 ? "connecting" : "ready",
          }
        },
      }),
      serverUrl: "http://127.0.0.1:4096",
      ownerKey: "owner-1",
      onState: (state) => states.push(state.phase),
      delay: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    await expect(coordinator.createTicket()).resolves.toBe("native-ticket")
    expect(delays).toEqual([250])
    expect(states).toEqual(["recovering", "ready"])
  })

  test("cancels a pending native recovery when its workspace is disposed", async () => {
    const coordinator = new NativePresentationCoordinator({
      bridge: bridge({
        async presentationCapability() {
          return { protocolVersion: 2, managedLocal: true, status: "connecting" }
        },
      }),
      serverUrl: "http://127.0.0.1:4096",
      ownerKey: "owner-1",
      onState() {},
    })

    const ticket = coordinator.createTicket()
    await Promise.resolve()
    coordinator.dispose()
    await expect(ticket).rejects.toMatchObject({ code: "browser_native_ticket_rejected", retryable: true })
  })
})
