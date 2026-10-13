import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Agenda, AgendaStore } from "@ericsanchezok/synergy-agenda/agenda"
import { AgendaRoute } from "@ericsanchezok/synergy-agenda/agenda/routes/agenda"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { github } from "@ericsanchezok/synergy-github/component"
import { registerWorker } from "../src/worker"

const trigger = { type: "github", resource: "pr", repository: "acme/project", number: 1 }
for (const selected of [false, true])
  test(`HTTP GitHub triggers and retained items require the explicit bridge (${selected})`, async () => {
    await using runtime = await testRuntime({
      composition: {
        register() {
          registerLocalRuntime()
          agenda().register()
          github().register()
          if (selected) registerWorker()
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const app = new Hono().route("/agenda", AgendaRoute())
          const normal = await Agenda.create({ title: "Plain", prompt: "Do work", createdBy: "user" })
          const request = (path: string, method: string, body?: unknown) =>
            app.request(path, {
              method,
              ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
            })
          const created = await request("/agenda", "POST", { title: "GitHub", prompt: "Wait", triggers: [trigger] })
          expect(created.status).toBe(selected ? 200 : 400)
          const patched = await request(`/agenda/${normal.id}`, "PATCH", { triggers: [trigger] })
          expect(patched.status).toBe(selected ? 200 : 400)
          const retained = {
            ...normal,
            id: "agenda_retained",
            title: "Retained GitHub",
            triggers: [trigger],
            status: "active",
          }
          const key = ["agenda", "items", "home", retained.id]
          await Storage.write(key, retained)
          const listing = (await (await request("/agenda", "GET")).json()) as Array<{ id: string }>
          expect(listing.some((item) => item.id === retained.id)).toBe(selected)
          expect((await request(`/agenda/${retained.id}`, "GET")).status).toBe(selected ? 200 : 404)
          expect((await AgendaStore.loadActive()).some((item) => item.id === retained.id)).toBe(selected)
          expect(await Storage.read<unknown>(key)).toEqual(retained)
          const spec = JSON.stringify(await generateSpecs(app))
          expect(spec.includes("AgendaTriggerGithub")).toBe(selected)
          Agenda.stop()
        },
      }),
    )
  }, 20_000)
