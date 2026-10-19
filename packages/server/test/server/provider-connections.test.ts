import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
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

test("provider connection custom route creates, edits and removes a config-only provider", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const app = new Hono().route("/provider", createProviderRoute())
        const credentials = await Auth.entries()
        const created = await app.request("/provider/connections/custom", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "lab",
            name: "  Lab  ",
            endpoint: "https://lab.invalid/v1",
            protocol: "openai-responses",
            models: [
              {
                id: "lab-chat",
                name: "Lab Chat",
                context: 128000,
                output: 16000,
                toolCall: true,
                image: false,
                reasoning: true,
              },
            ],
          }),
        })
        expect(created.status).toBe(200)
        expect(await created.json()).toEqual({
          id: "lab",
          name: "Lab",
          profileID: "lab",
          catalogProviderID: "lab",
          endpoint: "https://lab.invalid/v1",
          enabled: true,
          configured: true,
          removable: true,
          canCreateSibling: false,
          protocol: "openai-responses",
          models: [
            {
              id: "lab-chat",
              name: "Lab Chat",
              context: 128000,
              output: 16000,
              toolCall: true,
              image: false,
              reasoning: true,
            },
          ],
        })
        expect((await Config.domainGet("providers")).provider?.lab).toMatchObject({
          name: "Lab",
          api: "https://lab.invalid/v1",
          npm: "@ai-sdk/openai",
        })
        expect(await Auth.entries()).toEqual(credentials)

        const duplicate = await app.request("/provider/connections/custom", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "lab",
            name: "Lab",
            endpoint: "https://lab.invalid/v1",
            protocol: "openai-completions",
            models: [{ id: "lab-chat", context: 1, output: 1, toolCall: true, image: false, reasoning: false }],
          }),
        })
        expect(duplicate.status).toBe(400)
        expect(await duplicate.json()).toEqual({
          name: "ProviderConnectionAlreadyExistsError",
          data: { providerID: "lab" },
        })

        const invalid = await app.request("/provider/connections/custom", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: "lab-2",
            name: " ",
            endpoint: "ftp://lab.invalid/v1",
            protocol: "openai-completions",
            models: [],
          }),
        })
        expect(invalid.status).toBe(400)

        const updated = await app.request("/provider/connections/lab", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: "https://lab-2.invalid/v1",
            protocol: "anthropic-messages",
            models: [
              { id: "lab-claude", context: 200000, output: 32000, toolCall: false, image: true, reasoning: false },
            ],
          }),
        })
        expect(updated.status).toBe(200)
        expect(await updated.json()).toMatchObject({
          id: "lab",
          endpoint: "https://lab-2.invalid/v1",
          protocol: "anthropic-messages",
          models: [
            { id: "lab-claude", context: 200000, output: 32000, toolCall: false, image: true, reasoning: false },
          ],
        })
        expect((await Config.domainGet("providers")).provider?.lab).toMatchObject({ npm: "@ai-sdk/anthropic" })

        const listed = await app.request("/provider")
        expect(listed.status).toBe(200)
        const body = await listed.json()
        expect(body.configProviders).toContain("lab")
        expect(body.connections.lab).toMatchObject({
          id: "lab",
          name: "Lab",
          endpoint: "https://lab-2.invalid/v1",
          configured: true,
          removable: true,
          canCreateSibling: false,
          protocol: "anthropic-messages",
        })

        const cleared = await app.request("/provider/connections/lab", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: null }),
        })
        expect(cleared.status).toBe(400)
        expect(await cleared.json()).toEqual({
          name: "ProviderConnectionCustomValidationError",
          data: { providerID: "lab", message: "A custom provider connection requires an endpoint" },
        })

        const removed = await app.request("/provider/connections/lab", { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(await removed.json()).toEqual({ providerID: "lab", removed: true })
        expect((await Config.domainGet("providers")).provider?.lab).toBeUndefined()

        const missing = await app.request("/provider/connections/lab", { method: "DELETE" })
        expect(missing.status).toBe(400)
        expect(await missing.json()).toEqual({
          name: "ProviderConnectionNotFoundError",
          data: { providerID: "lab" },
        })
      },
    }),
  )
})

test("mounted provider connection custom operation keeps its OpenAPI contract", async () => {
  const spec = await generateSpecs(new Hono().route("/provider", createProviderRoute()))
  const operation = spec.paths?.["/provider/connections/custom"]?.post
  expect(operation?.operationId).toBe("provider.connection.createCustom")
  expect(operation?.requestBody).toMatchObject({
    content: { "application/json": { schema: { $ref: "#/components/schemas/ProviderConnectionCustomInput" } } },
  })
})
