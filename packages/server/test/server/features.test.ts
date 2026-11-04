import { expect, test } from "bun:test"
import { Hono } from "hono"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { Features } from "@ericsanchezok/synergy-harness/lifecycle/features"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { Server } from "../../src/server/server"
import { server } from "../../src/component"
import { registerHttp } from "../../src/http"

test.each([false, true])(
  "long-term summary stays unavailable without its owner (other feature selected: %s)",
  async (otherSelected) => {
    const components: RuntimeComponent[] = [{ id: "server", apiVersion: 1, version: "1.0.0", register: registerHttp }]
    if (otherSelected)
      components.push({
        id: "fixture",
        apiVersion: 1,
        version: "1.0.0",
        features: {
          kind: "product",
          definitions: [
            {
              id: "fixture-ui",
              owner: "fixture",
              maturity: "stable",
              activation: "restart",
              name: "Fixture",
              description: "Selected HTTP feature",
            },
          ],
        },
        register() {
          Server.registerContributions({ features: ["fixture-ui"] }, "fixture")
        },
      })
    await using runtime = await testRuntime({
      composition: RuntimeComponents.compose(
        components,
        FeatureSelection.resolve(components, { optIn: ["session-long-term-memory"] }),
      ),
    })
    await runtime.run(async () => {
      await Config.domainUpdate("features", { features: { optIn: ["session-long-term-memory"] } })
      const response = await Server.App().request("/global/capabilities")
      expect(response.status).toBe(200)
      const capabilities = await response.json()
      expect(capabilities.features).toEqual(otherSelected ? ["fixture-ui"] : [])
      expect(capabilities.components.map((component: { id: string }) => component.id).sort()).toEqual(
        otherSelected ? ["fixture", "server"] : ["server"],
      )
      expect(Features.enabled("session-long-term-memory")).toBe(false)
      const catalog = await (await Server.App().request("/global/features")).json()
      expect(catalog.find((feature: { id: string }) => feature.id === "session-long-term-memory")).toMatchObject({
        selected: true,
        available: false,
        enabled: false,
        pendingRestart: false,
        reason: "not-installed",
      })
    })
  },
)

test("long-term summary HTTP capability follows live feature selection without Workbench", async () => {
  await using runtime = await testRuntime({
    composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), server()]),
  })
  await runtime.run(async () => {
    const app = Server.App()
    const capabilities = async () => {
      const response = await app.request("/global/capabilities")
      expect(response.status).toBe(200)
      return response.json()
    }
    const initial = await capabilities()
    expect(initial.features).not.toContain("session-long-term-memory")
    expect(initial.components.map((component: { id: string }) => component.id).sort()).toEqual([
      "local-runtime",
      "server",
    ])
    for (const enabled of [true, false, true]) {
      const response = await app.request("/config/domains/features", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { features: { optIn: enabled ? ["session-long-term-memory"] : [] } } }),
      })
      expect(response.status).toBe(200)
      expect(Features.enabled("session-long-term-memory")).toBe(enabled)
      expect((await capabilities()).features.includes("session-long-term-memory")).toBe(enabled)
      const catalog = await (await app.request("/global/features")).json()
      expect(catalog.find((feature: { id: string }) => feature.id === "session-long-term-memory")).toMatchObject({
        enabled,
        pendingRestart: false,
        definition: { activation: "live", owner: "local-runtime" },
      })
    }
  })
})

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
