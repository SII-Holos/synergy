import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { EnvironmentExecutionSchema } from "../../src/environment/execution-schema"
import { EnvironmentExecutionOriginIndex } from "../../src/environment/execution-origin-index"
import { EnvironmentExecutionPortable as Portable } from "../../src/environment/execution-portable"
import { ExecutionProtocol } from "../../src/environment/executor"

const owner = { scopeID: "home", sessionID: "historical-session" }
function completed() {
  const target = { environmentID: "original-environment", allocationID: "original-allocation", generation: 7 }
  return EnvironmentExecutionSchema.Record.parse({
    schemaVersion: 2,
    execution: {
      id: "original-operation",
      scopeID: "home",
      target,
      origin: {
        kind: "session",
        ...owner,
        rootID: "original-root",
        runID: "original-root",
        messageID: "original-assistant",
        callID: "original-call",
        tool: "bash",
      },
      digest: "a".repeat(64),
      state: "completed",
      outputCursor: 2,
      createdAt: 1,
      updatedAt: 2,
      status: {
        id: "original-operation",
        target,
        digest: "a".repeat(64),
        state: "exited",
        cursor: 2,
        treeDrained: true,
        streamsDrained: true,
        exitCode: 0,
      },
      retainedOwnerFields: { nested: "original-private-history" },
    },
  })
}

test("completed portability reads original canonical records and all exact native output frames", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const original = completed()
    const key = StoragePath.environmentExecution("home", original.execution.id)
    const record = Portable.parse(key, original, owner)
    await Storage.transaction(async () => {
      await Storage.write(key, original)
      await EnvironmentExecutionOriginIndex.update(record.execution)
    })
    for (let cursor = 1; cursor <= 2; cursor++)
      await Storage.writeBinary(
        Portable.outputKey(record, cursor),
        Buffer.from(
          JSON.stringify({ cursor, stream: "stdout", data: Buffer.from(`native-${cursor}`).toString("base64") }),
        ),
      )
    const signal = new AbortController().signal
    const records = []
    for await (const row of Portable.records(owner, signal)) records.push(row)
    expect(JSON.stringify(records)).toBe(JSON.stringify([{ key, value: original }]))
    await expect(Portable.install(record, owner)).rejects.toThrow("publication transaction")
    await Storage.transaction(() => Portable.install(record, owner))
    const changed = {
      ...record,
      execution: {
        ...record.execution,
        digest: "b".repeat(64),
        status: { ...record.execution.status, digest: "b".repeat(64) },
      },
    }
    await expect(Storage.transaction(() => Portable.install(changed, owner))).rejects.toThrow("conflicts")
    expect(await Storage.read(key)).toEqual(original)
    const rollback = new Error("Original completed import rolled back")
    const another = {
      ...record,
      execution: {
        ...record.execution,
        id: "rolled-back-operation",
        status: { ...record.execution.status, id: "rolled-back-operation" },
      },
    }
    await expect(
      Storage.transaction(async () => {
        await Portable.install(another, owner)
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(await Storage.readMany([StoragePath.environmentExecution("home", another.execution.id)])).toEqual([
      undefined,
    ])
    expect(await Portable.outputCount(record, signal)).toBe(2)
    for (let cursor = 1; cursor <= 2; cursor++)
      await Portable.validateChunk(Storage.readBinaryStream(Portable.outputKey(record, cursor)), cursor, signal)
    await Storage.removeTree(Portable.outputKey(record, 2))
    await expect(Portable.outputCount(record, signal)).rejects.toThrow("incomplete")
    expect(await Storage.read(key)).toEqual(original)
    await Storage.writeBinary(StoragePath.environmentOutput("home", original.execution.id, 3), Buffer.from("extra"))
    await expect(Portable.outputCount(record, signal)).rejects.toThrow("exceeds")
    await expect(
      Portable.validateChunk(
        (async function* () {
          yield Buffer.from(JSON.stringify({ cursor: 1, stream: "stdout", data: "" }))
        })(),
        2,
        signal,
      ),
    ).rejects.toThrow("cursor")
    await expect(
      Portable.validateChunk(
        (async function* () {
          yield new Uint8Array(96 * 1024 + 1)
        })(),
        1,
        signal,
      ),
    ).rejects.toThrow("frame size")
  })
})

