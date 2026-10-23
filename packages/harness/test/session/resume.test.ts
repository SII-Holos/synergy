import { afterAll, expect, spyOn, test } from "bun:test"
import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionHistory } from "../../src/session/history"
import { SessionProgress } from "../../src/session/progress"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { SessionResume } from "../../src/session/resume"
import { SessionAbort } from "../../src/session/abort"
const resumeSession = SessionResume.request
import { Bus } from "../../src/bus"
import { SessionEvent } from "../../src/session/event"
import { SessionRecovery } from "../../src/session/recovery"
import { SessionInvoke } from "../../src/session/invoke"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

async function failedSession() {
  const session = await Session.create({})
  const item = await SessionInbox.enqueueUser({
    sessionID: session.id,
    agent: TEST_AGENT_NAME,
    parts: [{ type: "text", text: "Complete the original task" }],
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
    providerID: "fixture",
    modelID: "test",
    path: { cwd, root: cwd },
    time: { created: Date.now(), completed: Date.now() },
    finish: "error",
    error: {
      name: "UnknownError",
      data: {
        message:
          "ProviderRecoveryTimeoutError: Provider recovery did not complete within the waiting limit. Try again later.",
      },
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await SessionLifecycle.pause({ sessionID: session.id, reason: "failed" })
  return {
    session,
    owner,
    rootID: item.messageID,
    messageID,
    pausedSince: (await Session.get(session.id)).paused!.since,
  }
}

const fixtureConfig = {
  model: "fixture/test",
  default_agent: TEST_AGENT_NAME,
  agent: { [TEST_AGENT_NAME]: { mode: "primary" as const } },
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { apiKey: "fixture", baseURL: "http://127.0.0.1:1/v1" },
      models: { test: { name: "Test", limit: { context: 128000, output: 4096 } } },
    },
  },
}

async function fixture(fn: () => Promise<void>) {
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true, config: fixtureConfig })
    await ScopeContext.provide({ scope: await tmp.scope(), fn })
  })
}

test("Continue admits one attempt after provider recovery timed out without erasing the failure", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, owner, rootID, messageID } = await failedSession()
    await Promise.all([resumeSession({ sessionID: session.id }), resumeSession({ sessionID: session.id })])
    const queued = await SessionInbox.peekSteer(session.id)
    expect(queued).toHaveLength(1)
    expect((await Session.get(session.id)).paused).toBeUndefined()
    expect((await MessageV2.get({ sessionID: session.id, messageID })).info).toMatchObject({ finish: "error" })
    expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("running")
    await SessionInbox.materializeItem(queued[0]!, rootID, { guiding: true })
    const messages = await SessionHistory.modelMessages({ sessionID: session.id })
    expect(messages.filter((message) => message.info.role === "user" && message.info.isRoot)).toHaveLength(1)
    expect(SessionProgress.needsModelCall(messages, rootID)).toBe(true)
    expect((await Session.get(session.id)).resume?.state).toBe("consumed")
  }))

test("duplicate and lost-response retries share a receipt; refresh agrees with committed status events", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, pausedSince } = await failedSession()
    const statuses: Array<Parameters<typeof SessionManager.publishStatusOnly>[1]> = []
    const unsubscribe = Bus.subscribe(SessionEvent.Status, (event) => {
      if (event.properties.sessionID === session.id) statuses.push(event.properties.status)
    })
    try {
      const request = { sessionID: session.id, requestID: "recovery-click", pausedSince }
      const [first, second] = await Promise.all([resumeSession(request), resumeSession(request)])
      expect(first.outcome).toBe("accepted")
      expect(second.outcome).toBe("already_accepted")
      expect(second.receipt).toEqual(first.receipt)
      expect(schedule).toHaveBeenCalledTimes(1)
      expect((await Session.get(session.id)).resume).toEqual(first.receipt)
      expect((await SessionRecovery.recoverableStatuses(session.scope.id))[session.id]).toEqual(first.status)
      expect(statuses.at(-1)).toEqual(first.status)
      expect(first.status).toMatchObject({ type: "busy", activity: { phase: "queued_agent" } })
      expect((await Session.get(session.id)).working?.status).toBe("busy")
      expect(await SessionInbox.peekSteer(session.id)).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  }))

test("failed admission rolls back pause, receipt, queue, status publication and run reopening together", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, owner, rootID, pausedSince } = await failedSession()
    {
      using publish = spyOn(SessionManager, "publishStatusOnly").mockRejectedValue(new Error("admission failure"))
      await expect(resumeSession({ sessionID: session.id, requestID: "rollback" })).rejects.toThrow()
    }
    expect((await Session.get(session.id)).paused?.since).toBe(pausedSince)
    expect((await Session.get(session.id)).resume).toBeUndefined()
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
    expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("failed")
    expect(schedule).not.toHaveBeenCalled()
    expect((await resumeSession({ sessionID: session.id, requestID: "rollback" })).outcome).toBe("accepted")
  }))

