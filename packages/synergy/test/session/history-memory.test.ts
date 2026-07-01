import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

function storageFile(key: string[]) {
  return path.join(Global.Path.data, ...key) + ".json"
}

async function writeCorruptJson(key: string[]) {
  const target = storageFile(key)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, "{".repeat(1024))
}

async function addUserMessage(sessionID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
}

describe("session history memory bounds", () => {
  test("Session.list does not read message part files", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const message = await addUserMessage(session.id)
        await writeCorruptJson(
          StoragePath.messagePart(
            Identifier.asScopeID(scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID(message.id),
            Identifier.asPartID("part_corrupt"),
          ),
        )

        const listed = await Session.list({ limit: 100 })
        expect(listed.data.some((item) => item.id === session.id)).toBe(true)
      },
    })
  })

  test("Session.messages skips a corrupt part without dropping the whole session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const message = await addUserMessage(session.id)
        const scopeID = Identifier.asScopeID(scope.id)
        const sessionID = Identifier.asSessionID(session.id)
        const messageID = Identifier.asMessageID(message.id)

        await Storage.write(StoragePath.messagePart(scopeID, sessionID, messageID, Identifier.asPartID("part_ok")), {
          id: "part_ok",
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "visible",
        })
        await writeCorruptJson(
          StoragePath.messagePart(scopeID, sessionID, messageID, Identifier.asPartID("part_corrupt")),
        )

        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.parts.map((part) => part.id)).toEqual(["part_ok"])
      },
    })
  })
})
