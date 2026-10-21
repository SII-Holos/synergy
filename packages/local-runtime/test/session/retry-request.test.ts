import { afterAll, expect, spyOn, test } from "bun:test"
import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { retrySessionRequest } from "../../src/session-api"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

for (const scenario of ["retryable", "invalid", "stopped", "stale"] as const) {
  test(`retry admission preserves the failed turn and rejects duplicate or invalid actions: ${scenario}`, () =>
    runtime.run(async () => {
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
          using wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
          const session = await Session.create({})
          const item = await SessionInbox.enqueueUser({
            sessionID: session.id,
            agent: TEST_AGENT_NAME,
            parts: [{ type: "text", text: "Continue the task" }],
          })
          await SessionInbox.materializeNextTask(session.id)
          const owner = RolloutLifecycle.owner(session)
          const segment = await RolloutLedger.beginSegment({ owner, runID: item.messageID, input: {} })
          await RolloutLedger.finishSegment(segment, "failed")
          await RolloutLedger.finishRun(owner, item.messageID, "failed")
          const messageID = Identifier.ascending("message")
          const cwd = ScopeContext.current.directory
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "assistant",
            parentID: item.messageID,
            rootID: item.messageID,
            agent: TEST_AGENT_NAME,
            mode: TEST_AGENT_NAME,
            providerID: "test",
            modelID: "test",
            path: { cwd, root: cwd },
            time: { created: Date.now(), completed: Date.now() },
            finish: "error",
            error: { name: "APIError", data: { message: "Unavailable", isRetryable: scenario !== "invalid" } },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          if (scenario === "stopped") await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
          const input = {
            sessionID: session.id,
            messageID: scenario === "stale" ? Identifier.ascending("message") : messageID,
          }
          const outcomes = await Promise.all([retrySessionRequest(input), retrySessionRequest(input)])
          expect(outcomes.map((result) => result.handled)).toEqual(
            scenario === "retryable" ? [true, false] : [false, false],
          )
          const queued = await SessionInbox.peekSteer(session.id)
          expect(queued).toHaveLength(scenario === "retryable" ? 1 : 0)
          expect((await MessageV2.get({ sessionID: session.id, messageID })).info).toMatchObject({ finish: "error" })
          if (queued[0]) {
            expect((await RolloutLedger.getRun(owner, item.messageID)).status).toBe("running")
            await SessionInbox.materializeItem(queued[0], item.messageID, { guiding: true })
            const messages = await SessionHistory.modelMessages({ sessionID: session.id })
            expect(messages.filter((message) => message.info.role === "user" && message.info.isRoot)).toHaveLength(1)
            expect(SessionProgress.needsModelCall(messages, item.messageID)).toBe(true)
            expect(messages.at(-1)?.info).toMatchObject({ rootID: item.messageID, visible: false })
          }
        },
      })
    }))
}
