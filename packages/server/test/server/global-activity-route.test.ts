import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Server } from "../../src/server/server"

Log.init({ print: false })

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

test("global activity reports busy sessions, detached background work, and no-store caching", async () => {
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
})

test("counts a session running in another scope than the request scope", async () => {
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
})

test("reports active for detached background work with no running session", async () => {
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
})
