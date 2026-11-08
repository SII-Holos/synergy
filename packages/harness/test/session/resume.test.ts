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
import { Storage } from "../../src/storage/storage"
import { Lock } from "../../src/util/lock"
import type { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"

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

test("trusted Continue admission commits its actor and receipt atomically with native recovery", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, owner, rootID, pausedSince } = await failedSession()
    const request = { sessionID: session.id, requestID: "trusted-continue", pausedSince }
    const actor: ActorStamp.Account = {
      kind: "account",
      orgID: "organization",
      subjectID: "member",
      displayName: "Member",
      clientKind: "web",
      requestID: request.requestID,
    }
    const key = ["resume-admission-fixture", session.id]
    const failure = new Error("Receipt write failed")
    const options: SessionResume.Admission = {
      actor,
      async validate() {
        expect(Storage.inTransaction()).toBe(true)
        expect((await Session.get(session.id)).paused?.since).toBe(pausedSince)
      },
      async record(receipt) {
        expect(Storage.inTransaction()).toBe(true)
        await Storage.write(key, receipt)
        throw failure
      },
    }
    await expect(resumeSession(request, options)).rejects.toBe(failure)
    expect((await Session.get(session.id)).paused?.since).toBe(pausedSince)
    expect((await Session.get(session.id)).resume).toBeUndefined()
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
    expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("failed")
    expect(await Storage.readMany([key])).toEqual([undefined])
    expect(schedule).not.toHaveBeenCalled()
    await expect(
      resumeSession(request, {
        ...options,
        async validate() {
          throw undefined
        },
      }),
    ).rejects.toBeUndefined()
    const accepted = await resumeSession(request, { ...options, record: (receipt) => Storage.write(key, receipt) })
    expect(accepted.outcome).toBe("accepted")
    expect(accepted.receipt?.actor).toEqual(actor)
    expect(await Storage.read(key)).toEqual(accepted.receipt)
    const duplicate = await resumeSession(request, {
      actor: { ...actor, subjectID: "another-member" },
      record: async () => {
        throw new Error("A replay cannot rewrite its receipt")
      },
    })
    expect(duplicate.receipt).toEqual(accepted.receipt)
    const [item] = await SessionInbox.peekSteer(session.id)
    expect(item.message?.actor).toEqual(actor)
    await SessionInbox.materializeItem(item, rootID, { guiding: true })
    const message = (await MessageV2.get({ sessionID: session.id, messageID: item.messageID })).info
    if (message.role !== "user") throw new Error("Expected continuation input")
    expect(message.actor).toEqual(actor)
  }))

test("Continue drains without holding control and rechecks a pause that changed while waiting", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, pausedSince } = await failedSession()
    const lease = SessionManager.acquire(session.id)!
    const waiting = Promise.withResolvers<void>()
    const waitForIdle = SessionManager.waitForIdle
    using observer = spyOn(SessionManager, "waitForIdle").mockImplementation((...args) => {
      waiting.resolve()
      return waitForIdle(...args)
    })
    const pending = resumeSession({ sessionID: session.id, requestID: "waiting-continue", pausedSince })
    try {
      await waiting.promise
      const control = await Lock.tryAcquireWrite(`session-control:${session.id}`)
      const acquired = !!control
      control?.[Symbol.dispose]()
      await SessionLifecycle.clear(session.id)
      await SessionLifecycle.pause({ sessionID: session.id, reason: "workflow", description: "A newer pause" })
      const newer = (await Session.get(session.id)).paused!
      expect(newer.since).not.toBe(pausedSince)
      await SessionManager.release(lease, { requestNextWork: false })
      expect((await pending).outcome).toBe("stale")
      expect(acquired).toBe(true)
      expect((await Session.get(session.id)).paused).toEqual(newer)
      expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
      expect(schedule).not.toHaveBeenCalled()
    } finally {
      await SessionManager.release(lease, { requestNextWork: false })
      await pending.catch(() => {})
    }
  }))

test("cancelled Continue stops waiting without cancelling the active execution or admitting a late wake", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, pausedSince } = await failedSession()
    const lease = SessionManager.acquire(session.id)!
    const waiting = Promise.withResolvers<void>()
    const waitForIdle = SessionManager.waitForIdle
    using observer = spyOn(SessionManager, "waitForIdle").mockImplementation((...args) => {
      waiting.resolve()
      return waitForIdle(...args)
    })
    const controller = new AbortController()
    const pending = resumeSession(
      { sessionID: session.id, requestID: "cancelled-wait", pausedSince },
      { signal: controller.signal },
    ).then(
      () => "accepted",
      (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
    )
    try {
      await waiting.promise
      controller.abort()
      expect(await Promise.race([pending, Bun.sleep(100).then(() => "still waiting")])).toBe("AbortError")
      expect(lease.signal.aborted).toBe(false)
    } finally {
      await SessionManager.release(lease, { requestNextWork: false })
      await pending
    }
    expect((await Session.get(session.id)).paused?.since).toBe(pausedSince)
    expect((await Session.get(session.id)).resume).toBeUndefined()
    expect(schedule).not.toHaveBeenCalled()
  }))

