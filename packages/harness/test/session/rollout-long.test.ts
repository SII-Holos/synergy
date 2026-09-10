import { expect, test } from "bun:test"
import { Uint8ArrayWriter } from "@zip.js/zip.js"
import { fixture } from "../support/rollout"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutArchive } from "../../src/session/rollout/archive"
import { RolloutSnapshot } from "../../src/session/rollout/snapshot"
import { RolloutAccounting } from "../../src/session/rollout/accounting"

const longTest = process.env.SYNERGY_ROLLOUT_LONG_STREAM === "1" ? test : test.skip
for (const status of ["completed", "cancelled", "failed"] as const) {
  longTest(
    `retains and validates a 30 MiB provider stream with 30,720 checkpoints: ${status}`,
    async () => {
      await fixture(async ({ session, rootID, call }) => {
        const recorder = RolloutTransportRecorder.create(call)
        const attemptID = crypto.randomUUID()
        await recorder.emit({
          type: "attempt-start",
          attemptID,
          url: "https://fixture.test/responses",
          method: "POST",
          mediaType: "application/json",
        })
        await recorder.emit({ type: "body-end", attemptID, channel: "request", complete: true })
        await recorder.emit({ type: "response", attemptID, status: 200, mediaType: "text/event-stream", headers: {} })
        const hash = new Bun.CryptoHasher("sha256")
        const chunk = new TextEncoder().encode(":" + "x".repeat(1021) + "\n\n")
        for (let index = 0; index < 30_720; index++) {
          hash.update(chunk)
          await recorder.emit({ type: "chunk", attemptID, channel: "response", data: chunk })
          if ((index + 1) % 10_240 === 0) {
            console.info(`rollout-long ${status}: persisted ${(index + 1) / 1024} MiB (${index + 1} checkpoints)`)
          }
        }
        if (status === "completed") {
          const usage = new TextEncoder().encode(
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":20}}}\n\n',
          )
          hash.update(usage)
          await recorder.emit({ type: "chunk", attemptID, channel: "response", data: usage })
        }
        await recorder.emit({ type: "body-end", attemptID, channel: "response", complete: status === "completed" })
        await recorder.emit({ type: "attempt-end", attemptID, status })
        const sdkResponse = await RolloutArtifact.writeText(call.owner, "observed SDK response", "text/plain")
        await RolloutLedger.finishCall(call.owner, rootID, call.id, {
          status,
          response: sdkResponse,
          transportCaptured: await recorder.finish(),
        })
        await RolloutLedger.finishRun(call.owner, rootID, status)
        console.info(`rollout-long ${status}: verifying retained bytes, accounting and archive`)
        const snapshot = await RolloutSnapshot.read(call.owner)
        expect(snapshot.runs[0].recording).not.toBe("failed")
        expect(snapshot.attempts[0].status).toBe(status)
        const response = snapshot.attempts[0].response!
        expect(response.bytes).toBeGreaterThanOrEqual(30 * 1024 * 1024)
        expect(response.chunks).toBeGreaterThanOrEqual(30_720)
        const retained = new Bun.CryptoHasher("sha256")
        for await (const bytes of RolloutArtifact.read(call.owner, response)) retained.update(bytes)
        expect(retained.digest("hex")).toBe(hash.digest("hex"))
        const accounting = RolloutAccounting.summarize(snapshot)
        expect(accounting.tokens.input.total).toBe(status === "completed" ? 10 : null)
        const output = new Uint8ArrayWriter()
        await RolloutArchive.write({ sessionID: session.id, runID: rootID }, output)
        const { manifest } = await RolloutArchive.inspect(new Blob([await output.getData()]))
        expect(manifest.integrity.missing).toEqual([])
        expect(manifest.integrity.complete).toBe(status === "completed")
        expect(manifest.files.length).toBeGreaterThan(30_720)
        console.info(`rollout-long ${status}: archive verified; removing fixture`)
      })
      console.info(`rollout-long ${status}: fixture cleanup completed`)
    },
    1_500_000,
  )
}
