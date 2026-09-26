import { afterAll, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const post = (route: string, body?: unknown) =>
  Server.App().request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

test("maintenance admission closes new work atomically and only its lease releases it", () =>
  runtime.run(async () => {
    const prepared = await post("/global/maintenance/prepare")
    expect(prepared.status).toBe(200)
    const { token } = (await prepared.json()) as { token: string }
    try {
      expect((await post("/session")).status).toBe(503)
      expect((await Server.App().request("/global/activity")).status).toBe(200)
      expect(() => SessionManager.acquire("ses_admission")).toThrow("shutting down")
      expect((await post("/global/maintenance/release", { token: "unrelated" })).status).toBe(409)
      expect((await post("/session")).status).toBe(503)
    } finally {
      expect((await post("/global/maintenance/release", { token })).status).toBe(200)
    }
    expect((await post("/session")).status).toBe(200)
  }))

test("maintenance refuses active tasks without closing admission", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)!
        try {
          expect((await post("/global/maintenance/prepare")).status).toBe(409)
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
        expect((await post("/session")).status).toBe(200)
      },
    }),
  ))

test("maintenance refuses a mutation already admitted before its request", () =>
  runtime.run(async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = Session.create
    using create = spyOn(Session, "create").mockImplementation(async (input) => {
      entered.resolve()
      await release.promise
      return original(input)
    })
    const mutation = post("/session")
    await entered.promise
    try {
      expect((await post("/global/maintenance/prepare")).status).toBe(409)
    } finally {
      release.resolve()
      await mutation
    }
  }))

test("maintenance refuses a scheduled wake before it acquires a session", () =>
  runtime.run(async () => {
    SessionManager.scheduleWake("ses_pending_maintenance", "maintenance admission regression")
    expect(SessionManager.hasPendingWake()).toBe(true)
    try {
      expect((await post("/global/maintenance/prepare")).status).toBe(409)
    } finally {
      SessionManager.closeAdmission()
      await SessionManager.drain()
      SessionManager.openAdmission()
    }
  }))

test(
  "an abandoned maintenance lease expires and reopens admission",
  () =>
    runtime.run(async () => {
      const prepared = await post("/global/maintenance/prepare")
      expect(prepared.status).toBe(200)
      const { token, expiresAt } = (await prepared.json()) as { token: string; expiresAt: number }
      try {
        expect((await post("/session")).status).toBe(503)
        await Bun.sleep(Math.max(0, expiresAt - Date.now()) + 25)
        expect((await post("/session")).status).toBe(200)
        expect((await post("/global/maintenance/release", { token })).status).toBe(409)
      } finally {
        await post("/global/maintenance/release", { token })
      }
    }),
  35_000,
)
