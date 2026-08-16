import { expect, mock, test } from "bun:test"
import z from "zod"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Replace the provider module so /global/health observes a provider state
// build that never settles, plus a controlled last-settled snapshot. This
// isolates the health handler's bounded-wait behavior from real catalog work.
const providerModule = pathToFileURL(path.resolve(import.meta.dir, "../../src/provider/provider.ts")).href

let settledProviders: Record<string, unknown> = {}

mock.module(providerModule, () => ({
  Provider: {
    ModelNotFoundError: class ModelNotFoundError extends Error {},
    // Schema members used at module top level by server routes must stay zod
    // schemas so OpenAPI spec generation keeps working under the mock.
    Info: z.object({ id: z.string() }),
    list: () => new Promise(() => {}),
    listSettled: () => settledProviders,
    reload: async () => {},
    listConfiguredForClient: async () => ({}),
    fromModelsDevProvider: (provider: unknown) => provider,
  },
}))

const { Server } = await import("../../src/server/server")
const { ScopeContext } = await import("../../src/scope/context")
const { Scope } = await import("../../src/scope")

test("health answers from the last settled provider state within 1s when the build stalls", async () => {
  settledProviders = { "settled-provider": { id: "settled-provider" } }
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      Server.App()
      const startedAt = Date.now()
      const res = await Server.App().request("/global/health")
      expect(Date.now() - startedAt).toBeLessThan(1500)
      const body = (await res.json()) as { healthy: boolean; modelReady: boolean }
      expect(body.healthy).toBe(true)
      // The stalled build must not report ready optimistically; it reflects
      // the last settled provider set instead.
      expect(body.modelReady).toBe(true)
    },
  })
})

test("health reports modelReady=false when the build stalls and nothing has settled yet", async () => {
  settledProviders = {}
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const res = await Server.App().request("/global/health")
      const body = (await res.json()) as { healthy: boolean; modelReady: boolean }
      expect(body.healthy).toBe(true)
      expect(body.modelReady).toBe(false)
    },
  })
})
