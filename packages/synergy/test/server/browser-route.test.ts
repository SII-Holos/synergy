import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

describe("BrowserRoute control readiness", () => {
  test("returns a retryable pending response instead of 500 when WebRTC host control is not ready", async () => {
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = Server.App()
        const response = await app.request(
          "/home/browser/control?mode=session&sessionID=ses_route&presentation=webrtc&client=web&scopeID=home",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-synergy-browser-trace": "browser_trace_route",
            },
            body: JSON.stringify({
              commandId: "browser_cmd_route",
              command: {
                type: "navigate",
                tabId: "tab_missing",
                url: "https://example.com/",
                source: "user",
              },
            }),
          },
        )

        expect(response.status).toBe(409)
        const body = await response.json()
        expect(body).toMatchObject({
          type: "error",
          code: "browser_host_pending",
          retryable: true,
          traceId: "browser_trace_route",
          tabId: "tab_missing",
          commandId: "browser_cmd_route",
          commandType: "navigate",
        })
      },
    })
  })
})
