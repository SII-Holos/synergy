import { afterAll, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInputStatus } from "../../src/session/input-status"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("input status projects durable admission, canonical materialization and terminal execution", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "one turn" }],
        })
        const identity = { sessionID: session.id, messageID: item.messageID }
        expect(await SessionInputStatus.get(identity)).toMatchObject({
          state: "accepted",
          durable: true,
          canonical: false,
          itemID: item.id,
        })
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        expect(await SessionInputStatus.get(identity)).toMatchObject({
          state: "failed",
          durable: true,
          canonical: false,
          error: { code: "SessionPaused" },
        })
        await SessionLifecycle.clear(session.id)
        await SessionInbox.materializeNextTask(session.id)
        expect(await SessionInputStatus.get(identity)).toMatchObject({
          state: "preparing",
          durable: true,
          canonical: true,
        })
        const segment = await RolloutLedger.beginSegment({
          owner: RolloutLifecycle.owner(session),
          runID: item.messageID,
          input: {},
        })
        await RolloutLedger.finishSegment(segment, "completed")
        expect(await SessionInputStatus.get(identity)).toMatchObject({ state: "running", canonical: true })
        await RolloutLedger.finishRun(RolloutLifecycle.owner(session), item.messageID, "completed")
        expect(await SessionInputStatus.get(identity)).toMatchObject({ state: "completed", canonical: true })
      },
    })
  }))

test("cancelled admission is recoverable without an inbox item or a canonical message", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          parts: [{ type: "text", text: "cancel" }],
        })
        await RolloutLifecycle.cancel(session.id, item.messageID)
        expect(await SessionInputStatus.get({ sessionID: session.id, messageID: item.messageID })).toMatchObject({
          state: "cancelled",
          durable: true,
          canonical: false,
        })
      },
    })
  }))
