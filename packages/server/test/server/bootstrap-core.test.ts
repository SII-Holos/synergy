import { afterAll, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Command } from "@ericsanchezok/synergy-local-runtime/command/command"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { createScopeBootstrapRoute } from "../../src/server/scope-bootstrap-route"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("core bootstrap accepts a custom provider configured through SDK options", () =>
  runtime.run(async () => {
    await using fixture = await tmpdir({
      init: async (directory) => {
        await Bun.write(
          `${directory}/.synergy/synergy.d/20-providers.jsonc`,
          JSON.stringify({
            model: "custom-display/model",
            provider: {
              "custom-display": {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "https://model.example.invalid/v1", apiKey: "fixture" },
                models: { model: { name: "Custom model", limit: { context: 64000, output: 4096 } } },
              },
            },
          }),
        )
      },
    })
    await ScopeContext.provide({
      scope: await fixture.scope(),
      fn: async () => {
        const response = await new Hono().route("/scope", createScopeBootstrapRoute()).request("/scope/bootstrap-core")
        expect(response.status).toBe(200)
        const data = await response.json()
        const provider = data.provider.all.find((entry: { id: string }) => entry.id === "custom-display")
        expect(provider.models.model.api.url).toBe("https://model.example.invalid/v1")
        expect(provider.options).toEqual({})
      },
    })
  }))

test("core bootstrap is bounded and never awaits an auxiliary command resource", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const currentConfig = await Config.current()
        using configuration = spyOn(Config, "current").mockResolvedValue({
          ...currentConfig,
          snapshot: false,
          agent: {},
          provider: {},
        })
        using commands = spyOn(Command, "list").mockImplementation(async () => {
          throw new Error("auxiliary resource unavailable")
        })
        using workspaces = spyOn(WorkspaceCatalog, "list").mockImplementation(async () => {
          throw new Error("Unrelated workspace catalog is unavailable")
        })
        using statuses = spyOn(SessionManager, "listStatuses").mockImplementation(async () => {
          throw new Error("Complete status discovery is unavailable")
        })
        const redact = Config.redactForClient
        using preferences = spyOn(Config, "redactForClient").mockImplementation((config) => {
          if (config.agent || config.provider) throw new Error("Full configuration is not a UI preference resource")
          return redact(config)
        })
        const app = new Hono().route("/scope", createScopeBootstrapRoute())
        const response = await app.request("/scope/bootstrap-core")
        expect(response.status).toBe(200)
        expect(response.headers.get("server-timing")).toContain("core_status;dur=")
        expect(response.headers.get("server-timing")).toContain("core_provider;dur=")
        const text = await response.text()
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 * 1024)
        const data = JSON.parse(text)
        expect(data.provider.complete).toBe(false)
        expect(data.agent.every((agent: Record<string, unknown>) => !("prompt" in agent))).toBe(true)
        expect(data.agent.every((agent: Record<string, unknown>) => !("permission" in agent))).toBe(true)
        expect(data.config.provider).toBeUndefined()
        expect(commands).not.toHaveBeenCalled()
        expect(statuses).not.toHaveBeenCalled()
        expect(workspaces).not.toHaveBeenCalled()
        expect(data.workspaces).toEqual([])
      },
    }),
  ))

test("core bootstrap loads selected workspace identities without decoding unrelated catalog rows", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const selected = await WorkspaceCatalog.create({ scopeID: "home", backend: { provider: "objects", spec: {} } })
        const session = await Session.create({ workspaceID: selected.id })
        const unrelated = crypto.randomUUID()
        await Storage.write(["workspace", unrelated], { unreadable: true })
        await Storage.write(["workspace_scope", "home", unrelated], unrelated)
        try {
          const response = await new Hono()
            .route("/scope", createScopeBootstrapRoute())
            .request("/scope/bootstrap-core")
          expect(response.status).toBe(200)
          const data = await response.json()
          expect(data.sessions.data.some((item: { id: string }) => item.id === session.id)).toBe(true)
          expect(data.workspaces.map((item: { id: string }) => item.id)).toContain(selected.id)
          expect(data.workspaces.map((item: { id: string }) => item.id)).not.toContain(unrelated)
          expect(data.workspacesComplete).toBe(false)
        } finally {
          await Storage.remove(["workspace_scope", "home", unrelated])
          await Storage.remove(["workspace", unrelated])
        }
      },
    }),
  ))
