import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Server } from "../../src/server/server"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("model selection API persists a revisioned choice and reports conflicts and unsupported controls", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        model: "selection/model",
        provider: {
          selection: {
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture" },
            models: { model: { name: "Model", variants: { high: { reasoningEffort: "high" } } } },
          },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const url = `/session/${session.id}/model-selection`
        const send = (thinking: unknown, expectedRevision = 0) =>
          Server.App().request(url, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: { providerID: "selection", modelID: "model" }, thinking, expectedRevision }),
          })
        const saved = await send({ mode: "variant", variant: "high" })
        expect(saved.status, await saved.clone().text()).toBe(200)
        const body = (await saved.json()) as Session.Info
        expect(body.modelSelection?.revision).toBe(1)
        const stale = await send({ mode: "provider-default" })
        expect(stale.status).toBe(409)
        expect(await stale.json()).toMatchObject({
          name: "SessionModelSelectionConflictError",
          data: { actualRevision: 1 },
        })
        expect((await send({ mode: "off" }, 1)).status).toBe(400)
        expect((await send({ mode: "variant", variant: "missing" }, 1)).status).toBe(400)
        expect((await Session.get(session.id)).modelSelection).toEqual(body.modelSelection)
        const defaulted = await send({ mode: "provider-default" }, 1)
        expect(defaulted.status).toBe(200)
        expect(((await defaulted.json()) as Session.Info).modelSelection?.selected.thinking).toEqual({
          mode: "provider-default",
        })
        const reset = await Server.App().request(`/session/${session.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelOverride: null }),
        })
        expect(reset.status).toBe(200)
        const resetBody = (await reset.json()) as Session.Info
        expect(resetBody.modelOverride).toBeUndefined()
        expect(resetBody.modelSelection?.revision).toBe(3)
        expect((await send({ mode: "provider-default" }, 0)).status).toBe(409)
        const invalidUpdate = await Server.App().request(`/session/${session.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelOverride: { providerID: "selection", modelID: "model" },
            resolvePendingPermissions: true,
          }),
        })
        expect(invalidUpdate.status).toBe(400)
        expect((await Session.get(session.id)).modelSelection).toEqual(resetBody.modelSelection)
      },
    })
  }))
