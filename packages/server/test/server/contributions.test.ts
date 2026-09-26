import { expect, test } from "bun:test"
import { Hono } from "hono"
import { Server } from "../../src/server/server"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { registerLocalRuntime } from "@ericsanchezok/synergy-runtime-local/register"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"

test("core application has core routes without product routes", async () => {
  await using runtime = await testRuntime({ composition: { register: registerLocalRuntime } })
  runtime.run(() => {
    const paths = Server.App().routes.map((route) => route.path)
    expect(paths).toContain("/scope/bootstrap")
    expect(paths).toContain("/global/health")
    expect(paths).not.toContain("/global/agenda")
    expect(paths.some((path) => path.startsWith("/browser"))).toBe(false)
    expect(paths.some((path) => path.startsWith("/library"))).toBe(false)
  })
})

test("contributions preserve route ordering, Scope middleware, and construction boundary", async () => {
  await using runtime = await testRuntime({
    composition: {
      register() {
        registerLocalRuntime()
        Server.registerContributions({
          routes: {
            "global-tools": new Hono().get("/probe", (c) =>
              c.json({ stage: "first", scopeID: ScopeContext.current.scope.id }),
            ),
            "scoped-integrations": new Hono().get("/probe", (c) => c.json({ stage: "last" })),
          },
          isScopeRequiredRoute: (path) => path === "/probe",
        })
      },
    },
  })
  await runtime.run(async () => {
    const app = Server.App()
    const missing = await app.request("/probe")
    const scoped = await app.request("/probe?scopeID=home")
    expect(missing.status).toBe(400)
    expect((await missing.json()).name).toBe("ScopeRequired")
    expect(scoped.status).toBe(200)
    expect(await scoped.json()).toEqual({ stage: "first", scopeID: "home" })
    expect(scoped.headers.get("x-synergy-seq")).not.toBeNull()
    expect(() => Server.registerContributions({})).toThrow(/before opening|before constructing/)
  })
})
