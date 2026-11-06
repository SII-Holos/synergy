import { expect, spyOn, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("a failed session deletion preserves the complete aggregate and snapshot ownership", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "must survive" })
        const original = Storage.remove
        using failure = spyOn(Storage, "remove").mockImplementation(async (key) => {
          if (key[0] === "session_index" && key[1] === session.id) throw new Error("injected delete failure")
          return original(key)
        })
        await expect(Session.remove(session.id)).rejects.toThrow("injected delete failure")
        expect((await Session.get(session.id)).title).toBe("must survive")
        expect((await Storage.readMany([StoragePath.snapshotOwner(scope.id, session.id)]))[0]).toBeUndefined()
      },
    })
  }))

test("a failed session creation publishes neither a session nor an index", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const original = Storage.write
        using failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
          if (key[0] === "session_index") throw new Error("injected index failure")
          return original(key, value)
        })
        await expect(Session.create({ title: "rollback creation" })).rejects.toThrow("injected index failure")
        expect(await Storage.scan(["sessions", scope.id])).toEqual([])
      },
    })
  }))

test("session deletion resolves its owner without an ambient Scope", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create({ title: "offline deletion" }) })
    await Session.remove(session.id)
    expect(await Storage.readMany([["sessions", scope.id, session.id, "info"]])).toEqual([undefined])
  }))

afterRuntimeTests(() => runtime.close())