test("Continue waits for Inbox uniqueness before taking the SQL writer", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, pausedSince } = await failedSession()
    const requestID = "delivery-lock-continue"
    const key = `session-inbox-delivery:${session.id}:${requestID}`
    const held = await Lock.write(key)
    const waiting = Promise.withResolvers<void>()
    const write = Lock.write
    using observer = spyOn(Lock, "write").mockImplementation((key) => {
      if (key === `session-inbox-delivery:${session.id}:${requestID}`) waiting.resolve()
      return write(key)
    })
    const pending = resumeSession({ sessionID: session.id, requestID, pausedSince })
    let progress: Promise<string> | undefined
    let outcome: string | undefined
    try {
      await waiting.promise
      progress = Storage.write(["resume-admission-fixture", "independent"], { saved: true }).then(() => "saved")
      outcome = await Promise.race([progress, Bun.sleep(500).then(() => "writer blocked")])
    } finally {
      held[Symbol.dispose]()
      await progress
      await pending
    }
    expect(outcome).toBe("saved")
    expect((await pending).outcome).toBe("accepted")
  }))

test("Continue commit cancellation rolls back its receipt, pause release and Rollout reopening", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, owner, rootID, pausedSince } = await failedSession()
    const controller = new AbortController()
    const key = ["resume-admission-fixture", session.id]
    const rejected = await resumeSession(
      { sessionID: session.id, requestID: "commit-cancel", pausedSince },
      {
        signal: controller.signal,
        async record(receipt) {
          await Storage.write(key, receipt)
          controller.abort()
        },
      },
    ).catch((error: unknown) => error)
    expect(rejected).toBe(controller.signal.reason)
    expect((await Session.get(session.id)).paused?.since).toBe(pausedSince)
    expect((await Session.get(session.id)).resume).toBeUndefined()
    expect(await Storage.readMany([key])).toEqual([undefined])
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
    expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("failed")
    expect(schedule).not.toHaveBeenCalled()
  }))

test("Continue refuses an enclosing transaction before waiting for execution", () =>
  fixture(async () => {
    const { session } = await failedSession()
    await expect(Storage.transaction(() => resumeSession({ sessionID: session.id }))).rejects.toThrow(
      "Session continuation must own its commit boundary",
    )
    expect((await Session.get(session.id)).paused).toBeDefined()
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
  }))

test("Continue rechecks the pause at publication after history preparation", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, owner, rootID, pausedSince } = await failedSession()
    const prepared = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const modelMessages = SessionHistory.modelMessages
    using preparation = spyOn(SessionHistory, "modelMessages").mockImplementation(async (...args) => {
      const messages = await modelMessages(...args)
      prepared.resolve()
      await proceed.promise
      return messages
    })
    const pending = resumeSession({ sessionID: session.id, requestID: "prepared-continue", pausedSince })
    try {
      await prepared.promise
      await SessionLifecycle.clear(session.id)
      await SessionLifecycle.pause({ sessionID: session.id, reason: "workflow" })
      const newer = (await Session.get(session.id)).paused!
      expect(newer.since).not.toBe(pausedSince)
      proceed.resolve()
      expect((await pending).outcome).toBe("stale")
      expect((await Session.get(session.id)).paused).toEqual(newer)
      expect(await SessionInbox.peekSteer(session.id)).toHaveLength(0)
      expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("failed")
      expect(schedule).not.toHaveBeenCalled()
    } finally {
      proceed.resolve()
      await pending.catch(() => {})
    }
  }))

test("a cancelled Continue cannot acquire a queued control lock after its caller leaves", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, pausedSince } = await failedSession()
    const held = await Lock.write(`session-control:${session.id}`)
    const controller = new AbortController()
    const pending = resumeSession(
      { sessionID: session.id, requestID: "queued-continue", pausedSince },
      { signal: controller.signal },
    ).catch((error: unknown) => error)
    try {
      controller.abort()
      expect(await Promise.race([pending, Bun.sleep(100).then(() => "still waiting")])).toBe(controller.signal.reason)
    } finally {
      held[Symbol.dispose]()
      await pending
    }
    expect((await Session.get(session.id)).paused?.since).toBe(pausedSince)
    expect((await Session.get(session.id)).resume).toBeUndefined()
    expect(schedule).not.toHaveBeenCalled()
  }))

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

test("Continue resumes a completed root with an already materialized unanswered Cortex notification", () =>
  fixture(async () => {
    using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    const { session, rootID, messageID, owner } = await failedSession()
    const reply = await MessageV2.get({ sessionID: session.id, messageID })
    if (reply.info.role !== "assistant") throw new Error("Expected assistant")
    await Session.updateMessage({ ...reply.info, error: undefined, finish: "stop" })
    await RolloutLedger.resumeRun(owner, rootID)
    await RolloutLedger.finishRun(owner, rootID, "completed")
    await SessionInbox.deliver({
      sessionID: session.id,
      mode: "steer",
      message: {
        role: "user",
        origin: { type: "cortex", taskID: "ctx_fixture" },
        parts: [{ type: "text", text: "The background task completed; retrieve its result." }],
      },
    })
    const [notification] = await SessionInbox.peekSteer(session.id)
    await SessionInbox.materializeItem(notification, rootID, { guiding: true })

    const request = { sessionID: session.id, requestID: "continue-saved-notification" }
    expect((await resumeSession(request)).outcome).toBe("accepted")
    expect((await resumeSession(request)).outcome).toBe("already_accepted")
    expect((await RolloutLedger.getRun(owner, rootID)).status).toBe("running")
    expect((await Session.get(session.id)).paused).toBeUndefined()
    expect((await MessageV2.get({ sessionID: session.id, messageID })).info).toMatchObject({ finish: "stop" })
    expect(await SessionInbox.peekSteer(session.id)).toHaveLength(1)
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
