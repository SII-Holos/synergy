import { expect, test } from "bun:test"
import { Hono } from "hono"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Features } from "@ericsanchezok/synergy-harness/lifecycle/features"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { Server } from "../../src/server/server"

test("live features reload through the config API without changing an in-flight operation", async () => {
  let release!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const admitted = new Promise<void>((resolve) => {
    started = resolve
  })
  let first = true
  await using runtime = await testRuntime({
    composition: RuntimeComponents.compose([
      localRuntime({ workers: false, environment: false }),
      {
        id: "fixture",
        apiVersion: 1,
        version: "1.0.0",
        features: {
          kind: "product",
          definitions: [
            {
              id: "fixture-strategy",
              owner: "fixture",
              maturity: "experimental",
              activation: "live",
              name: "Fixture strategy",
              description: "Operation-local behavior",
            },
          ],
        },
        register() {
          Server.registerContributions(
            {
              routes: {
                "global-services": new Hono().get("/feature-operation", async (c) => {
                  const enabled = Features.enabled("fixture-strategy")
                  if (first) {
                    first = false
                    started()
                    await paused
                  }
                  return c.json({ strategy: enabled ? "new" : "current" })
                }),
              },
            },
            "fixture",
          )
        },
      },
    ]),
  })
  await runtime.run(async () => {
    const app = Server.App()
    const running = app.request("/feature-operation")
    try {
      await admitted
      const save = await app.request("/config/domains/features", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { features: { optIn: ["fixture-strategy"] } } }),
      })
      expect(save.status).toBe(200)
      release()
      expect(await (await running).json()).toEqual({ strategy: "current" })
      expect(await (await app.request("/feature-operation")).json()).toEqual({ strategy: "new" })
      const catalog = await (await app.request("/global/features")).json()
      expect(catalog.find((item: { id: string }) => item.id === "fixture-strategy")).toMatchObject({
        enabled: true,
        pendingRestart: false,
      })
      const spec = await Server.openapi()
      expect(spec.paths?.["/global/features"]?.get?.operationId).toBe("global.features")
    } finally {
      release()
    }
  })
}, 15_000)
