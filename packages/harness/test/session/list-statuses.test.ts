import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionLifecycle } from "../../src/session/lifecycle"

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

/** A session stopped mid-work. The persisted pause latch is the evidence the
 *  cross-scope recovery scan reports, so the fixture returns the latch it
 *  wrote and assertions can pin the exact derived status. */
async function createPausedSession(title: string) {
  const session = await Session.create({ title })
  await createIncompleteAssistant(session.id)
  await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
  const paused = await SessionLifecycle.snapshot(session.id)
  if (!paused) throw new Error("expected a pause latch")
  return { session, paused }
}

describe("SessionManager.listStatuses without a scope", () => {
  test("merges recoverable statuses from every scope and keeps runtime status precedence", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = await tmp.scope()

    let pausedID = ""
    let pausedSince = 0
    let runningID = ""

    await ScopeContext.provide({
      scope: project,
      fn: async () => {
        const paused = await createPausedSession("Paused")
        pausedID = paused.session.id
        pausedSince = paused.paused.since
        // A latch alone is not a discriminating fixture for merge precedence,
        // because only the scan reports it. Giving this session a live runtime
        // status too means the same session is visible to both sources, so only
        // a runtime-first merge keeps the busy state.
        const running = await createPausedSession("Running")
        runningID = running.session.id
        SessionManager.setStatus(runningID, { type: "busy", description: "working" })
      },
    })

    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const global = await SessionManager.listStatuses()
          expect(global[pausedID]).toEqual({ type: "paused", reason: "aborted", since: pausedSince })
          expect(global[runningID]).toEqual({ type: "busy", description: "working" })

          const otherScope = await SessionManager.listStatuses(project.id)
          expect(otherScope[pausedID]).toEqual({ type: "paused", reason: "aborted", since: pausedSince })
          expect(otherScope[runningID]).toEqual({ type: "busy", description: "working" })
        },
      })
    } finally {
      SessionManager.unregisterRuntime(pausedID)
      SessionManager.unregisterRuntime(runningID)
      await Session.remove(pausedID)
      await Session.remove(runningID)
    }
  })

  test("still scopes the result when a scope is requested", async () => {
    await using tmp = await tmpdir({ git: true })
    const project = await tmp.scope()

    let sessionID = ""
    let pausedSince = 0

    await ScopeContext.provide({
      scope: project,
      fn: async () => {
        const paused = await createPausedSession("Project only")
        sessionID = paused.session.id
        pausedSince = paused.paused.since
      },
    })

    try {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          expect((await SessionManager.listStatuses("home"))[sessionID]).toBeUndefined()
          expect((await SessionManager.listStatuses())[sessionID]).toEqual({
            type: "paused",
            reason: "aborted",
            since: pausedSince,
          })
        },
      })
    } finally {
      SessionManager.unregisterRuntime(sessionID)
      await Session.remove(sessionID)
    }
  })
})
