import { $, sleep } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Snapshot } from "../../src/session/snapshot"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session rollback history", () => {
  test("rollback hides effective turns without deleting raw messages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const cursorPath = StoragePath.sessionSummaryCursor(
          Identifier.asScopeID(scope.id),
          Identifier.asSessionID(session.id),
        )
        await Storage.write(cursorPath, { from: "from_tree", to: "to_tree", files: [] })
        const [u1] = await writeTurn(session.id, tmp.path, "first", "one")
        await writeTurn(session.id, tmp.path, "second", "two")
        await writeTurn(session.id, tmp.path, "third", "three")

        const firstRollback = (await Session.rollback({
          sessionID: session.id,
          numTurns: 1,
        })) as SessionHistory.RollbackEvent
        await expect(Storage.read(cursorPath)).rejects.toBeInstanceOf(Storage.NotFoundError)
        expect(firstRollback.droppedUserMessageIDs).toHaveLength(1)
        expect(await visibleTexts(session.id)).toEqual(["first", "one", "second", "two"])
        expect(await rawTexts(session.id)).toEqual(["first", "one", "second", "two", "third", "three"])

        await Session.rollback({ sessionID: session.id, numTurns: 1 })
        expect(await visibleTexts(session.id)).toEqual(["first", "one"])

        await Storage.write(cursorPath, { from: "from_tree", to: "to_tree", files: [] })
        await Session.unrollback({ sessionID: session.id })
        await expect(Storage.read(cursorPath)).rejects.toBeInstanceOf(Storage.NotFoundError)
        expect(await visibleTexts(session.id)).toEqual(["first", "one", "second", "two"])

        const info = await Session.get(session.id)
        expect(info.history?.rollback?.messageID).not.toBe(u1.info.id)

        await Session.remove(session.id)
      },
    })
  })

  test("legacy rollback events use the first dropped message as the chronological cut", () => {
    const sessionID = "ses_legacy_rollback"
    const firstRootID = Identifier.ascending("message")
    const firstAssistantID = Identifier.ascending("message")
    const legacyRootID = `msg_${"f".repeat(26)}`
    const legacyAssistantID = Identifier.ascending("message")
    const messages = [
      rollbackUser(sessionID, firstRootID, 1),
      rollbackAssistant(sessionID, firstAssistantID, firstRootID, 2),
      rollbackUser(sessionID, legacyRootID, 3),
      rollbackAssistant(sessionID, legacyAssistantID, legacyRootID, 4),
    ]
    const event: SessionHistory.RollbackEvent = {
      id: Identifier.ascending("history"),
      sessionID,
      type: "rollback",
      time: { created: 5 },
      numTurns: 1,
      droppedMessageIDs: [legacyRootID, legacyAssistantID],
      droppedUserMessageIDs: [legacyRootID],
      files: [],
      patchPartIDs: [],
    }

    expect(SessionHistory.applyEvents(messages, [event]).map((message) => message.info.id)).toEqual([
      firstRootID,
      firstAssistantID,
    ])
  })

  test("new user input after rollback makes unrollback unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await writeTurn(session.id, tmp.path, "first", "one")
        await writeTurn(session.id, tmp.path, "second", "two")

        await Session.rollback({ sessionID: session.id, numTurns: 1 })
        await sleep(2)
        await writeUser(session.id, "replacement")

        let conflict: unknown
        try {
          await Session.unrollback({ sessionID: session.id })
        } catch (error) {
          conflict = error
        }
        expect(conflict).toBeInstanceOf(SessionHistory.UnrollbackConflictError)
        expect(await visibleTexts(session.id)).toEqual(["first", "one", "replacement"])
        expect((await Session.get(session.id)).history?.rollback?.canUnrollback).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("rollback prefix hides post-cut injections until a new root starts", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await writeTurn(session.id, tmp.path, "first", "one")
        await writeTurn(session.id, tmp.path, "second", "two")

        const rollback = (await Session.rollback({
          sessionID: session.id,
          numTurns: 1,
        })) as SessionHistory.RollbackEvent
        const injected = await writeUser(session.id, "steer after rollback", {
          isRoot: false,
          rootID: rollback.cutMessageID,
          origin: { type: "user" },
        })
        expect(await visibleTexts(session.id)).toEqual(["first", "one"])
        expect(await rawTexts(session.id)).toContain("steer after rollback")

        await sleep(2)
        await writeUser(session.id, "replacement")
        expect(await visibleTexts(session.id)).toEqual(["first", "one", "steer after rollback", "replacement"])
        expect((await Session.get(session.id)).history?.rollback?.canUnrollback).toBe(false)
        expect(injected.info.rootID).toBe(rollback.cutMessageID)

        await Session.remove(session.id)
      },
    })
  })

  test("cutMessageID rollback starts at a chronological legacy-id message", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await writeTurn(session.id, tmp.path, "first", "one")
        await sleep(2)
        const legacyRootID = `msg_${"0".repeat(26)}`
        await writeUser(session.id, "legacy second", {
          id: legacyRootID,
          isRoot: true,
          rootID: legacyRootID,
        })
        await sleep(2)
        await writeAssistant(session.id, tmp.path, legacyRootID, "legacy reply")

        const rollback = (await Session.rollback({
          sessionID: session.id,
          cutMessageID: legacyRootID,
        })) as SessionHistory.RollbackEvent

        expect(rollback.droppedMessageIDs).toHaveLength(2)
        expect(await visibleTexts(session.id)).toEqual(["first", "one"])

        await Session.remove(session.id)
      },
    })
  })

  test("file restore is explicit and scoped to selected patch files", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const fileA = path.join(tmp.path, "a.txt")
        const fileB = path.join(tmp.path, "b.txt")
        await Bun.write(fileA, "before-a")
        await Bun.write(fileB, "before-b")
        await $`git add a.txt b.txt`.cwd(tmp.path).quiet()
        await $`git commit -m baseline`.cwd(tmp.path).quiet()

        const session = await Session.create({})
        const snapshot = await Snapshot.track(session.id)
        expect(snapshot).toBeDefined()

        const user = await writeUser(session.id, "change files")
        await Bun.write(fileA, "after-a")
        await Bun.write(fileB, "after-b")
        const patch = await Snapshot.patch(snapshot!, session.id)
        await writeAssistant(session.id, tmp.path, user.info.id, "changed", [
          {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: "",
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          },
        ])

        const rollback = (await Session.rollback({
          sessionID: session.id,
          numTurns: 1,
        })) as SessionHistory.RollbackEvent
        expect(await Bun.file(fileA).text()).toBe("after-a")
        expect(await Bun.file(fileB).text()).toBe("after-b")

        const restored = await Session.restoreFiles({
          sessionID: session.id,
          rollbackID: rollback.id,
          files: [fileA],
        })
        expect(restored.restoredFiles.map((file) => path.normalize(file))).toEqual([path.normalize(fileA)])
        expect(await Bun.file(fileA).text()).toBe("before-a")
        expect(await Bun.file(fileB).text()).toBe("after-b")

        let missing: unknown
        try {
          await Session.restoreFiles({
            sessionID: session.id,
            rollbackID: Identifier.ascending("history"),
          })
        } catch (error) {
          missing = error
        }
        expect(missing).toBeInstanceOf(SessionHistory.FileRestoreMissingPatchDataError)

        await Session.remove(session.id)
      },
    })
  })

  test("fork records lineage and copies only effective history", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Source" })
        const [u1] = await writeTurn(session.id, tmp.path, "first", "one")
        const [u2] = await writeTurn(session.id, tmp.path, "second", "two")
        await Session.rollback({ sessionID: session.id, numTurns: 1 })

        const currentFork = await Session.fork({ sessionID: session.id })
        expect(currentFork.forkedFrom?.sessionID).toBe(session.id)
        expect(currentFork.forkedFrom?.title).toBe("Source")
        expect(currentFork.forkedFrom?.messageID).toBeUndefined()
        expect(currentFork.parentID).toBeUndefined()
        expect(await visibleTexts(currentFork.id)).toEqual(["first", "one"])

        const beforeFork = await Session.fork({
          sessionID: session.id,
          position: {
            type: "before",
            messageID: u2.info.id,
          },
        })
        expect(beforeFork.forkedFrom?.messageID).toBe(u2.info.id)
        expect(await visibleTexts(beforeFork.id)).toEqual(["first", "one"])
        const assistant = (await Session.messages({ sessionID: beforeFork.id })).find(
          (msg) => msg.info.role === "assistant",
        )
        expect((assistant?.info as MessageV2.Assistant).parentID).not.toBe(u1.info.id)

        await Session.remove(session.id)
        await Session.remove(currentFork.id)
        await Session.remove(beforeFork.id)
      },
    })
  })
  test("fork before a chronological legacy-id message copies the preceding history", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Legacy source" })
        await writeTurn(session.id, tmp.path, "first", "one")
        await sleep(2)
        const legacyRootID = `msg_${"0".repeat(26)}`
        await writeUser(session.id, "legacy second", {
          id: legacyRootID,
          isRoot: true,
          rootID: legacyRootID,
        })
        await sleep(2)
        await writeAssistant(session.id, tmp.path, legacyRootID, "legacy reply")

        const forked = await Session.fork({
          sessionID: session.id,
          position: { type: "before", messageID: legacyRootID },
        })

        expect(await visibleTexts(forked.id)).toEqual(["first", "one"])

        await Session.remove(session.id)
        await Session.remove(forked.id)
      },
    })
  })
})

