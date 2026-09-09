import { ProcessRegistry } from "../../process/registry"
import { RolloutArtifact } from "./artifact"
import { RolloutLedger } from "./ledger"
import type { RolloutSchema } from "./schema"

export namespace RolloutProcess {
  const active = new Map<string, { owner: RolloutSchema.Owner; runID: string; done: Promise<void> }>()

  export function isActive(owner: RolloutSchema.Owner, runID: string, processID: string) {
    const entry = active.get(processID)
    return entry?.runID === runID && JSON.stringify(entry.owner) === JSON.stringify(owner)
  }

  export async function cancel(owner: RolloutSchema.Owner, runID: string) {
    const owned = [...active.entries()].filter(
      ([, entry]) => entry.runID === runID && JSON.stringify(entry.owner) === JSON.stringify(owner),
    )
    await Promise.all(
      owned.map(async ([id, entry]) => {
        const process = ProcessRegistry.get(id)
        if (process) await ProcessRegistry.terminate(process, { allowExitedParent: true })
        await entry.done
      }),
    )
  }

  export type Channel = "stdout" | "stderr"
  export type Completion = { interrupted: boolean; exitCode: number | null; signal: string | null; pid?: number }
  export type Writer = {
    append(channel: Channel, bytes: Uint8Array): Promise<void>
    finish(completion: Completion): Promise<void>
  }

  export async function open(
    input: { owner: RolloutSchema.Owner; runID: string; toolExecutionID: string; processID: string },
    onFailure: (error: unknown) => Promise<never>,
  ): Promise<Writer> {
    const stream = await RolloutArtifact.open(input.owner, "application/vnd.synergy.process-stream;version=1").catch(
      onFailure,
    )
    const process: RolloutSchema.ProcessRecord = {
      version: 1,
      id: input.processID,
      owner: input.owner,
      runID: input.runID,
      toolExecutionID: input.toolExecutionID,
      started: Date.now(),
      status: "running",
      stream: await RolloutArtifact.get(input.owner, stream.id),
    }
    await RolloutLedger.writeProcess(process).catch(onFailure)
    const settled = Promise.withResolvers<void>()
    void settled.promise.catch(() => {})
    active.set(input.processID, { owner: input.owner, runID: input.runID, done: settled.promise })
    let pending = Promise.resolve()
    let finishing: Promise<void> | undefined
    return {
      append(channel, bytes) {
        if (finishing) return Promise.reject(new Error("Process evidence is already closed"))
        pending = pending
          .then(async () => {
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
              const chunk = bytes.subarray(offset, offset + 64 * 1024)
              const header = new Uint8Array(5)
              header[0] = channel === "stdout" ? 1 : 2
              new DataView(header.buffer).setUint32(1, chunk.length)
              await stream.append(header)
              await stream.append(chunk)
            }
            process.stream = await stream.checkpoint()
            await RolloutLedger.writeProcess(process)
          })
          .catch(onFailure)
        return pending
      },
      finish(completion) {
        finishing ??= (async () => {
          await pending
          process.stream = await stream.finish(completion.interrupted ? "partial" : "complete")
          process.status = completion.interrupted ? "interrupted" : "completed"
          process.ended = Date.now()
          process.exitCode = completion.exitCode
          process.signal = completion.signal
          process.pid = completion.pid
          await RolloutLedger.writeProcess(process)
        })()
          .catch(onFailure)
          .then(
            () => settled.resolve(),
            (error) => {
              settled.reject(error)
              throw error
            },
          )
          .finally(() => active.delete(input.processID))
        return finishing
      },
    }
  }
}
