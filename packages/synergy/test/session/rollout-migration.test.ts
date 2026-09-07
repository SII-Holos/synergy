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
