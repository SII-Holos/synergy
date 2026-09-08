import { ProviderPricing } from "../../provider/pricing"
import { RolloutUsageCapture } from "./usage-capture"
import { RolloutArtifact } from "./artifact"
import { RolloutLedger } from "./ledger"
import type { RolloutSchema } from "./schema"
import { RolloutTransportSchema } from "./transport-schema"
import { record } from "./error"

export namespace RolloutTransportRecorder {
  export function create(call: RolloutSchema.CallRecord) {
    const active = new Map<
      string,
      {
        value: RolloutSchema.AttemptRecord
        request: RolloutArtifact.Writer
        response?: RolloutArtifact.Writer
        usage?: ReturnType<typeof RolloutUsageCapture.create>
      }
    >()
    let count = 0
    let complete = true
    let pending: Promise<void> = Promise.resolve()
    let closed = false

    async function handle(raw: RolloutTransportSchema.Event) {
      const event = RolloutTransportSchema.Event.parse(raw)
      if (event.type === "attempt-start") {
        if (active.has(event.attemptID)) throw new Error("Duplicate rollout attempt")
        const request = await RolloutArtifact.open(call.owner, event.mediaType)
        const value: RolloutSchema.AttemptRecord = {
          version: 1,
          id: event.attemptID,
          callID: call.id,
          runID: call.runID,
          owner: call.owner,
          index: count++,
          url: event.url,
          method: event.method,
          started: Date.now(),
          status: "running",
          request: await RolloutArtifact.get(call.owner, request.id),
        }
        await RolloutLedger.writeAttempt(value)
        active.set(event.attemptID, { value, request })
        return
      }
      const attempt = active.get(event.attemptID)
      if (!attempt) throw new Error("Rollout event has no active attempt")
      if (event.type === "response") {
        if (attempt.response) throw new Error("Duplicate rollout response")
        attempt.response = await RolloutArtifact.open(call.owner, event.mediaType)
        attempt.usage = RolloutUsageCapture.create(call.model.sdk, event.mediaType, call.model.providerID, call.kind)
        attempt.value.response = await RolloutArtifact.get(call.owner, attempt.response.id)
        attempt.value.httpStatus = event.status
        attempt.value.responseHeaders = event.headers
      }
      if (event.type === "chunk" || event.type === "body-end") {
        const writer = attempt[event.channel]
        if (!writer) throw new Error("Rollout body has no artifact")
        if (event.type === "chunk") {
          if (event.channel === "response") attempt.usage?.append(event.data)
          await writer.append(event.data)
          attempt.value[event.channel] = await writer.checkpoint()
          await RolloutLedger.writeAttempt(attempt.value)
          return
        }
        attempt.value[event.channel] = await writer.finish(event.complete ? "complete" : "partial")
      }
      if (event.type === "attempt-end") {
        attempt.value.request = await attempt.request.finish("partial")
        attempt.value.response = await attempt.response?.finish("partial")
        attempt.value.usage = attempt.usage?.finish()
        attempt.value.estimate = ProviderPricing.estimate(
          call.model.pricing,
          attempt.value.usage,
          call.model.providerID,
        )
        attempt.value.status = event.status
        attempt.value.error = event.error
        attempt.value.ended = Date.now()
        complete &&= attempt.value.request.status === "complete" && attempt.value.response?.status === "complete"
        await RolloutLedger.writeAttempt(attempt.value)
        active.delete(event.attemptID)
        return
      }
      await RolloutLedger.writeAttempt(attempt.value)
    }

    return {
      emit(event: RolloutTransportSchema.Event) {
        if (closed)
          return record(async () => {
            throw new Error("Rollout transport recorder is closed")
          })
        pending = pending.then(() => record(() => handle(event)))
        return pending
      },
      async finish() {
        closed = true
        await pending
        for (const attempt of active.values()) {
          attempt.value.request = await attempt.request.finish("partial")
          attempt.value.response = await attempt.response?.finish("partial")
          attempt.value.usage = attempt.usage?.finish()
          attempt.value.estimate = ProviderPricing.estimate(
            call.model.pricing,
            attempt.value.usage,
            call.model.providerID,
          )
          attempt.value.status = "interrupted"
          attempt.value.ended = Date.now()
          await RolloutLedger.writeAttempt(attempt.value)
          complete = false
        }
        active.clear()
        return count > 0 && complete
      },
    }
  }
}
