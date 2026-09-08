import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, rename, rm } from "node:fs/promises"
import { fixture } from "../support/rollout"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Global } from "../../src/global"
import { Attachment } from "../../src/attachment"
import { MessageV2 } from "../../src/session/message-v2"
import { RolloutMigration } from "../../src/session/rollout/migration"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutAttachment } from "../../src/session/rollout/attachment"
import { RolloutRecordingError } from "../../src/session/rollout/error"

for (const nested of [false, true]) {
  test(`migration retains unreadable ${nested ? "tool" : "message"} attachments and recovers readable siblings`, async () => {
    await fixture(async ({ session, rootID, call }) => {
      const scopeID = Identifier.asScopeID(session.scope.id)
      const sessionID = Identifier.asSessionID(session.id)
      const messageID = Identifier.asMessageID(rootID)
      const urls = [
        "data:broken",
        "data:text/plain;base64,!",
        "asset://bad",
        "asset://[",
        "asset://0000000000000000.txt",
        "data:text/plain,hello%20world",
        "data:text/plain;base64,b3JpZ2luYWw=",
      ]
      const attachments = urls.map((url) => ({
        type: "attachment" as const,
        id: Identifier.ascending("part"),
        sessionID,
        messageID,
        mime: "text/plain",
        url,
      }))
      const toolID = Identifier.ascending("part")
      const keys = nested
        ? [StoragePath.messagePart(scopeID, sessionID, messageID, Identifier.asPartID(toolID))]
        : attachments.map((a) => StoragePath.messagePart(scopeID, sessionID, messageID, Identifier.asPartID(a.id)))
      if (nested)
        await Storage.write(keys[0], {
          type: "tool",
          id: toolID,
          sessionID,
          messageID,
          tool: "read",
          callID: "fixture",
          state: {
            status: "completed",
            input: {},
            output: "retained output",
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
            attachments,
          },
        })
      else for (let i = 0; i < attachments.length; i++) await Storage.write(keys[i], attachments[i])
      const audit = await RolloutMigration.session(call.owner)
      for (const a of attachments.slice(0, 5))
        expect(audit.missing).toContain(`attachment:${a.id}:original_not_recoverable`)
      const parts = await Storage.readMany<MessageV2.Part>(keys)
      const first = parts[0]
      const migrated =
        nested && first?.type === "tool" && first.state.status === "completed"
          ? first.state.attachments!
          : (parts as MessageV2.AttachmentPart[])
      for (let i = 0; i < 5; i++) expect(migrated[i]).toEqual(attachments[i])
      for (const [index, expected] of [
        [5, "hello world"],
        [6, "original"],
      ] as const) {
        const artifact = migrated[index].artifact
        if (!artifact) throw new Error("Missing recovered attachment")
        const chunks = []
        for await (const bytes of RolloutArtifact.read(call.owner, artifact)) chunks.push(bytes)
        expect(Buffer.concat(chunks).toString()).toBe(expected)
      }
      expect(await RolloutMigration.session(call.owner)).toEqual(audit)
      expect(await Storage.readMany<MessageV2.Part>(keys)).toEqual(parts)
      await expect(RolloutAttachment.capture(call.owner, attachments[0])).rejects.toBeInstanceOf(
        Attachment.InvalidUrlError,
      )
    })
  })
}

test("artifact storage failure still blocks migration and retries after storage is repaired", async () => {
  await fixture(async ({ session, rootID, call }) => {
    const id = Identifier.ascending("part")
    const key = StoragePath.messagePart(
      Identifier.asScopeID(session.scope.id),
      Identifier.asSessionID(session.id),
      Identifier.asMessageID(rootID),
      Identifier.asPartID(id),
    )
    await Storage.write(key, {
      type: "attachment",
      id,
      sessionID: session.id,
      messageID: rootID,
      mime: "text/plain",
      url: "data:text/plain;base64,b3JpZ2luYWw=",
    })
    const directory = path.join(Global.Path.data, ...RolloutArtifact.root(call.owner), "artifacts")
    const backup = directory + "-fixture"
    await mkdir(directory, { recursive: true })
    await rename(directory, backup)
    await Bun.write(directory, "blocks artifact directory")
    try {
      await expect(RolloutMigration.session(call.owner)).rejects.toBeInstanceOf(RolloutRecordingError)
      await expect(Storage.read([...RolloutArtifact.root(call.owner), "history"])).rejects.toBeInstanceOf(
        Storage.NotFoundError,
      )
    } finally {
      await rm(directory)
      await rename(backup, directory)
    }
    expect((await RolloutMigration.session(call.owner)).missing).not.toContain(
      `attachment:${id}:original_not_recoverable`,
    )
    expect((await Storage.read<MessageV2.AttachmentPart>(key)).artifact).toBeDefined()
  })
})
