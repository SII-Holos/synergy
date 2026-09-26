import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { Server } from "../../src/server/server"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

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

/** A session stopped mid-work: the pause latch is what the cross-scope status
 *  scan reports, so the fixture returns it for exact-status assertions. */
async function createPausedSession(title: string) {
  const session = await Session.create({ title })
  await createIncompleteAssistant(session.id)
  await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
  const paused = await SessionLifecycle.snapshot(session.id)
  if (!paused) throw new Error("expected a pause latch")
  return { session, paused }
}

describe("GET /global/session/status", () => {
  test("returns runtime statuses from more than one scope in one response", () =>
    runtime.run(async () => {
      await using tmpA = await tmpdir({ git: true })
      await using tmpB = await tmpdir({ git: true })
      const scopeA = await tmpA.scope()
      const scopeB = await tmpB.scope()

      let busyID = ""
      let pausedID = ""
      let pausedSince = 0

      await ScopeContext.provide({
        scope: scopeA,
        fn: async () => {
          busyID = (await createPausedSession("Busy in scope A")).session.id
          SessionManager.setStatus(busyID, { type: "busy", description: "working" })
        },
      })
      await ScopeContext.provide({
        scope: scopeB,
        fn: async () => {
          const paused = await createPausedSession("Paused in scope B")
          pausedID = paused.session.id
          pausedSince = paused.paused.since
        },
      })

      try {
        await ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const res = await Server.App().request("/global/session/status")
            expect(res.status).toBe(200)
            const body = (await res.json()) as Record<string, unknown>

            expect(body[busyID]).toEqual({ type: "busy", description: "working" })
            // The cause travels with the status so a client can explain why the
            // session is stopped instead of showing one opaque state.
            expect(body[pausedID]).toEqual({ type: "paused", reason: "aborted", since: pausedSince })
            expect(res.headers.get("x-synergy-seq")).toMatch(/^\d+$/)
          },
        })
      } finally {
        SessionManager.unregisterRuntime(busyID)
        SessionManager.unregisterRuntime(pausedID)
        await Session.remove(busyID)
        await Session.remove(pausedID)
      }
    }))

  test("publishes the cross-scope status operation in the OpenAPI document", () =>
    runtime.run(async () => {
      const spec = await Server.openapi()
      const operation = spec.paths["/global/session/status"]
      expect(operation).toBeDefined()
      expect(operation!.get).toBeDefined()
      // The name deliberately avoids `global.session.status`: the SDK generator
      // keys a generated method by the operationId with a leading `global.`
      // stripped, so that name would resolve to the same method as the scoped
      // `session.status`, and the generator would silently drop or retarget the
      // scoped method rather than fail.
      expect(operation!.get!.operationId).toBe("global.session.statuses")
    }))
})

afterRuntimeTests(() => runtime.close())
