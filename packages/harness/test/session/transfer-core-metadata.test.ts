import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionTransferCore as Core } from "../../src/session/transfer-core"
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
