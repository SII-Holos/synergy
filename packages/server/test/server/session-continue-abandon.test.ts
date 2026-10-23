import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
let failingSessionID: string | undefined
const runtime = await testRuntime(undefined, () =>
  SessionExecutionContributions.register({
    id: "abandon-failure-test",
    abandonWorkflow: async (owner) => {
      if (owner.id === failingSessionID) throw new Error("Cancellation unavailable")
      return false
    },
  }),
)
import { describe, expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Server } from "../../src/server/server"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

runtime.run(() => Log.init({ print: false }))

/** A reply-required root with no terminal assistant: the persisted shape of a
 *  turn that stopped mid-work, which is what abandon exists to finish off. */
async function createInterruptedTurn(sessionID: string) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    isRoot: true,
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
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

describe("POST /session/:sessionID/continue", () => {
  test("rejects a retained task with an absent owner before clearing its pause", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ title: "Retained owner task" })
          const key = ["sessions", session.scope.id, session.id, "info"]
          const workflow = { kind: "lattice", runID: "retained-run", mode: "auto" }
          await Storage.write(key, { ...session, workflow })
          await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          const pause = await SessionLifecycle.snapshot(session.id)
          const response = await Server.App().request(`/session/${session.id}/continue`, { method: "POST" })
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({
            name: "SessionExecutionOwnerUnavailableError",
            data: { sessionID: session.id },
          })
          const input = await Server.App().request(`/session/${session.id}/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              metadata: { source: "agenda" },
              parts: [{ type: "text", text: "Retained owner instruction" }],
            }),
          })
          expect(input.status).toBe(409)
          expect(await input.json()).toMatchObject({ name: "SessionExecutionOwnerUnavailableError" })
          expect(await SessionLifecycle.snapshot(session.id)).toEqual(pause)
          expect((await Storage.read<Record<string, unknown>>(key)).workflow).toEqual(workflow)
        },
      })
    }))

  test("reports an empty paused session as blocked without clearing its pause", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Continue me" })
          expect(await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })).toBe(true)
          expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()

          const response = await Server.App().request(`/session/${session.id}/continue`, { method: "POST" })

          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({
            handled: false,
            outcome: "blocked",
            status: { type: "paused" },
          })
          expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()
        },
      })
    }))

  test("is legal on a session that was never paused", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Never paused" })

          const response = await Server.App().request(`/session/${session.id}/continue`, { method: "POST" })

          expect(response.status).toBe(200)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        },
      })
    }))
})

describe("POST /session/:sessionID/abandon", () => {
  test("reports cancellation failure, retains the pause and permits an explicit retry", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await createInterruptedTurn(session.id)
          failingSessionID = session.id
          try {
            const response = await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })
            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({ name: "SessionAbandonError" })
            expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()
          } finally {
            failingSessionID = undefined
          }
          const retry = await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })
          expect(retry.status).toBe(200)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        },
      })
    }))
  test("cancels queued work even when the paused execution has already exited", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await createInterruptedTurn(session.id)
          await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
          const queued = await SessionInbox.enqueueUser({
            sessionID: session.id,
            parts: [{ type: "text", text: "Queued task" }],
          })
          const response = await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })
          expect(response.status).toBe(200)
          expect(await SessionInbox.list(session.id)).toEqual([])
          expect((await RolloutLedger.getRun(RolloutLifecycle.owner(session), queued.messageID)).status).toBe(
            "cancelled",
          )
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        },
      })
    }))
  test("retains the pause when an abort hook fails", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const unregister = SessionAbort.registerHook((sessionID) => {
            if (sessionID === session.id) throw new Error("Cancellation hook unavailable")
          })
          try {
            const response = await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })
            expect(response.status).toBe(409)
            expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()
          } finally {
            unregister()
          }
          const retry = await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })
          expect(retry.status).toBe(200)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        },
      })
    }))
  test.each([false, true])("terminalizes the interrupted turn and leaves the session resting (paused=%s)", (paused) =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Abandon me" })
          await createInterruptedTurn(session.id)
          if (paused) await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
          const statuses: string[] = []
          const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
            if (event.properties.sessionID === session.id) statuses.push(event.properties.status.type)
          })
          const response = await Promise.resolve(
            Server.App().request(`/session/${session.id}/abandon`, { method: "POST" }),
          ).finally(unsubscribe)

          expect(response.status).toBe(200)
          const body = (await response.json()) as { repaired: boolean; paused: boolean; abandoned: boolean }
          expect(body.repaired).toBe(true)
          expect(body.paused).toBe(false)
          expect(statuses.at(-1)).toBe("idle")
          expect(typeof body.abandoned).toBe("boolean")
          // The route clears the latch in the same call, so the session rests
          // rather than staying paused on work the user just gave up on.
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()

          const messages = await SessionHistory.modelMessages({ sessionID: session.id })
          const assistant = messages
            .map((message) => message.info)
            .findLast((info): info is MessageV2.Assistant => info.role === "assistant")
          expect(assistant).toBeDefined()
          expect(assistant!.finish).toBe("error")
        },
      })
    }),
  )

  test("is idempotent and reports honestly on a repeat call", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Already abandoned" })
          await createInterruptedTurn(session.id)

          await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })
          const repeated = await Server.App().request(`/session/${session.id}/abandon`, { method: "POST" })

          expect(repeated.status).toBe(200)
          const body = (await repeated.json()) as { repaired: boolean }
          // Nothing was left to terminalize, and the route says so instead of
          // failing or claiming a change it did not make.
          expect(body.repaired).toBe(false)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
