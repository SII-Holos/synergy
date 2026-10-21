import { afterAll, expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { DigitalTwinRoute } from "../src/http"
import { DigitalTwin } from "../src/service"
import { PredictionError } from "../src/inference"
import { registerWorker, metadata } from "../src/worker"

const runtime = await testRuntime({ register: registerWorker })
afterAll(() => runtime.close())

test("worker registration exposes the hidden Agent and settings without preparing history", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect(metadata.id).toBe("digital-twin")
        expect((await Agent.get("digital-twin"))?.hidden).toBe(true)
        expect((await Config.current()).digitalTwin).toBeUndefined()
        expect(await Storage.queryKeys({ kind: "digital_twin" })).toEqual([])
      },
    }),
  ))

test("HTTP validates anchors and preserves typed failures and request cancellation", async () => {
  const app = DigitalTwinRoute()
  const input = {
    sessionID: "ses_test",
    requestID: "request",
    expected: { rootID: "msg_root", assistantID: "msg_reply" },
  }
  const request = (body: unknown, signal?: AbortSignal) =>
    new Request("http://localhost/predict-next-input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
  const sampling = spyOn(DigitalTwin, "predictNextInput")
  try {
    const invalid = await app.fetch(request({ sessionID: input.sessionID }))
    expect(invalid.status).toBe(400)
    expect(sampling).not.toHaveBeenCalled()
    for (const [code, status] of [
      ["source_changed", 409],
      ["cancelled", 408],
      ["invalid_prediction", 502],
      ["model_unavailable", 503],
    ] as const) {
      sampling.mockRejectedValue(new PredictionError(code, "Unavailable"))
      const response = await app.fetch(request(input))
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ code, message: "Unavailable" })
    }
    const cancel = new AbortController()
    sampling.mockImplementation(async ({ signal }) => {
      expect(signal?.aborted).toBe(true)
      throw new PredictionError("cancelled", "Cancelled")
    })
    cancel.abort()
    expect((await app.fetch(request(input, cancel.signal))).status).toBe(408)
  } finally {
    sampling.mockRestore()
  }
})
