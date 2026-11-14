import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { EnvironmentExecutionSchema } from "./execution-schema"
import { MigrationRegistry } from "../migration/registry"

export namespace EnvironmentExecutionOriginIndex {
  const Locator = z.strictObject({ version: z.literal(1), scopeID: z.string().min(1), operationID: z.string().min(1) })
  const Query = z.strictObject({
    scopeID: z.string().min(1),
    sessionID: z.string().min(1),
    rootID: z.string().min(1).optional(),
  })
  const Coverage = z.strictObject({ version: z.literal(1) })
  const coverageKey = ["environment_execution_origin_index", "coverage"]
  export async function reset() {
    if (!Storage.inWriteTransaction())
      throw new Error("Environment execution index rebuild requires its native write transaction")
    await Storage.remove(coverageKey)
    await Storage.removeTree(["environment_execution_session"])
    await Storage.removeTree(["environment_execution_environment"])
  }
  export async function sealCoverage() {
    if (!Storage.inWriteTransaction())
      throw new Error("Environment execution coverage requires its native write transaction")
    await Storage.write(coverageKey, Coverage.parse({ version: 1 }))
  }
  async function assertCoverage() {
    const registered = MigrationRegistry.list()
      .get("environment")
      ?.some((migration) => migration.id === "20261112-environment-execution-origin-storage")
    const [coverage] = await Storage.readMany([coverageKey])
    if (registered && coverage !== undefined) {
      Coverage.parse(coverage)
      return
    }
    if ((await Storage.queryKeys({ prefix: ["environment_execution"], limit: 1 })).length)
      throw new Error("Environment execution origin index requires its complete owning migration")
  }
  const sessionKey = (info: EnvironmentExecutionSchema.Info) =>
    info.origin.kind === "session"
      ? ["environment_execution_session", info.scopeID, info.origin.sessionID, info.origin.rootID, info.id]
      : undefined
  const environmentKey = (info: EnvironmentExecutionSchema.Info) => [
    "environment_execution_environment",
    info.target.environmentID,
    info.scopeID,
    info.id,
  ]

  export interface HistoricalReader {
    read<T>(schema: z.ZodType<T>, key: string[]): T
    entries(prefix: string[]): Iterable<{ key: string[]; value: unknown }>
  }
  export function history(reader: HistoricalReader, accept: (key: string[]) => void) {
    let covered = false
    for (const entry of reader.entries(["environment_execution_origin_index"])) {
      if (covered || JSON.stringify(entry.key) !== JSON.stringify(coverageKey))
        throw new Error("Historical Environment execution index has another coverage record")
      Coverage.parse(entry.value)
      covered = true
      accept(entry.key)
    }
    const coverage = () => {
      if (!covered) throw new Error("Historical Environment execution index requires complete original coverage")
    }
    const matches = (locator: z.infer<typeof Locator>, info: EnvironmentExecutionSchema.Info) => {
      if (locator.scopeID !== info.scopeID || locator.operationID !== info.id)
        throw new Error("Historical Environment execution locator differs from its canonical record")
    }
    for (const entry of reader.entries(["environment_execution"])) {
      coverage()
      const info = EnvironmentExecutionSchema.Record.parse(entry.value).execution
      if (JSON.stringify(entry.key) !== JSON.stringify(StoragePath.environmentExecution(info.scopeID, info.id)))
        throw new Error("Historical Environment execution has another canonical address")
      if (info.origin.kind === "session" && info.origin.scopeID !== info.scopeID)
        throw new Error("Historical Environment execution origin belongs to another Scope")
      const session = sessionKey(info)
      if (session) matches(reader.read(Locator, session), info)
      if (info.state !== "completed") matches(reader.read(Locator, environmentKey(info)), info)
    }
    for (const entry of reader.entries(["environment_execution_session"])) {
      coverage()
      const locator = Locator.parse(entry.value)
      const info = reader.read(
        EnvironmentExecutionSchema.Record,
        StoragePath.environmentExecution(locator.scopeID, locator.operationID),
      ).execution
      matches(locator, info)
      if (JSON.stringify(entry.key) !== JSON.stringify(sessionKey(info)))
        throw new Error("Historical Environment Session index differs from its original execution")
      accept(entry.key)
    }
    for (const entry of reader.entries(["environment_execution_environment"])) {
      coverage()
      const locator = Locator.parse(entry.value)
      const info = reader.read(
        EnvironmentExecutionSchema.Record,
        StoragePath.environmentExecution(locator.scopeID, locator.operationID),
      ).execution
      matches(locator, info)
      if (info.state === "completed" || JSON.stringify(entry.key) !== JSON.stringify(environmentKey(info)))
        throw new Error("Historical Environment active index is completed or belongs to another execution")
      accept(entry.key)
    }
  }

