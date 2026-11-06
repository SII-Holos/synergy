import { afterAll, expect, spyOn, test } from "bun:test"
import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { submitInput } from "../../src/session-api"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function fixture(fn: (sessionID: string) => Promise<void>) {
  await runtime.run(async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "fixture/test",
        default_agent: TEST_AGENT_NAME,
        agent: { [TEST_AGENT_NAME]: { mode: "primary" } },
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
            models: { test: { name: "Test", limit: { context: 128000, output: 4096 } } },
          },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        using scheduler = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
        const session = await Session.create({})
        try {
          await fn(session.id)
        } finally {
          await SessionManager.drain()
        }
      },
    })
  })
}

async function root(sessionID: string, completed: boolean) {
  const item = await SessionInbox.enqueueUser({ sessionID, parts: [{ type: "text", text: "Earlier request" }] })
  expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
  if (completed) {
    const cwd = ScopeContext.current.directory
    await Session.updateMessage({
      id: Identifier.ascending("message"),
      sessionID,
      role: "assistant",
      parentID: item.messageID,
      rootID: item.messageID,
      agent: TEST_AGENT_NAME,
      mode: TEST_AGENT_NAME,
      providerID: "fixture",
      modelID: "test",
      path: { cwd, root: cwd },
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  }
  return item.messageID
}

for (const paused of [false, true])
  for (const retained of [false, true])
    test(`input after rollback creates one new root (paused=${paused}, retained=${retained})`, () =>
      fixture(async (sessionID) => {
        const previous = retained ? await root(sessionID, true) : undefined
        const owner = RolloutLifecycle.owner(await Session.get(sessionID))
        if (previous) {
          await RolloutLifecycle.configuration(await Session.get(sessionID), previous)
          await RolloutLedger.finishRun(owner, previous, "cancelled")
        }
        const cut = await root(sessionID, false)
        if (paused) await SessionLifecycle.pause({ sessionID, reason: "aborted" })
        await SessionHistory.rollback({ sessionID, cutMessageID: cut })
        const input = await submitInput({ sessionID, parts: [{ type: "text", text: "New request after rollback" }] })
        if (input.status !== "queued") throw new Error("Expected durable queued input")
        expect(input.item.mode).toBe("task")
        expect(input.runID).toBeUndefined()
        if (previous) expect((await RolloutLedger.getRun(owner, previous)).status).toBe("cancelled")
        expect(await SessionLifecycle.snapshot(sessionID)).toBeUndefined()
        expect(await SessionInbox.materializeNextTask(sessionID)).toMatchObject({
          status: "materialized",
          messageID: input.item.messageID,
        })
        expect((await MessageV2.get({ sessionID, messageID: input.item.messageID })).info).toMatchObject({
          role: "user",
          isRoot: true,
        })
        expect(await SessionInbox.list(sessionID)).toHaveLength(0)
        expect((await SessionHistory.storedInfo(sessionID))?.rollback?.canUnrollback).toBe(false)
        expect(await SessionInbox.materializeNextTask(sessionID)).toEqual({ status: "empty" })
      }))

test("retained steer during rollback is not repeatedly awakened and remains available after redo", () =>
  fixture(async (sessionID) => {
    await root(sessionID, true)
    const cut = await root(sessionID, false)
    await SessionHistory.rollback({ sessionID, cutMessageID: cut })
    const input = await SessionInbox.enqueueUser(
      { sessionID, parts: [{ type: "text", text: "Retained direction" }] },
      { mode: "steer" },
    )
    using loop = spyOn(SessionInvoke, "loop").mockRejectedValue(new Error("Frozen queue must not start a loop"))
    expect(await SessionInbox.hasRunnableItem(sessionID)).toBe(false)
    for (let pass = 0; pass < 3; pass++) {
      expect(await SessionDrive.request(sessionID, "release")).toBe(false)
      await SessionManager.wake(sessionID)
    }
    expect(loop).not.toHaveBeenCalled()
    expect((await SessionInbox.list(sessionID)).map((item) => item.id)).toEqual([input.id])
    const rollback = (await SessionHistory.storedInfo(sessionID))?.rollback
    expect(rollback?.canUnrollback).toBe(true)
    await SessionHistory.unrollback({ sessionID, rollbackID: rollback!.id })
    expect(await SessionInbox.hasRunnableItem(sessionID)).toBe(true)
  }))
