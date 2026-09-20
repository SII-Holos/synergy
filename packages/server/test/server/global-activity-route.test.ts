import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionNav } from "@ericsanchezok/synergy-harness/session/nav"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Server } from "../../src/server/server"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

type Activity = { active: boolean; sessions: number; backgroundJobs: number }

async function activity() {
  // The real app, not a bare Hono router: this route depends on the request
  // scope middleware resolving `/global/*` to the home scope without a
  // directory parameter, which is exactly what a mounted-router test skips.
  const response = await Server.App().request("/global/activity")
  return { response, body: (await response.clone().json()) as Activity }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting for condition")
}

test("global activity reports busy sessions, detached background work, and no-store caching", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const before = await activity()
        expect(before.response.status).toBe(200)
        expect(before.response.headers.get("cache-control")).toBe("no-store")
        expect(before.body).toEqual({
          active: before.body.sessions > 0 || before.body.backgroundJobs > 0,
          sessions: SessionManager.activeRuntimeCount(),
          backgroundJobs: LoopJob.activeBackgroundCount(),
        })

        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        try {
          const busy = await activity()
          expect(busy.body.sessions).toBe(before.body.sessions + 1)
          expect(busy.body.active).toBe(true)
        } finally {
          await SessionManager.release(lease!, { requestNextWork: false })
        }

        const idle = await activity()
        expect(idle.body.sessions).toBe(before.body.sessions)
      },
    })
  }))

test("counts a session running in another scope than the request scope", () =>
  runtime.run(async () => {
    await using project = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const baseline = (await activity()).body.sessions

        let lease: SessionManager.LoopLease | undefined
        await ScopeContext.provide({
          scope: await project.scope(),
          fn: async () => {
            const session = await Session.create({})
            lease = SessionManager.acquire(session.id)
            expect(lease).toBeDefined()
          },
        })

        try {
          // Requested from home scope while the busy session belongs to a project
          // scope: a per-scope route could not see it, and this is what makes the
          // Desktop keep-awake decision correct for scopes the UI never loaded.
          const crossScope = await activity()
          expect(crossScope.body.sessions).toBe(baseline + 1)
          expect(crossScope.body.active).toBe(true)
        } finally {
          if (lease) await SessionManager.release(lease, { requestNextWork: false })
        }

        expect((await activity()).body.sessions).toBe(baseline)
      },
    })
  }))

test("reports active for detached background work with no running session", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const baseline = (await activity()).body.backgroundJobs
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const type = `test_global_activity_${crypto.randomUUID()}`
        LoopJob.register({
          type,
          phase: "post",
          blocking: false,
          detached: true,
          collect: () => [],
          capture: () => ({ type }),
          async execute() {
            started.resolve()
            await release.promise
            return "pass"
          },
        })
        const sessionID = `ses_global_activity_${crypto.randomUUID()}`
        expect(LoopJob.scheduleDetached({ type, sessionID, rootID: "root_1" })).toBe(true)
        await started.promise
        await waitFor(() => LoopJob.activeBackgroundCount() === baseline + 1)

        const backgroundOnly = await activity()
        expect(backgroundOnly.body.backgroundJobs).toBe(baseline + 1)
        expect(backgroundOnly.body.active).toBe(true)

        release.resolve()
        await LoopJob.settleDetached(sessionID)
        await waitFor(() => LoopJob.activeBackgroundCount() === baseline)
        expect((await activity()).body.backgroundJobs).toBe(baseline)
      },
    })
  }))

async function createRecoverableSession(title: string) {
  const session = await Session.create({ title })
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "user",
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
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
  await Session.update(session.id, (draft) => {
    draft.pendingReply = true
  })
  return session
}

test("serves the in-memory count without triggering a cross-scope recovery scan", () =>
  runtime.run(async () => {
    await using project = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        // A session still queued for recovery after a restart: only the disk scan
        // can see it, because create()'s idle runtime is dropped. It is therefore
        // the fixture where the two candidate paths disagree, and the route must
        // report the in-memory answer.
        let queuedID = ""
        await ScopeContext.provide({
          scope: await project.scope(),
          fn: async () => {
            const queued = await createRecoverableSession("Queued for recovery")
            queuedID = queued.id
            SessionManager.unregisterRuntime(queued.id)
          },
        })

        const scopeIDs = spyOn(SessionNav, "getAllScopeIDs")
        const recoverable = spyOn(SessionRecovery, "recoverableStatuses")
        try {
          const polled = await activity()
          expect(polled.response.status).toBe(200)
          expect(polled.response.headers.get("cache-control")).toBe("no-store")
          expect(scopeIDs).not.toHaveBeenCalled()
          expect(recoverable).not.toHaveBeenCalled()

          // Positive control: the aggregate the poll replaced does reach both
          // scoped-scan entry points and does report the queued session, so the
          // assertions above are not passing merely because the spies are inert.
          expect(Object.keys(await SessionManager.listStatuses())).toContain(queuedID)
          expect(recoverable).toHaveBeenCalled()
          expect(polled.body.sessions).toBeLessThan(Object.keys(await SessionManager.listStatuses()).length)
        } finally {
          scopeIDs.mockRestore()
          recoverable.mockRestore()
          SessionManager.unregisterRuntime(queuedID)
          await Session.remove(queuedID)
        }
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