test("terminal receipt, exact origin and canonical output count are mandatory for portable history", () => {
  const original = completed()
  const key = StoragePath.environmentExecution("home", original.execution.id)
  expect(() => Portable.parse(key, { ...original, schemaVersion: 3 }, owner)).toThrow()
  expect(() => Portable.parse(["environment_execution", "other", original.execution.id], original, owner)).toThrow(
    "canonical Session",
  )
  for (const changes of [
    { state: "saved" },
    { origin: { kind: "legacy-unknown" } },
    { origin: { ...original.execution.origin, sessionID: "another-session" } },
    { outputCursor: 1 },
    { status: { ...original.execution.status, streamsDrained: false } },
    { status: { ...original.execution.status, digest: "b".repeat(64) } },
  ])
    expect(() =>
      Portable.parse(key, { ...original, execution: { ...original.execution, ...changes } }, owner),
    ).toThrow()
})

test("an initial deferred history iterator stays bound to its creating Runtime", async () => {
  await using source = await testRuntime()
  await using target = await testRuntime()
  const reader = source.run(() => Portable.records(owner, new AbortController().signal))
  await target.run(async () => {
    await expect(reader.next()).rejects.toThrow("another Runtime or Storage")
  })
})

test.each(["!!!!", "YQ", "YQ==\n", "YR==", "YWJ=", "YQ==="])(
  "native output frames reject invalid or noncanonical base64 %j",
  async (data) => {
    const frame = { cursor: 1, stream: "stdout", data }
    expect(ExecutionProtocol.Chunk.safeParse(frame).success).toBe(false)
    await expect(
      Portable.validateChunk(
        (async function* () {
          yield Buffer.from(JSON.stringify(frame))
        })(),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow("canonical base64")
  },
)

test("native output validation retains original JSON bytes and snapshots a reusable Buffer", async () => {
  for (const data of ["", "AAECA/7/", "YQ==", "YWI=", "YWJj"]) {
    const original = Buffer.from(`{\n "data": "${data}", "stream": "stdout", "cursor": 1, "nativeField": true\n}`)
    const reusable = Buffer.from(original)
    const validated = await Portable.validateChunk(
      (async function* () {
        yield reusable
        reusable.fill(0)
      })(),
      1,
      new AbortController().signal,
    )
    expect(validated).toEqual(original)
    expect(reusable.every((byte) => byte === 0)).toBe(true)
  }
})

test("discovery admits only original terminal work awaiting its native final save", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const original = completed()
    const key = StoragePath.environmentExecution("home", original.execution.id)
    const signal = new AbortController().signal
    for (const state of ["exited", "unsaved", "saved"] as const) {
      const value = { ...original, execution: { ...original.execution, state, outputCursor: 1 } }
      await Storage.transaction(async () => {
        await Storage.write(key, value)
        await EnvironmentExecutionOriginIndex.update(value.execution)
      })
      const reader = Portable.discoverRecords(owner, signal)
      const discovered: unknown = (await reader.next()).value
      expect(discovered).toEqual({ key, value })
      await reader.return(undefined)
      await expect(Portable.records(owner, signal).next()).rejects.toThrow("terminal receipt")
      await expect(Storage.transaction(() => Portable.install(value, owner))).rejects.toThrow("terminal receipt")
      expect(await Storage.read(key)).toEqual(value)
    }
    for (const patch of [
      { state: "running" },
      { state: "unknown" },
      { state: "cancel_requested" },
      { state: "submitted" },
      { state: "exited", status: { ...original.execution.status, streamsDrained: false } },
      { state: "exited", status: { ...original.execution.status, treeDrained: false } },
      { state: "exited", status: { ...original.execution.status, digest: "b".repeat(64) } },
      { state: "exited", outputCursor: 3 },
      { state: "completed", outputCursor: 1 },
    ]) {
      const value = { ...original, execution: { ...original.execution, ...patch } }
      await Storage.write(key, value)
      await expect(Portable.discoverRecords(owner, signal).next()).rejects.toThrow("terminal receipt")
      expect(await Storage.read(key)).toEqual(value)
    }
  })
})
