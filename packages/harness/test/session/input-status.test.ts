import { afterAll, expect, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInputStatus } from "../../src/session/input-status"
import { SessionInputProgress } from "../../src/session/input-progress"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("scheduling failures belong only to the input that failed", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const bad = await SessionInbox.enqueueUser({ sessionID: session.id, parts: [{ type: "text", text: "bad" }] })
        const good = await SessionInbox.enqueueUser({ sessionID: session.id, parts: [{ type: "text", text: "good" }] })
        const failure = new Error("scheduler unavailable")
        SessionInputProgress.schedulingFailure(session.id, failure, false, { messageID: bad.messageID, itemID: bad.id })
        expect(await SessionInputStatus.get({ sessionID: session.id, messageID: bad.messageID })).toMatchObject({
          state: "retrying",
        })
        expect(await SessionInputStatus.get({ sessionID: session.id, messageID: good.messageID })).toMatchObject({
          state: "accepted",
        })
        expect(
          SessionInputProgress.schedulingFailure(session.id, new Error("unrelated loop error"), true),
        ).toBeUndefined()
        await expect(
          SessionInputProgress.run({ sessionID: session.id, messageID: bad.messageID, itemID: bad.id }, async () => {
            throw failure
          }),
        ).rejects.toBe(failure)
        expect(SessionInputProgress.schedulingFailure(session.id, failure, true)).toEqual({
          messageID: bad.messageID,
          itemID: bad.id,
        })
        expect(await SessionInputStatus.get({ sessionID: session.id, messageID: bad.messageID })).toMatchObject({
          state: "failed",
        })
        expect(await SessionInputStatus.get({ sessionID: session.id, messageID: good.messageID })).toMatchObject({
          state: "accepted",
        })
      },
    })
  }))

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
