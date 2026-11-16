import { expect, test } from "bun:test"
import { z } from "zod"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"

test("stored Core metadata keeps its canonical index, Scope and root without hydration or writes", async () => {
  await using directory = await tmpdir()
  const home = path.join(directory.path, "original")
  await using source = await testRuntime({ home, register: Core.register })
  const session = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        await Storage.update<Record<string, unknown>>(
          StoragePath.sessionInfo(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id)),
          (raw) => {
            raw.futureOwner = { retained: true }
          },
        )
        return session
      },
    }),
  )
  await source.close()
  await using cold = await testRuntime({ home, register: Core.register })
  await cold.run(async () => {
    const selector = { scopeID: session.scope.id, sessionID: session.id }
    const rows = async () => {
      const result = []
      for await (const row of Storage.records({ prefix: [], limit: 128 })) result.push(row)
      return result
    }
    const before = await rows(),
      stats = SessionManager.runtimeStats()
    expect((await Core.storedInfo(selector)).raw.futureOwner).toEqual({ retained: true })
    expect((await Core.storedInfo(selector)).info.parentID).toBeUndefined()
    expect(SessionManager.runtimeStats()).toEqual(stats)
    expect(await rows()).toEqual(before)
    await expect(Core.storedInfo({ ...selector, scopeID: "another-scope" })).rejects.toThrow("absent")
    const key = StoragePath.sessionIndex(Identifier.asSessionID(session.id))
    const [original] = await Storage.readMany([key])
    for (const change of [
      { scopeID: "another-scope" },
      { sessionID: "another-session" },
      { parentID: "another-root" },
    ]) {
      await Storage.write(key, { ...Session.toIndex(session), ...change })
      await expect(Core.storedInfo(selector)).rejects.toThrow("canonical owner")
    }
    await Storage.write(key, original)
    const infoKey = StoragePath.sessionInfo(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id))
    await Storage.update<Record<string, unknown>>(infoKey, (raw) => {
      raw.id = Identifier.ascending("session")
    })
    await expect(Core.storedInfo(selector)).rejects.toThrow("canonical owner")
  })
})

test("optional stored Core presence rejects partial pairs and mismatched canonical owners", async () => {
  await using runtime = await testRuntime({ register: Core.register })
  const failure = (pending: Promise<unknown>) =>
    pending.then(
      () => undefined,
      (error: unknown) => error,
    )
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const absent = { scopeID: "home", sessionID: Identifier.ascending("session") }
        expect(await Core.storedInfoIfPresent(absent)).toBeUndefined()
        expect(await Core.storedInfoIfComplete(absent)).toBeUndefined()
        expect(await failure(Core.storedInfo(absent))).toBeInstanceOf(Owners.Rejected)
        const session = await Session.create({ workspace: null, environmentID: null })
        const selector = { scopeID: session.scope.id, sessionID: session.id }
        const indexKey = StoragePath.sessionIndex(Identifier.asSessionID(session.id))
        const infoKey = StoragePath.sessionInfo(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
        )
        const expected = await Core.storedInfo(selector)
        expect(await Core.storedInfoIfPresent(selector)).toEqual(expected)
        const discarded = new Error("Rollback the partial canonical pair")
        for (const missing of [indexKey, infoKey]) {
          const outcome = await failure(
            Storage.transaction(async () => {
              await Storage.remove(missing)
              expect(await Core.storedInfoIfComplete(selector)).toBeUndefined()
              const rejected = await failure(Core.storedInfoIfPresent(selector))
              expect(rejected).toBeInstanceOf(Owners.Rejected)
              expect(rejected).toMatchObject({ data: { message: "Stored Session metadata or index is absent" } })
              throw discarded
            }),
          )
          expect(outcome).toBe(discarded)
          expect(await Core.storedInfoIfPresent(selector)).toEqual(expected)
        }
        for (const [change, message] of [
          [{ scopeID: "another-scope" }, "Stored Session metadata index changed its actual Scope"],
          [{ sessionID: "another-session" }, "Stored Session metadata and index have another canonical owner"],
          [{ parentID: "another-parent" }, "Stored Session metadata and index have another canonical owner"],
        ] as const) {
          const rejected = await failure(
            Storage.transaction(async () => {
              await Storage.update<Record<string, unknown>>(indexKey, (index) => Object.assign(index, change))
              return Core.storedInfoIfPresent(selector)
            }),
          )
          expect(rejected).toBeInstanceOf(Owners.Rejected)
          expect(rejected).toMatchObject({ data: { message } })
          expect(await Core.storedInfoIfPresent(selector)).toEqual(expected)
        }
        const malformed = await failure(
          Storage.transaction(async () => {
            await Storage.update<Record<string, unknown>>(indexKey, (index) => {
              index.scopeID = 1
            })
            return Core.storedInfoIfPresent(selector)
          }),
        )
        expect(malformed).toBeInstanceOf(z.ZodError)
        expect(await Core.storedInfoIfPresent(selector)).toEqual(expected)
        const foreign = { ...selector, scopeID: "another-scope" }
        expect(await failure(Core.storedInfo(foreign))).toMatchObject({
          data: { message: "Stored Session metadata or index is absent" },
        })
        expect(await failure(Core.storedInfoIfPresent(foreign))).toMatchObject({
          data: { message: "Stored Session metadata index changed its actual Scope" },
        })
      },
    }),
  )
})
