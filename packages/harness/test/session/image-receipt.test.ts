import { expect, test } from "bun:test"
import { InputImages } from "../../src/session/rollout/input-images"
import { readImageInputReceipt } from "../../src/session/rollout/image-receipt"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { testRuntime } from "../support/runtime"

test("image proof follows final input and actual HTTP bytes for the exact call", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const bytes = Buffer.from("image receipt fixture")
    const sha256 = InputImages.digest(bytes)
    const url = `data:image/png;base64,${bytes.toString("base64")}`
    const received: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push(await request.text())
        return new Response("done")
      },
    })
    const runID = crypto.randomUUID()
    const owner = { kind: "operation" as const, scopeID: "test", operationID: runID }
    try {
      for (const mode of ["submitted", "included", "omitted", "absent"] as const) {
        const call = await RolloutLedger.beginCall({
          owner,
          runID,
          purpose: "test",
          model: { providerID: "test", modelID: mode, sdk: "test", pricing: null },
          request: {},
        })
        const recorder = RolloutTransportRecorder.create(call)
        const before = mode === "absent" ? [] : [{ content: [{ type: "file", mediaType: "image/png", data: bytes }] }]
        await RolloutTransport.provide(recorder.emit, async () => {
          RolloutTransport.inputImages(before)(mode === "omitted" ? [] : before)
          const response = await RolloutTransport.fetch(fetch, server.url, {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  content:
                    mode === "submitted"
                      ? [{ type: "image_url", image_url: { url } }]
                      : [{ type: "text", text: "Image unavailable" }],
                },
              ],
            }),
          })
          await response.text()
        })
        await recorder.finish()
        const receipt = await readImageInputReceipt({ owner, runID, callID: call.id })
        expect(receipt.callID).toBe(call.id)
        expect(receipt.images).toEqual(
          mode === "absent"
            ? []
            : [{ sha256, stage: mode, ...(mode === "omitted" ? { reason: "provider_transform_omitted" } : {}) }],
        )
      }
      expect(InputImages.wire(received[0]!)).toEqual([sha256])
      expect(received.slice(1).every((body) => InputImages.wire(body).length === 0)).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
