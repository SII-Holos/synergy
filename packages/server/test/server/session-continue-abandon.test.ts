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

Log.init({ print: false })

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
  test("clears the pause latch and reports the drive result", async () => {
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
        const body = (await response.json()) as { handled: boolean }
        expect(typeof body.handled).toBe("boolean")
        // The session is taking a user action, so the latch must not survive the
        // call — otherwise a later drive would keep refusing the resumed work.
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
      },
    })
  })

  test("is legal on a session that was never paused", async () => {
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
  })
})

describe("POST /session/:sessionID/abandon", () => {
  test.each([false, true])(
    "terminalizes the interrupted turn and leaves the session resting (paused=%s)",
    async (paused) => {
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
    },
  )

  test("is idempotent and reports honestly on a repeat call", async () => {
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
  })
})
