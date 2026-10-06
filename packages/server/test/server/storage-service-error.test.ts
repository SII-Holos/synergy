import { afterAll, expect, spyOn, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Server } from "../../src/server/server"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("storage admission failures use a retryable 503 contract", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Storage service error" })
        const app = Server.App()
        using failure = spyOn(SessionHistory, "timelinePage").mockRejectedValue(
          new Storage.BusyError("SQLite worker exceeded its request deadline"),
        )
        const busy = await app.request(`/session/${session.id}/timeline/page`)
        expect(busy.status).toBe(503)
        expect(busy.headers.get("Retry-After")).toBe("1")
        expect(await busy.json()).toEqual({
          name: "StorageServiceError",
          data: {
            message: "Authoritative storage is busy; retry shortly",
            state: "busy",
            retryAfterMs: 1_000,
          },
        })

        failure.mockRejectedValue(new Storage.UnavailableError("SQLite worker exited"))
        const unavailable = await app.request(`/session/${session.id}/timeline/page`)
        expect(unavailable.status).toBe(503)
        expect(unavailable.headers.get("Retry-After")).toBe("5")
        expect(await unavailable.json()).toEqual({
          name: "StorageServiceError",
          data: {
            message: "Authoritative storage is recovering; retry shortly",
            state: "unavailable",
            retryAfterMs: 5_000,
          },
        })
        await Session.remove(session.id)
      },
    })
  }))
