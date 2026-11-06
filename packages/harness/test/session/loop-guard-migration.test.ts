import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { migrations } from "../../src/session/migration"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { Storage } from "../../src/storage/storage"
import { prepareSessionMigrations } from "../../src/migration"

test("owner upgrade removes only retired injected guard notices and preserves user quotes and other owners", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const other = await Session.create({ workspace: null })
        const text =
          "[Tool repeat loop detected] The same tool has been called successfully with the same arguments 3 times in a row."
        const write = async (sessionID: string) => {
          const root = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
          })
          for (const part of [
            { text, synthetic: true },
            { text, origin: "user" as const },
            { text: "All memory facts remain intact.", origin: "system" as const },
          ])
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID,
              messageID: root.id,
              type: "text",
              ...part,
            })
          return root.id
        }
        const rootID = await write(session.id)
        const otherRootID = await write(other.id)
        await Session.flushPartWrites()
        const migration = migrations.find((m) => m.id === "20261011-session-retire-loop-guard-notices")!
        expect(migration?.execution).toBe("session")
        await migration.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        await migration.upSession!({ scopeID: session.scope.id, sessionID: session.id }, () => {})
        const parts = (await MessageV2.get({ sessionID: session.id, messageID: rootID })).parts
        expect(parts).toHaveLength(2)
        expect(parts.filter((p) => p.type === "text").map((p) => p.text)).toEqual([
          text,
          "All memory facts remain intact.",
        ])
        expect(
          await Storage.query({ kind: "part", scopeID: other.scope.id, sessionID: other.id, messageID: otherRootID }),
        ).toHaveLength(3)
        expect((await MessageV2.get({ sessionID: other.id, messageID: otherRootID })).parts).toHaveLength(2)
      },
    }),
  )
})

test("central owner upgrade persists its receipt and removed notices across reopen", async () => {
  await using home = await tmpdir()
  let sessionID = ""
  let messageID = ""
  const receipt = () => [
    "sessions",
    "home",
    sessionID,
    "migrations",
    "session",
    "20261011-session-retire-loop-guard-notices",
  ]
  const runtime = await testRuntime({ home: home.path })
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          sessionID = (await Session.create({ workspace: null })).id
          messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID,
            role: "user",
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID,
            type: "text",
            origin: "system",
            text: "[Search early stop] Historical generated protection notice.",
          })
          await Session.flushPartWrites(sessionID)
          await Storage.remove(receipt())
          await Session.get(sessionID)
          expect((await Storage.readMany([receipt()]))[0]).toBeUndefined()
          await prepareSessionMigrations({ scopeID: "home", sessionID })
          expect((await Storage.readMany<{ completed: number }>([receipt()]))[0]?.completed).toBeGreaterThan(0)
          expect((await MessageV2.get({ sessionID, messageID })).parts).toEqual([])
        },
      }),
    )
  } finally {
    await runtime.close()
  }
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const before = (await Storage.readMany([receipt()]))[0]
        await prepareSessionMigrations({ scopeID: "home", sessionID })
        expect((await Storage.readMany([receipt()]))[0]).toEqual(before)
        expect(before).toBeDefined()
        expect((await MessageV2.get({ sessionID, messageID })).parts).toEqual([])
      },
    }),
  )
})