test("a delayed Continue cannot clear a newer pause, even after the original request was consumed", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, rootID, pausedSince } = await failedSession()
    const request = { sessionID: session.id, requestID: "old-click", pausedSince }
    await resumeSession(request)
    const [item] = await SessionInbox.peekSteer(session.id)
    await SessionInbox.materializeItem(item!, rootID, { guiding: true })
    await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
    const newer = (await Session.get(session.id)).paused!
    expect(newer.since).toBeGreaterThan(pausedSince)
    expect((await resumeSession(request)).outcome).toBe("already_accepted")
    expect((await resumeSession({ ...request, requestID: "another-old-click" })).outcome).toBe("already_accepted")
    expect((await Session.get(session.id)).paused).toEqual(newer)
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(
      (await resumeSession({ sessionID: session.id, requestID: "new-click", pausedSince: newer.since })).outcome,
    ).toBe("accepted")
  }))

test("a notification failure after commit cannot lose the admitted wake", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session } = await failedSession()
    const resumeRun = RolloutLedger.resumeRun
    {
      using notification = spyOn(RolloutLedger, "resumeRun").mockImplementation(async (...args) => {
        await resumeRun(...args)
        throw new Error("Post-commit notification failed")
      })
      await expect(resumeSession({ sessionID: session.id, requestID: "committed" })).rejects.toThrow()
    }
    expect((await Session.get(session.id)).paused).toBeUndefined()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect((await resumeSession({ sessionID: session.id, requestID: "committed" })).outcome).toBe("already_accepted")
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(1)
  }))

test("abandon cancels an admitted recovery request and never resurrects it on refresh", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session } = await failedSession()
    await resumeSession({ sessionID: session.id, requestID: "abandoned-click" })
    await SessionAbort.abort(session.id, { terminalize: true, abandonWorkflow: true, pauseReason: "aborted" })
    expect((await Session.get(session.id)).resume?.state).toBe("cancelled")
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
    expect((await SessionRecovery.recoverableStatuses(session.scope.id))[session.id]).toBeUndefined()
  }))

test("Continue releases a queued next task without reopening the completed predecessor", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, rootID, messageID, owner } = await failedSession()
    const failed = await MessageV2.get({ sessionID: session.id, messageID })
    if (failed.info.role !== "assistant") throw new Error("Expected assistant")
    await Session.updateMessage({ ...failed.info, error: undefined, finish: "stop" })
    await RolloutLedger.resumeRun(owner, rootID)
    await RolloutLedger.finishRun(owner, rootID, "completed")
    const next = await SessionInbox.enqueueUser(
      { sessionID: session.id, agent: TEST_AGENT_NAME, parts: [{ type: "text", text: "Next task" }] },
      { mode: "task" },
    )
    expect((await resumeSession({ sessionID: session.id, requestID: "next-task" })).outcome).toBe("accepted")
    expect((await Session.get(session.id)).resume?.messageID).toBe(next.messageID)
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
    expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("completed")
  }))

for (const phase of ["paused", "queued", "consumed"] as const) {
  test(`restart from ${phase} retains the task and permits exactly one explicit recovery`, async () => {
    await using home = await tmpdir()
    const first = await testRuntime({ home: home.path })
    let saved: Awaited<ReturnType<typeof failedSession>>
    let scope: typeof ScopeContext.current.scope
    await using repository = await first.run(() => tmpdir({ git: true, config: fixtureConfig }))
    try {
      await first.run(async () => {
        scope = await repository.scope()
        await ScopeContext.provide({
          scope,
          fn: async () => {
            using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
            saved = await failedSession()
            if (phase === "paused") return
            await resumeSession({ sessionID: saved.session.id, requestID: "before-restart" })
            if (phase === "consumed") {
              const [item] = await SessionInbox.peekSteer(saved.session.id)
              await SessionInbox.materializeItem(item!, saved.rootID, { guiding: true })
            }
          },
        })
      })
    } finally {
      await first.close()
    }
    await using reopened = await testRuntime({ home: home.path })
    await reopened.run(() =>
      ScopeContext.provide({
        scope,
        fn: async () => {
          using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
          await SessionInvoke.reconcilePausedSessions(saved.session.scope.id)
          const restored = await Session.get(saved.session.id)
          expect(restored.paused).toBeDefined()
          expect(restored.working?.status).toBe("paused")
          expect((await MessageV2.get({ sessionID: restored.id, messageID: saved.messageID })).info).toMatchObject({
            finish: "error",
          })
          expect(schedule).not.toHaveBeenCalled()
          const input = { sessionID: restored.id, requestID: "after-restart", pausedSince: restored.paused!.since }
          const [accepted, duplicate] = await Promise.all([resumeSession(input), resumeSession(input)])
          expect(accepted.outcome).toBe("accepted")
          expect(duplicate.outcome).toBe("already_accepted")
          expect(await SessionInbox.peekSteer(restored.id)).toHaveLength(1)
          expect(
            (await SessionHistory.modelMessages({ sessionID: restored.id })).filter(
              (msg) => msg.info.role === "user" && msg.info.isRoot,
            ),
          ).toHaveLength(1)
        },
      }),
    )
  })
}