async function writeTurn(sessionID: string, cwd: string, userText: string, assistantText: string) {
  const user = await writeUser(sessionID, userText)
  const assistant = await writeAssistant(sessionID, cwd, user.info.id, assistantText)
  return [user, assistant] as const
}

async function writeUser(sessionID: string, text: string, extra: Partial<MessageV2.User> = {}) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    agent: "default",
    model: {
      providerID: "openai",
      modelID: "gpt-4",
    },
    time: {
      created: Date.now(),
    },
    ...extra,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
  })
  return { info, parts: await MessageV2.parts({ sessionID, messageID: info.id }) }
}

async function writeAssistant(
  sessionID: string,
  cwd: string,
  parentID: string,
  text: string,
  extraParts: MessageV2.Part[] = [],
) {
  const info = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    mode: "default",
    agent: "default",
    path: {
      cwd,
      root: cwd,
    },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "gpt-4",
    providerID: "openai",
    parentID,
    time: {
      created: Date.now(),
    },
    finish: "end_turn",
  } satisfies MessageV2.Assistant)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: info.id,
    sessionID,
    type: "text",
    text,
  })
  for (const part of extraParts) {
    await Session.updatePart({
      ...part,
      messageID: info.id,
      sessionID,
    })
  }
  return { info, parts: await MessageV2.parts({ sessionID, messageID: info.id }) }
}

function rollbackUser(sessionID: string, id: string, created: number): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent: "default",
      model: { providerID: "openai", modelID: "gpt-4" },
      isRoot: true,
      rootID: id,
      time: { created },
    },
    parts: [],
  }
}

function rollbackAssistant(sessionID: string, id: string, rootID: string, created: number): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      mode: "default",
      agent: "default",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "gpt-4",
      providerID: "openai",
      parentID: rootID,
      rootID,
      time: { created, completed: created },
      finish: "end_turn",
    },
    parts: [],
  }
}

async function visibleTexts(sessionID: string) {
  return texts(await Session.messages({ sessionID }))
}

async function rawTexts(sessionID: string) {
  return texts(await Session.messages({ sessionID, raw: true }))
}

function texts(messages: MessageV2.WithParts[]) {
  return messages.flatMap((msg) => msg.parts.filter((part) => part.type === "text").map((part) => part.text))
}
