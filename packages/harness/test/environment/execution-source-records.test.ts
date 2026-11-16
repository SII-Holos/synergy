import { expect, test } from "bun:test"
import { z } from "zod"
import { EnvironmentExecutionSchema as Schema } from "../../src/environment/execution-schema"
import { EnvironmentExecutionSource } from "../../src/environment/execution-source"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { upgradeImportedRecord } from "../../src/migration"

function receipt() {
  const target = { environmentID: "service-environment", allocationID: "physical-allocation", generation: 4 }
  const service = {
    id: "physical-operation",
    scopeID: "service-project",
    target,
    origin: { kind: "host", owner: "registered-service", invocationID: "original-invocation" },
    digest: "a".repeat(64),
    state: "completed",
    outputCursor: 0,
    createdAt: 1,
    updatedAt: 2,
    status: {
      id: "physical-operation",
      target,
      digest: "a".repeat(64),
      state: "exited",
      cursor: 0,
      treeDrained: true,
      streamsDrained: true,
      exitCode: 0,
    },
    originalOwnerData: { retained: true },
  } satisfies z.input<typeof Schema.PersistedInfo>
  return {
    schemaVersion: 3,
    execution: {
      ...service,
      id: "native-operation",
      scopeID: "native-project",
      origin: {
        kind: "session",
        scopeID: "native-project",
        sessionID: "session",
        rootID: "root",
        runID: "root",
        messageID: "message",
        callID: "call",
        tool: "bash",
      },
      status: { ...service.status, id: "native-operation" },
      source: { version: 1, provider: "service", target, binding: { originalGrant: "grant", generation: 1 } },
      sourceObservation: service,
    },
  } satisfies z.input<typeof Schema.Record>
}

test("retained remote execution receipts preserve both native origins without creating execution authority", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const raw = receipt(),
      key = ["environment_execution", "native-project", "native-operation"]
    expect(Schema.Record.parse(raw)).toEqual(raw)
    expect(upgradeImportedRecord(key, raw)).toEqual(raw)
    await Storage.write(key, raw)
    expect(Schema.Record.parse(await Storage.read(key))).toEqual(raw)
    await expect(
      EnvironmentExecutionSource.inspect(EnvironmentExecutionSource.Record.parse(raw.execution.source), {
        scopeID: "native-project",
        operationID: "native-operation",
        digest: raw.execution.digest,
        origin: Schema.Info.parse(raw.execution).origin,
      }),
    ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
    expect(await Storage.queryKeys({ prefix: ["environment"], limit: 1 })).toHaveLength(0)
    expect(await Storage.queryKeys({ prefix: ["environment_use"], limit: 1 })).toHaveLength(0)
  })
})

test("remote record readers reject mismatched or incomplete physical receipts and preserve native version two", () => {
  const raw = receipt()
  expect(() => Schema.Record.parse({ ...raw, schemaVersion: 99 })).toThrow()
  expect(() => Schema.Record.parse({ ...raw, schemaVersion: 2 })).toThrow()
  expect(() => Schema.Record.parse({ ...raw, execution: { ...raw.execution, source: undefined } })).toThrow()
  expect(() => Schema.Record.parse({ ...raw, execution: { ...raw.execution, sourceObservation: undefined } })).toThrow()
  expect(() =>
    Schema.Record.parse({
      ...raw,
      execution: {
        ...raw.execution,
        sourceObservation: { ...raw.execution.sourceObservation, digest: "b".repeat(64) },
      },
    }),
  ).toThrow()
  expect(() =>
    Schema.Record.parse({
      ...raw,
      execution: { ...raw.execution, sourceObservation: { ...raw.execution.sourceObservation, outputCursor: 1 } },
    }),
  ).toThrow()
  const { source, sourceObservation, ...native } = raw.execution
  expect(Schema.upgrade({ schemaVersion: 2, execution: native })).toEqual({ schemaVersion: 2, execution: native })
  const { origin, ...legacy } = native
  expect(Schema.upgrade(legacy)).toMatchObject({ schemaVersion: 2, execution: { origin: { kind: "legacy-unknown" } } })
})
