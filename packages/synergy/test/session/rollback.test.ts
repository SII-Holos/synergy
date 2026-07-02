import { $, sleep } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionHistory } from "../../src/session/history"
import { Snapshot } from "../../src/session/snapshot"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("session rollback history", () => {
  test("rollback hides effective turns without deleting raw messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const [u1] = await writeTurn(session.id, tmp.path, "first", "one")
        await writeTurn(session.id, tmp.path, "second", "two")
        await writeTurn(session.id, tmp.path, "third", "three")

        const firstRollback = (await Session.rollback({
          sessionID: session.id,
          numTurns: 1,
        })) as SessionHistory.RollbackEvent
        expect(firstRollback.droppedUserMessageIDs).toHaveLength(1)
        expect(await visibleTexts(session.id)).toEqual(["first", "one", "second", "two"])
        expect(await rawTexts(session.id)).toEqual(["first", "one", "second", "two", "third", "three"])

        await Session.rollback({ sessionID: session.id, numTurns: 1 })
        expect(await visibleTexts(session.id)).toEqual(["first", "one"])

        await Session.unrollback({ sessionID: session.id })
        expect(await visibleTexts(session.id)).toEqual(["first", "one", "second", "two"])

        const info = await Session.get(session.id)
        expect(info.history?.rollback?.messageID).not.toBe(u1.info.id)

        await Session.remove(session.id)
      },
    })
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
})

async function writeTurn(sessionID: string, cwd: string, userText: string, assistantText: string) {
  const user = await writeUser(sessionID, userText)
  const assistant = await writeAssistant(sessionID, cwd, user.info.id, assistantText)
  return [user, assistant] as const
}

async function writeUser(sessionID: string, text: string) {
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

async function visibleTexts(sessionID: string) {
  return texts(await Session.messages({ sessionID }))
}

async function rawTexts(sessionID: string) {
  return texts(await Session.messages({ sessionID, raw: true }))
}

function texts(messages: MessageV2.WithParts[]) {
  return messages.flatMap((msg) => msg.parts.filter((part) => part.type === "text").map((part) => part.text))
}
