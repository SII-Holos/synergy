import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Auth } from "@ericsanchezok/synergy-harness/provider/api-key"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalProviderSdks } from "@ericsanchezok/synergy-local-runtime/provider/sdk-registry"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderConnection } from "@ericsanchezok/synergy-harness/provider/connection"
import { Session } from "@ericsanchezok/synergy-harness/session"
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

test("connection testing invokes the saved model, rejects a wrong key and creates no Session", async () => {
  const requests: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const endpoint = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>)
      requests.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization") ?? ""}`)
      if (request.headers.get("authorization") !== "Bearer fixture-valid")
        return Response.json(
          { error: { message: "Invalid API key: fixture-wrong", type: "authentication_error" } },
          { status: 401 },
        )
      if (new URL(request.url).pathname.endsWith("/responses"))
        return Response.json({
          id: "response",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5-mini",
          output: [
            {
              type: "message",
              id: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        })
      return Response.json({
        id: "probe",
        object: "chat.completion",
        created: 1,
        model: "probe-model",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      })
    },
  })
  try {
    await using runtime = await testRuntime({ register: registerLocalProviderSdks })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await ProviderConnection.createCustom({
            id: "probe-provider",
            name: "Probe",
            endpoint: `http://127.0.0.1:${endpoint.port}/v1`,
            protocol: "openai-completions",
            models: [
              { id: "probe-model", context: 4096, output: 256, toolCall: false, image: false, reasoning: false },
            ],
          })
          await Auth.set("probe-provider", { type: "api", key: "fixture-wrong" })
          const catalog = await Provider.getProvider("probe-provider")
          const activeModel = catalog.models["probe-model"]
          catalog.models = {
            retired: {
              ...activeModel,
              id: "retired",
              status: "deprecated",
              api: { ...activeModel.api, id: "retired" },
            },
            ...catalog.models,
          }
          const app = new Hono().route("/provider", createProviderRoute())
          const failed = await app.request("/provider/connections/probe-provider/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          expect(failed.status).toBe(200)
          const failure = await failed.json()
          expect(failure).toMatchObject({
            success: false,
            providerID: "probe-provider",
            modelID: "probe-model",
            error: { kind: "authentication", statusCode: 401 },
          })
          expect(JSON.stringify(failure)).not.toContain("fixture-wrong")
          const operations = await Storage.scan(["operations", Scope.home().id])
          expect(operations).toHaveLength(1)
          for (const operationID of operations) {
            const owner = { kind: "operation" as const, scopeID: Scope.home().id, operationID }
            const artifacts = await RolloutArtifact.list(owner)
            expect(artifacts.length).toBeGreaterThan(0)
            for (const artifact of artifacts) {
              for (let offset = 0; offset < artifact.bytes; offset += 65536) {
                expect((await RolloutArtifact.readRange(owner, artifact, offset, 65536)).toString()).not.toContain(
                  "fixture-wrong",
                )
              }
            }
          }
          expect(requests).toEqual(["POST /v1/chat/completions Bearer fixture-wrong"])
          await Auth.set("probe-provider", { type: "api", key: "fixture-valid" })
          const passed = await app.request("/provider/connections/probe-provider/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          expect(await passed.json()).toMatchObject({
            success: true,
            providerID: "probe-provider",
            modelID: "probe-model",
          })
          expect(requests).toEqual([
            "POST /v1/chat/completions Bearer fixture-wrong",
            "POST /v1/chat/completions Bearer fixture-valid",
          ])
          const unavailable = await app.request("/provider/connections/missing-provider/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          expect(await unavailable.json()).toMatchObject({ success: false, error: { kind: "unavailable" } })
          expect(requests).toHaveLength(2)
          await ProviderConnection.createCustom({
            id: "missing-key",
            name: "Missing key",
            endpoint: `http://127.0.0.1:${endpoint.port}/v1`,
            protocol: "openai-responses",
            models: [{ id: "gpt-5-mini", context: 4096, output: 256, toolCall: false, image: false, reasoning: true }],
          })
          await Provider.reload()
          const missing = await app.request("/provider/connections/missing-key/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          expect(await missing.json()).toMatchObject({ success: false, error: { kind: "authentication" } })
          expect(requests).toHaveLength(2)
          await Auth.set("missing-key", { type: "api", key: "fixture-valid" })
          const responseProbe = await app.request("/provider/connections/missing-key/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
          expect(await responseProbe.json()).toMatchObject({ success: true, modelID: "gpt-5-mini" })
          expect(bodies.at(-1)).toMatchObject({ store: false, reasoning: { effort: "low" } })
          expect(requests).toHaveLength(3)
          expect((await Session.list()).data).toHaveLength(0)
        },
      }),
    )
  } finally {
    endpoint.stop(true)
  }
})
