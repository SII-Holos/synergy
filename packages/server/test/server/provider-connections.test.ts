import { expect, test } from "bun:test"
import { Hono } from "hono"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Auth } from "@ericsanchezok/synergy-harness/provider/api-key"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { createProviderRoute } from "../../src/server/provider"

test("provider connection PATCH edits a canonical account while preserving validation and removal boundaries", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = new Hono().route("/provider", createProviderRoute())
        await Auth.set("deepseek", { type: "api", key: "canonical-route-key" })
        const credentials = await Auth.entries()
        const patched = await app.request("/provider/connections/deepseek", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "  Personal account  ",
            endpoint: "https://account.invalid/v1",
            enabled: false,
          }),
        })
        expect(patched.status).toBe(200)
        expect(await patched.json()).toEqual({
          id: "deepseek",
          name: "Personal account",
          profileID: "deepseek",
          catalogProviderID: "deepseek",
          endpoint: "https://account.invalid/v1",
          enabled: false,
          configured: true,
          removable: false,
          canCreateSibling: true,
        })
        const beforeRename = await Config.globalResolved()
        const renamed = await app.request("/provider/connections/deepseek", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "  Work account  " }),
        })
        expect(renamed.status).toBe(200)
        expect(await renamed.json()).toMatchObject({
          id: "deepseek",
          name: "Work account",
          endpoint: "https://account.invalid/v1",
          enabled: false,
        })
        const configured = await Config.globalResolved()
        expect(configured).toEqual({
          ...beforeRename,
          provider: {
            ...beforeRename.provider,
            deepseek: { ...beforeRename.provider?.deepseek, name: "Work account" },
          },
        })

        const unknown = await app.request("/provider/connections/unknown-account", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Unknown" }),
        })
        expect(unknown.status).toBe(400)
        expect(await unknown.json()).toEqual({
          name: "ProviderConnectionNotFoundError",
          data: { providerID: "unknown-account" },
        })
        const invalid = await app.request("/provider/connections/deepseek", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: " " }),
        })
        expect(invalid.status).toBe(400)
        const removed = await app.request("/provider/connections/deepseek", { method: "DELETE" })
        expect(removed.status).toBe(400)
        expect(await removed.json()).toEqual({
          name: "ProviderConnectionNotManagedError",
          data: { providerID: "deepseek" },
        })
        expect(await Config.globalResolved()).toEqual(configured)
        expect(await Auth.entries()).toEqual(credentials)
      },
    }),
  )
})
