import { expect, test } from "bun:test"
import path from "node:path"
import type { Scope } from "../../src/scope"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionNav } from "../../src/session/nav"
import { migrations } from "../../src/session/migration"
import { runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"

async function isolated(body: (scope: Scope) => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: crypto.randomUUID(),
    filename: path.join(tmp.path, "indexes.sqlite"),
  })
  try {
    await Storage.provide({ store, artifactDirectory: tmp.path }, async () => {
      const scope = await tmp.scope()
      await ScopeContext.provide({ scope, fn: () => body(scope) })
    })
  } finally {
    await store.close()
  }
}

test("startup rebuild preserves archived retired endpoints and nullable Channel metadata", async () => {
  await isolated(async (scope) => {
    const archived = await Session.create({ title: "Archived source" })
    const channel = await Session.create({ title: "Channel source" })
    const legacy = {
      ...archived,
      endpoint: { kind: "holos", agentId: "retained-agent" },
      time: { ...archived.time, archived: 123 },
      retainedMetadata: { source: "historical" },
    }
    const current = {
      ...channel,
      endpoint: {
        kind: "channel",
        channel: { type: "feishu", chatId: "legacy-chat", senderName: null },
      },
    }
    const key = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(archived.id))
    const currentKey = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(channel.id))
    const tracking = StoragePath.metaMigrationLogDomain("session")
    const [previous] = await Storage.readMany<Record<string, number>>([tracking])
    try {
      await Storage.write(key, legacy)
      await Storage.write(currentKey, current)
      await Storage.write(
        tracking,
        Object.fromEntries(
          migrations.filter((m) => m.id !== "20260914-transactional-session-indexes").map((m) => [m.id, 1]),
        ),
      )
      expect((await runMigrations({ targetDomain: "session", output: "silent" })).completed).toBe(1)
      expect(await Storage.read<typeof legacy>(key)).toEqual(legacy)
      expect(await Storage.read<typeof current>(currentKey)).toEqual(current)
      expect(await Storage.read<Record<string, unknown>>(["session_index", archived.id])).toEqual({
        sessionID: archived.id,
        scopeID: scope.id,
        directory: scope.directory,
      })
      expect(await Storage.scan(["endpoint_session", "holos:retained-agent"])).toEqual([])
      const endpoint = SessionEndpoint.fromChannel({ type: "feishu", chatId: "legacy-chat" })
      expect(
        await Storage.read<{ sessionID: string; scopeID: string }>(
          StoragePath.endpointSession(SessionEndpoint.toKey(endpoint), Identifier.asSessionID(channel.id)),
        ),
      ).toEqual({ sessionID: channel.id, scopeID: scope.id })
      const nav = await SessionNav.readNavIndex(scope.id)
      expect(nav.entries.find((entry) => entry.id === archived.id)).toMatchObject({ archived: true })
      expect(nav.entries.find((entry) => entry.id === archived.id)?.endpointKind).toBeUndefined()
      expect(nav.entries.find((entry) => entry.id === channel.id)).toMatchObject({
        endpointKind: "channel",
        chatId: "legacy-chat",
      })
      expect((await runMigrations({ targetDomain: "session", output: "silent" })).completed).toBe(0)
      await Storage.transaction((tx) => Session.rebuildStorageIndexes(tx))
      expect(await Storage.read<typeof legacy>(key)).toEqual(legacy)
    } finally {
      await Storage.write(key, archived)
      await Storage.write(currentKey, channel)
      await Session.remove(archived.id)
      await Session.remove(channel.id)
      if (previous) await Storage.write(tracking, previous)
      else await Storage.remove(tracking)
    }
  })
})

test("index rebuild rejects an active retired endpoint and rolls back existing projections", async () => {
  await isolated(async (scope) => {
    const session = await Session.create({ title: "Unexpected active endpoint" })
    const key = StoragePath.sessionInfo(Identifier.asScopeID(scope.id), Identifier.asSessionID(session.id))
    const index = await Storage.read<Record<string, unknown>>(["session_index", session.id])
    const legacy = { ...session, endpoint: { kind: "holos", agentId: "active-agent" } }
    try {
      await Storage.write(key, legacy)
      await expect(Storage.transaction((tx) => Session.rebuildStorageIndexes(tx))).rejects.toThrow(
        "Retired Session endpoint must be archived before rebuilding indexes",
      )
      expect(await Storage.read<typeof legacy>(key)).toEqual(legacy)
      expect(await Storage.read<Record<string, unknown>>(["session_index", session.id])).toEqual(index)
    } finally {
      await Storage.write(key, session)
      await Session.remove(session.id)
    }
  })
})
