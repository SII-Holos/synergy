import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"

async function createIncompleteAssistant(sessionID: string) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

async function createRecoverableSession(title: string) {
  const session = await Session.create({ title })
  await createIncompleteAssistant(session.id)
  await Session.update(session.id, (draft) => {
    draft.pendingReply = true
  })
  return session
}

describe("SessionManager.listStatuses without a scope", () => {
  test("merges recoverable statuses from every scope and keeps runtime status precedence", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = await tmp.scope()

    let recoveredID = ""
    let runningID = ""

    await ScopeContext.provide({
      scope: project,
      fn: async () => {
        recoveredID = (await createRecoverableSession("Recoverable")).id
        runningID = (await createRecoverableSession("Running")).id
        // A status set without a loop owner is the discriminating case for the
        // merge precedence: the recovery scan also reports this session, so only
        // a runtime-first merge keeps the busy state.
        SessionManager.setStatus(runningID, { type: "busy", description: "working" })
      },
    })

    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const global = await SessionManager.listStatuses()
          expect(global[recoveredID]).toEqual({ type: "recovering", reason: "incomplete-turn" })
          expect(global[runningID]).toEqual({ type: "busy", description: "working" })

          const otherScope = await SessionManager.listStatuses(project.id)
          expect(otherScope[recoveredID]).toEqual({ type: "recovering", reason: "incomplete-turn" })
          expect(otherScope[runningID]).toEqual({ type: "busy", description: "working" })
        },
      })
    } finally {
      SessionManager.unregisterRuntime(recoveredID)
      SessionManager.unregisterRuntime(runningID)
      await Session.remove(recoveredID)
      await Session.remove(runningID)
    }
  })

  test("still scopes the result when a scope is requested", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = await tmp.scope()

    let sessionID = ""

    await ScopeContext.provide({
      scope: project,
      fn: async () => {
        sessionID = (await createRecoverableSession("Project only")).id
      },
    })

    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          expect((await SessionManager.listStatuses("home"))[sessionID]).toBeUndefined()
          expect((await SessionManager.listStatuses())[sessionID]).toEqual({
            type: "recovering",
            reason: "incomplete-turn",
          })
        },
      })
    } finally {
      SessionManager.unregisterRuntime(sessionID)
      await Session.remove(sessionID)
    }
  })
})
