import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
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

async function createRecoverableSession(title: string) {
  const session = await Session.create({ title })
  await createIncompleteAssistant(session.id)
  await Session.update(session.id, (draft) => {
    draft.pendingReply = true
  })
  return session
}

describe("GET /global/session/status", () => {
  test("returns runtime statuses from more than one scope in one response", () =>
    runtime.run(async () => {
      await using tmpA = await tmpdir({ git: true })
      await using tmpB = await tmpdir({ git: true })
      const scopeA = await tmpA.scope()
      const scopeB = await tmpB.scope()

      let busyID = ""
      let recoveringID = ""

      await ScopeContext.provide({
        scope: scopeA,
        fn: async () => {
          busyID = (await createRecoverableSession("Busy in scope A")).id
          SessionManager.setStatus(busyID, { type: "busy", description: "working" })
        },
      })
      await ScopeContext.provide({
        scope: scopeB,
        fn: async () => {
          recoveringID = (await createRecoverableSession("Recovering in scope B")).id
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
            // session is recovering instead of showing one opaque state.
            expect(body[recoveringID]).toEqual({ type: "recovering", reason: "incomplete-turn" })
            expect(res.headers.get("x-synergy-seq")).toMatch(/^\d+$/)
          },
        })
      } finally {
        SessionManager.unregisterRuntime(busyID)
        SessionManager.unregisterRuntime(recoveringID)
        await Session.remove(busyID)
        await Session.remove(recoveringID)
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
