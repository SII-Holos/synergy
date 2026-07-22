import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRecovery } from "../../src/session/recovery"
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

async function addAssistantMessage(sessionID: string, parentID: string, created: number) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    time: { created, completed: created },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } satisfies MessageV2.Assistant)
}

function observesMessageInfo(key: string[], sessionID: string) {
  return key.at(-1) === "info" && key.includes("messages") && key.includes(sessionID)
}

function observeMessageInfoReads(sessionID: string) {
  const read = spyOn(Storage, "read")
  const readMany = spyOn(Storage, "readMany")
  return {
    read,
    readMany,
    count() {
      const direct = read.mock.calls.filter(([key]) => observesMessageInfo(key, sessionID)).length
      const batched = readMany.mock.calls.reduce(
        (total, [keys]) => total + keys.filter((key) => observesMessageInfo(key, sessionID)).length,
        0,
      )
      return direct + batched
    },
  }
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

  test("MessageV2.stream stops reading message infos when its consumer stops", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        for (let index = 0; index < 20; index++) {
          await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: 1_000 + index },
          })
        }

        const observed = observeMessageInfoReads(session.id)
        using _read = observed.read
        using _readMany = observed.readMany
        const newest: string[] = []
        for await (const message of MessageV2.stream({ sessionID: session.id })) {
          newest.push(message.info.id)
          if (newest.length === 4) break
        }

        expect(newest).toHaveLength(4)
        expect(observed.count()).toBeLessThanOrEqual(4)
      },
    })
  })

  test("rebuilds a missing order index from canonical message infos", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const scopeID = Identifier.asScopeID(scope.id)
        const sessionID = Identifier.asSessionID(session.id)
        const messages = [
          { id: `msg_${"f".repeat(26)}`, created: 100 },
          { id: `msg_${"a".repeat(26)}`, created: 300 },
          { id: `msg_${"b".repeat(26)}`, created: 200 },
        ]
        for (const message of messages) {
          await Storage.write(StoragePath.messageInfo(scopeID, sessionID, Identifier.asMessageID(message.id)), {
            id: message.id,
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: message.created },
          } satisfies MessageV2.User)
        }
        await MessageV2.removeOrderIndex(scopeID, sessionID)

        const newest: string[] = []
        for await (const message of MessageV2.stream({ sessionID: session.id })) {
          newest.push(message.info.id)
        }

        expect(newest).toEqual([messages[1]!.id, messages[2]!.id, messages[0]!.id])
        expect(await Storage.scan(StoragePath.sessionMessageOrderMarkersRoot(scopeID, sessionID))).toHaveLength(3)
      },
    })
  })

  test("keeps the order index consistent when messages move or are removed", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const first = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test-provider", modelID: "test-model" },
          time: { created: 100 },
        })
        const second = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test-provider", modelID: "test-model" },
          time: { created: 200 },
        })

        await Session.updateMessage({ ...first, time: { created: 300 } })
        await Session.removeMessage({ sessionID: session.id, messageID: second.id })

        const newest: string[] = []
        for await (const message of MessageV2.stream({ sessionID: session.id })) {
          newest.push(message.info.id)
        }
        const scopeID = Identifier.asScopeID(scope.id)
        const sessionID = Identifier.asSessionID(session.id)
        expect(newest).toEqual([first.id])
        expect(await Storage.scan(StoragePath.sessionMessageOrderMarkersRoot(scopeID, sessionID))).toHaveLength(1)
      },
    })
  })

  test("removes the derived order index with its session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await addUserMessage(session.id)
        const scopeID = Identifier.asScopeID(scope.id)
        const sessionID = Identifier.asSessionID(session.id)
        expect(await Storage.scan(StoragePath.sessionMessageOrderRoot(scopeID, sessionID))).not.toEqual([])

        await Session.remove(session.id)

        expect(await Storage.scan(StoragePath.sessionMessageOrderRoot(scopeID, sessionID))).toEqual([])
      },
    })
  })

  test("removes the derived order index through recovery deletion", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await addUserMessage(session.id)
        const scopeID = Identifier.asScopeID(scope.id)
        const sessionID = Identifier.asSessionID(session.id)

        const report = await SessionRecovery.remove({ sessionID: session.id, scopeID: scope.id })

        expect(report.errors).toEqual([])
        expect(await Storage.scan(StoragePath.sessionMessageOrderRoot(scopeID, sessionID))).toEqual([])
      },
    })
  })

  test("Session.list reads only the newest assistant needed for recovery status", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        for (let index = 0; index < 10; index++) {
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            time: { created: 1_000 + index * 2 },
          })
          await addAssistantMessage(session.id, user.id, 1_001 + index * 2)
        }

        const observed = observeMessageInfoReads(session.id)
        using _read = observed.read
        using _readMany = observed.readMany
        const listed = await Session.list({ limit: 1 })

        expect(listed.data.map((item) => item.id)).toContain(session.id)
        expect(observed.count()).toBeLessThanOrEqual(1)
      },
    })
  })
})
