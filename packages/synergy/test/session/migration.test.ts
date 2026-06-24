import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Identifier } from "../../src/id/id"
import { migrations } from "../../src/session/migration"

const projectRoot = path.join(__dirname, "../..")

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

async function addTerminalAssistantMessage(sessionID: string, parentID: string) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: projectRoot, root: projectRoot },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
}

describe("session migrations", () => {
  test("repairs stale pendingReply flags without clearing genuinely pending sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const completed = await Session.create({})
        const completedUser = await addUserMessage(completed.id)
        await addTerminalAssistantMessage(completed.id, completedUser.id)
        await Session.update(completed.id, (draft) => {
          draft.pendingReply = true
        })

        const pending = await Session.create({})
        await addUserMessage(pending.id)
        await Session.update(pending.id, (draft) => {
          draft.pendingReply = true
        })

        const migration = migrations.find((entry) => entry.id === "20260619-session-repair-stale-pending-reply")
        expect(migration).toBeDefined()
        await migration!.up(() => {})

        const completedAfter = await SessionManager.getSession(completed.id)
        const pendingAfter = await SessionManager.getSession(pending.id)

        expect(completedAfter?.pendingReply).toBeUndefined()
        expect(pendingAfter?.pendingReply).toBe(true)
      },
    })
  })
})
