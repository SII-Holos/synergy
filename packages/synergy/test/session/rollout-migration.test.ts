import { expect, test } from "bun:test"
import { fixture } from "../fixture/rollout"
import { RolloutMigration } from "../../src/session/rollout/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"
import { Global } from "../../src/global"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { MessageV2 } from "../../src/session/message-v2"
import path from "node:path"
import { migrations } from "../../src/session/migration"
import { runMigrations } from "../../src/migration"
import { Session } from "../../src/session"

for (const endpoint of [
  { kind: "channel", channel: { type: "feishu", chatId: "legacy-chat", senderName: null } },
  { kind: "holos", agentId: "archived-agent" },
]) {
  test(`migrates historical ${endpoint.kind} metadata without rewriting its endpoint or unrelated fields`, async () => {
    await fixture(async ({ session, rootID, call }) => {
      const key = StoragePath.sessionInfo(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id))
      const legacy = {
        ...session,
        endpoint,
        time: { ...session.time, archived: 123 },
        retainedMetadata: { source: "historical" },
        cortex: {
          taskID: "legacy-task",
          parentSessionID: session.id,
          parentMessageID: rootID,
          description: "Archived task",
          agent: "synergy",
          startedAt: 1,
          status: "completed",
          retainedDelivery: { source: "historical" },
        },
      }
      await Storage.write(key, legacy)
      try {
        const audit = await RolloutMigration.session(call.owner)
        expect(audit.missing).toContain("cortex:historical_delivery_not_verified")
        const expected = { ...legacy, cortex: { ...legacy.cortex, settledAt: audit.completedAt } }
        expect(await Storage.read<typeof expected>(key)).toEqual(expected)
        expect(await RolloutMigration.session(call.owner)).toEqual(audit)
        expect(await Storage.read<typeof expected>(key)).toEqual(expected)
      } finally {
        await Storage.write(key, session)
      }
    })
  })
}

test("rejects invalid settlement state before changing historical messages or marking migration complete", async () => {
  await fixture(async ({ session, call }) => {
    const scopeID = Identifier.asScopeID(session.scope.id)
    const sessionID = Identifier.asSessionID(session.id)
    const key = StoragePath.sessionInfo(scopeID, sessionID)
    const ids = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sessionID))
    const messageKeys = ids.map((id) => StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(id)))
    const before = await Storage.readMany(messageKeys)
    await Storage.write(key, { ...session, cortex: { status: "invalid" } })
    try {
      await expect(RolloutMigration.session(call.owner)).rejects.toThrow()
      expect(await Storage.readMany(messageKeys)).toEqual(before)
      await expect(Storage.read([...RolloutArtifact.root(call.owner), "history"])).rejects.toBeInstanceOf(
        Storage.NotFoundError,
      )
    } finally {
      await Storage.write(key, session)
    }
  })
})

test("startup migration completes historical endpoints and skips completed work on the next run", async () => {
  await fixture(async ({ session, call }) => {
    const old = await Session.create({ title: "Archived source", parentID: session.id })
    const key = StoragePath.sessionInfo(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id))
    const oldKey = StoragePath.sessionInfo(Identifier.asScopeID(old.scope.id), Identifier.asSessionID(old.id))
    const tracking = StoragePath.metaMigrationLogDomain("session")
    const previous = await Storage.read<Record<string, number>>(tracking).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    const legacy = {
      ...session,
      endpoint: { kind: "channel", channel: { type: "feishu", chatId: "legacy-chat", senderName: null } },
    }
    const archived = {
      ...old,
      endpoint: { kind: "holos", agentId: "retained-agent" },
      time: { ...old.time, archived: 1 },
    }
    try {
      await Storage.write(
        tracking,
        Object.fromEntries(migrations.filter((m) => m.id !== RolloutMigration.migration.id).map((m) => [m.id, 1])),
      )
      await Storage.write(key, legacy)
      await Storage.write(oldKey, archived)
      const brokenID = Identifier.ascending("part")
      await Storage.write(
        StoragePath.messagePart(
          Identifier.asScopeID(session.scope.id),
          Identifier.asSessionID(session.id),
          Identifier.asMessageID(call.runID),
          Identifier.asPartID(brokenID),
        ),
        {
          id: brokenID,
          sessionID: session.id,
          messageID: call.runID,
          type: "attachment",
          mime: "application/octet-stream",
          url: "data:broken",
        },
      )
      const first = await runMigrations({ targetDomain: "session", output: "silent" })
      expect(first.completed).toBe(1)
      expect(await Storage.read<typeof legacy>(key)).toEqual(legacy)
      expect(await Storage.read<typeof archived>(oldKey)).toEqual(archived)
      expect(await Storage.read([...RolloutArtifact.root(call.owner), "history"])).toMatchObject({
        version: 1,
        missing: [`attachment:${brokenID}:original_not_recoverable`],
      })
      expect((await Storage.read<Record<string, number>>(tracking))[RolloutMigration.migration.id]).toBeGreaterThan(1)
      const second = await runMigrations({ targetDomain: "session", output: "silent" })
      expect(second.completed).toBe(0)
    } finally {
      await Storage.write(key, session)
      await Storage.write(oldKey, old)
      await Session.remove(old.id)
      if (previous) await Storage.write(tracking, previous)
      else await Storage.remove(tracking)
    }
  })
})