  export async function update(info: EnvironmentExecutionSchema.Info) {
    if (!Storage.inWriteTransaction())
      throw new Error("Environment execution indexes require the canonical write transaction")
    const locator = Locator.parse({ version: 1, scopeID: info.scopeID, operationID: info.id })
    const session = sessionKey(info)
    if (session) await Storage.write(session, locator)
    if (info.state === "completed") await Storage.remove(environmentKey(info))
    else await Storage.write(environmentKey(info), locator)
  }

  function owner() {
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const objectConfig = artifactObjects && {
      blobs: artifactObjects.blobs,
      writerID: artifactObjects.writerID,
      now: artifactObjects.now,
    }
    return () => {
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== objectConfig?.blobs ||
        artifactObjects?.writerID !== objectConfig?.writerID ||
        artifactObjects?.now !== objectConfig?.now
      )
        throw new Error("Environment execution index belongs to another Runtime or Storage handle")
    }
  }

  export function sessionEntries(
    value: z.infer<typeof Query>,
    signal?: AbortSignal,
  ): AsyncIterable<EnvironmentExecutionSchema.Info> {
    const input = Query.parse(value)
    const assertOwner = owner()
    return (async function* () {
      assertOwner()
      await assertCoverage()
      assertOwner()
      const prefix = [
        "environment_execution_session",
        input.scopeID,
        input.sessionID,
        ...(input.rootID ? [input.rootID] : []),
      ]
      for await (const row of Storage.records({ prefix, limit: 64 })) {
        assertOwner()
        signal?.throwIfAborted()
        const locator = Locator.parse(row.value)
        const raw = await Storage.read(StoragePath.environmentExecution(locator.scopeID, locator.operationID))
        assertOwner()
        const info = EnvironmentExecutionSchema.Record.parse(raw).execution
        if (
          info.scopeID !== input.scopeID ||
          info.id !== locator.operationID ||
          JSON.stringify(sessionKey(info)) !== JSON.stringify(row.key)
        )
          throw new Error("Environment execution Session index differs from its canonical owner")
        yield EnvironmentExecutionSchema.Info.parse(info)
        assertOwner()
      }
    })()
  }

  export function environmentEntries(
    environmentID: string,
    signal?: AbortSignal,
  ): AsyncIterable<EnvironmentExecutionSchema.Info> {
    environmentID = z.string().min(1).parse(environmentID)
    const assertOwner = owner()
    return (async function* () {
      assertOwner()
      await assertCoverage()
      assertOwner()
      for await (const row of Storage.records({
        prefix: ["environment_execution_environment", environmentID],
        limit: 64,
      })) {
        assertOwner()
        signal?.throwIfAborted()
        const locator = Locator.parse(row.value)
        const raw = await Storage.read(StoragePath.environmentExecution(locator.scopeID, locator.operationID))
        assertOwner()
        const info = EnvironmentExecutionSchema.Record.parse(raw).execution
        if (
          JSON.stringify(environmentKey(info)) !== JSON.stringify(row.key) ||
          info.id !== locator.operationID ||
          info.scopeID !== locator.scopeID ||
          info.state === "completed"
        )
          throw new Error("Environment active execution index differs from its canonical owner")
        yield EnvironmentExecutionSchema.Info.parse(info)
        assertOwner()
      }
    })()
  }
}
