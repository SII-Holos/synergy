import type z from "zod"
import { RolloutContext } from "./context"
import { RolloutTransport } from "./transport"
import type { AgentTurnStream } from "../agent-turn/worker-pool"
import { RolloutArtifact } from "./artifact"
import { RolloutLedger } from "./ledger"
import { RolloutRecordingError } from "./error"
import { RolloutTransportRecorder } from "./transport-recorder"
import type { RolloutTransportSchema } from "./transport-schema"

export namespace RolloutCall {
  type Input = Parameters<typeof RolloutLedger.beginCall>[0]
  type Json = z.infer<ReturnType<typeof z.json>>

  async function begin(input: Input, onRecordingFailure?: () => void) {
    let notified = false
    async function notify(error: unknown) {
      if (!notified && RolloutRecordingError.isInstance(error)) {
        notified = true
        onRecordingFailure?.()
        await RolloutLedger.failRecording(input.owner, input.runID, error)
      }
    }
    async function rejectRecording(error: unknown): Promise<never> {
      await notify(error)
      throw error
    }
    const call = await RolloutLedger.beginCall(input).catch(rejectRecording)
    return { call, notify, rejectRecording }
  }

  export async function execute<T>(
    input: Input,
    action: () => Promise<{ value: T; response: Json; usage?: Json }>,
    onRecordingFailure?: () => void,
  ): Promise<T> {
    const { call, notify, rejectRecording } = await begin(input, onRecordingFailure)
    const transport = RolloutTransportRecorder.create(call)
    let result: Awaited<ReturnType<typeof action>>
    try {
      result = await RolloutContext.provide(
        { owner: input.owner, runID: input.runID, callID: call.id, signal: RolloutContext.current()?.signal },
        () => RolloutTransport.provide(transport.emit, action),
      )
    } catch (error) {
      await notify(error)
      const transportCaptured = await transport.finish().catch(rejectRecording)
      await RolloutLedger.finishCall(input.owner, input.runID, call.id, {
        status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
        transportCaptured,
        error: error instanceof Error ? error.message : String(error),
      }).catch(rejectRecording)
      throw error
    }
    try {
      const response = await RolloutArtifact.writeText(input.owner, JSON.stringify(result.response), "application/json")
      const transportCaptured = await transport.finish()
      await RolloutLedger.finishCall(input.owner, input.runID, call.id, {
        status: "completed",
        response,
        transportCaptured,
        sdkUsage: result.usage,
      })
      return result.value
    } catch (error) {
      return rejectRecording(error)
    }
  }

  export async function stream(
    input: Parameters<typeof RolloutLedger.beginCall>[0],
    start: (archive: RolloutTransportSchema.Sink) => Promise<AgentTurnStream>,
    onRecordingFailure?: () => void,
  ): Promise<AgentTurnStream> {
    const { call, notify, rejectRecording } = await begin(input, onRecordingFailure)
    const response = await RolloutArtifact.open(input.owner, "application/x-ndjson").catch(rejectRecording)
    await RolloutLedger.checkpointCall(input.owner, input.runID, call.id, response.committed).catch(rejectRecording)
    const transport = RolloutTransportRecorder.create(call)
    let source: AgentTurnStream
    try {
      source = await RolloutContext.provide(
        { owner: input.owner, runID: input.runID, callID: call.id, signal: RolloutContext.current()?.signal },
        () => start(transport.emit),
      )
    } catch (error) {
      await notify(error)
      const artifact = await response.finish("partial").catch(rejectRecording)
      const transportCaptured = await transport.finish().catch(rejectRecording)
      await RolloutLedger.finishCall(input.owner, input.runID, call.id, {
        status: "failed",
        response: artifact,
        transportCaptured,
        error: error instanceof Error ? error.message : String(error),
      }).catch(rejectRecording)
      throw error
    }

    let disposal: Promise<void> | undefined
    let closed = false
    function disposeSource() {
      disposal ??= source.dispose()
      return disposal
    }

    let finishing: Promise<void> | undefined
    let writing: Promise<void> | undefined
    let failure: string | undefined
    let streamFailure: unknown
    let committedChunks = 0
    function finish(status: "completed" | "cancelled" | "failed") {
      finishing ??= (async () => {
        await writing
        const artifact = await response.finish(status === "completed" ? "complete" : "partial")
        const transportCaptured = await transport.finish()
        const usage = status === "completed" ? await source.usage : undefined
        await RolloutLedger.finishCall(input.owner, input.runID, call.id, {
          status,
          response: artifact,
          transportCaptured,
          sdkUsage: usage ? JSON.parse(JSON.stringify(usage)) : undefined,
          error: failure,
        })
      })().catch(rejectRecording)
      return finishing
    }

    async function settle(status: "completed" | "cancelled" | "failed") {
      closed = true
      let error = streamFailure
      try {
        await disposeSource()
      } catch (cause) {
        error ??= cause
      }
      try {
        await finish(status)
      } catch (cause) {
        if (!error || RolloutRecordingError.isInstance(cause)) error = cause
      }
      if (error) throw error
    }

    async function* events() {
      let status: "completed" | "cancelled" | "failed" = "cancelled"
      let aborted = false
      try {
        for await (const event of source.fullStream) {
          if (closed) return
          if (event.type === "abort") aborted = true
          if (event.type === "error") failure = event.error instanceof Error ? event.error.message : String(event.error)
          const line = JSON.stringify(event, (_key, value: unknown) =>
            value instanceof Error ? { name: value.name, message: value.message } : value,
          )
          writing = response.append(new TextEncoder().encode(line + "\n"))
          await writing
          if (response.committed.chunks !== committedChunks) {
            await RolloutLedger.checkpointCall(input.owner, input.runID, call.id, response.committed)
            committedChunks = response.committed.chunks
          }
          if (closed) return
          yield event
        }
        status = failure ? "failed" : aborted ? "cancelled" : "completed"
      } catch (error) {
        await notify(error)
        streamFailure = error
        status = "failed"
        failure ??= error instanceof Error ? error.message : String(error)
      } finally {
        await settle(status)
      }
    }

    return {
      ...source,
      rollout: { owner: input.owner, runID: input.runID, callID: call.id },
      fullStream: events(),
      async dispose() {
        await settle(failure ? "failed" : "cancelled")
      },
    }
  }
}