test("legacy migration restores retained output, preserves historical cost, and is reentrant", async () => {
  await fixture(async ({ session, rootID, call }) => {
    const scopeID = Identifier.asScopeID(session.scope.id),
      sessionID = Identifier.asSessionID(session.id)
    const partID = Identifier.ascending("part")
    const key = StoragePath.messagePart(scopeID, sessionID, Identifier.asMessageID(rootID), Identifier.asPartID(partID))
    const outputPath = path.join(Global.Path.toolOutput, `tool_${crypto.randomUUID()}`)
    await Bun.write(outputPath, "retained original".repeat(10000))
    const legacy = {
      id: partID,
      sessionID,
      messageID: rootID,
      type: "tool",
      tool: "read",
      callID: "old",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "read",
        metadata: { truncated: true, outputPath },
        time: { start: 1, end: 2, compacted: 3 },
      },
    }
    await Storage.write(key, legacy)
    const first = await RolloutMigration.session(call.owner)
    const migrated = MessageV2.Part.parse(await Storage.read(key))
    expect(migrated.type === "tool" && migrated.state.status === "completed" && migrated.state.output).toBe("")
    if (migrated.type !== "tool" || migrated.state.status !== "completed" || !migrated.state.outputArtifact)
      throw new Error("missing migrated evidence")
    const chunks = []
    for await (const chunk of RolloutArtifact.read(call.owner, migrated.state.outputArtifact)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe("retained original".repeat(10000))
    const second = await RolloutMigration.session(call.owner)
    expect(second).toEqual(first)
    expect(await Bun.file(outputPath).exists()).toBe(true)
    expect(await Storage.read<MessageV2.Part>(key)).toEqual(migrated)
    const messages = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sessionID))
    for (const id of messages) {
      const info = await Storage.read<MessageV2.Info>(
        StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(id)),
      )
      if (info.role === "assistant") {
        expect(info.cost).toBe(123)
        expect(info.accounting?.kind).toBe("legacy")
      }
    }
  })
})

test("migration never treats an arbitrary legacy path as trusted output", async () => {
  await fixture(async ({ session, rootID, call }) => {
    const partID = Identifier.ascending("part")
    const key = StoragePath.messagePart(
      Identifier.asScopeID(session.scope.id),
      Identifier.asSessionID(session.id),
      Identifier.asMessageID(rootID),
      Identifier.asPartID(partID),
    )
    await Storage.write(key, {
      id: partID,
      sessionID: session.id,
      messageID: rootID,
      type: "tool",
      tool: "read",
      callID: "old",
      state: {
        status: "completed",
        input: {},
        output: "preview",
        title: "read",
        metadata: { truncated: true, outputPath: "/etc/passwd" },
        time: { start: 1, end: 2 },
      },
    })
    const result = await RolloutMigration.session(call.owner)
    expect(result.missing).toContain(`tool:${partID}:original_not_recoverable`)
    const part = MessageV2.Part.parse(await Storage.read(key))
    expect(part.type === "tool" && part.state.status === "completed" && part.state.outputArtifact).toBeUndefined()
  })
})
