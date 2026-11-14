import { z } from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { EnvironmentExecution } from "./execution"
import { EnvironmentExecutionSchema } from "./execution-schema"
import { EnvironmentSchema } from "./schema"
import { ExecutionProtocol } from "./executor"
import { EnvironmentOriginSchema } from "./origin-schema"
import { RuntimeContext } from "../lifecycle/context"
import { EnvironmentExecutionOriginIndex } from "./execution-origin-index"

export namespace EnvironmentExecutionPortable {
  const Count = z.number().int().nonnegative().safe()
  const maxChunkBytes = 96 * 1024
  export const Owner = z.strictObject({ scopeID: z.string().min(1), sessionID: z.string().min(1) })
  export type Owner = z.infer<typeof Owner>
  export type Completed = EnvironmentExecutionSchema.Record & {
    execution: EnvironmentExecutionSchema.Info & { origin: EnvironmentOriginSchema.Session }
  }

  function guard(signal: AbortSignal) {
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const blobs = artifactObjects?.blobs
    const writerID = artifactObjects?.writerID
    const now = artifactObjects?.now
    return () => {
      signal.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== blobs ||
        artifactObjects?.writerID !== writerID ||
        artifactObjects?.now !== now
      )
        throw new Error("Environment operation portability belongs to another Runtime or Storage handle")
    }
  }

  function record(key: readonly string[], value: unknown, input: Owner, phase: "discovery" | "publication"): Completed {
    const owner = Owner.parse(input)
    const record = EnvironmentExecutionSchema.Record.parse(value)
    const info = record.execution
    if (
      JSON.stringify(key) !== JSON.stringify(StoragePath.environmentExecution(owner.scopeID, info.id)) ||
      info.scopeID !== owner.scopeID ||
      info.origin.kind !== "session" ||
      info.origin.scopeID !== owner.scopeID ||
      info.origin.sessionID !== owner.sessionID
    )
      throw new Error("Portable Environment operation belongs to another canonical Session")
    if (
      !(phase === "publication"
        ? info.state === "completed"
        : ["completed", "exited", "unsaved", "saved"].includes(info.state)) ||
      !info.status ||
      !ExecutionProtocol.terminal(info.status) ||
      info.status.id !== info.id ||
      info.status.digest !== info.digest ||
      !EnvironmentSchema.sameTarget(info.status.target, info.target) ||
      (info.state === "completed"
        ? Count.parse(info.outputCursor) !== Count.parse(info.status.cursor)
        : Count.parse(info.outputCursor) > Count.parse(info.status.cursor))
    )
      throw new Error("Portable Environment operation requires terminal receipt and complete saved output")
    if (record.schemaVersion === 3) return { ...record, execution: { ...record.execution, origin: info.origin } }
    return { ...record, execution: { ...record.execution, origin: info.origin } }
  }

  export function parse(key: readonly string[], value: unknown, input: Owner): Completed {
    return record(key, value, input, "publication")
  }

  function iterate(input: Owner, signal: AbortSignal, phase: "discovery" | "publication") {
    const owner = Owner.parse(input)
    const assertOwner = guard(signal)
    return (async function* () {
      assertOwner()
      for await (const info of EnvironmentExecution.sessionEntries(owner, signal)) {
        assertOwner()
        const key = StoragePath.environmentExecution(info.scopeID, info.id)
        const value = record(key, await Storage.read(key), owner, phase)
        assertOwner()
        yield { key, value }
      }
      assertOwner()
    })()
  }

  export const records = (input: Owner, signal: AbortSignal) => iterate(input, signal, "publication")
  export const discoverRecords = (input: Owner, signal: AbortSignal) => iterate(input, signal, "discovery")

  export function outputKey(record: Completed, cursor: number) {
    Count.positive().parse(cursor)
    if (cursor > record.execution.outputCursor) throw new Error("Portable Environment output exceeds its receipt")
    return StoragePath.environmentOutput(record.execution.scopeID, record.execution.id, cursor)
  }

  export async function validateChunk(content: AsyncIterable<Uint8Array>, cursor: number, signal: AbortSignal) {
    let bytes = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of content) {
      signal.throwIfAborted()
      bytes += chunk.length
      if (bytes > maxChunkBytes) throw new Error("Portable Environment output exceeds its native frame size")
      chunks.push(Uint8Array.from(chunk))
    }
    signal.throwIfAborted()
    const encoded = Buffer.concat(chunks)
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded))
    const value = ExecutionProtocol.Chunk.parse(raw)
    if (value.cursor !== cursor) throw new Error("Portable Environment output cursor disagrees with its receipt")
    return encoded
  }

  export async function outputCount(record: Completed, signal: AbortSignal) {
    record = structuredClone(record)
    const assertOwner = guard(signal)
    const info = record.execution
    let count = 0
    let after: string[] | undefined
    for (;;) {
      assertOwner()
      const page = await Storage.artifactReferences({
        prefix: ["environment_output", info.scopeID, info.id],
        after,
        limit: 128,
      })
      assertOwner()
      for (const artifact of page) {
        signal.throwIfAborted()
        const cursor = Number(artifact.key[3])
        if (JSON.stringify(artifact.key) !== JSON.stringify(outputKey(record, cursor)))
          throw new Error("Portable Environment output has another canonical address")
        count = Count.parse(count + 1)
      }
      if (page.length < 128) break
      after = page.at(-1)?.key
    }
    if (count !== info.outputCursor) throw new Error("Portable Environment output closure is incomplete")
    return count
  }

  export async function install(value: unknown, input: Owner) {
    if (!Storage.inWriteTransaction())
      throw new Error("Completed Environment history requires its native publication transaction")
    const raw = EnvironmentExecutionSchema.Record.parse(value)
    const key = StoragePath.environmentExecution(raw.execution.scopeID, raw.execution.id)
    const record = parse(key, raw, input)
    const [previous] = await Storage.readMany([key])
    if (previous !== undefined) {
      const original = parse(key, previous, input)
      if (JSON.stringify(original) !== JSON.stringify(record))
        throw new Error("Completed Environment operation conflicts with retained native history")
    } else await Storage.write(key, record)
    await EnvironmentExecutionOriginIndex.update(record.execution)
    await Storage.remove(StoragePath.environmentExecutionActive(record.execution.scopeID, record.execution.id))
  }
}
