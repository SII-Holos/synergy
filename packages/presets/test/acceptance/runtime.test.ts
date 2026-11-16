import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { acceptanceRuntime, prepareRuntime } from "../../script/acceptance/runtime"
import { fixtureSettings } from "./support"
import { Environment } from "@ericsanchezok/synergy-harness/environment"

test("an invalid frozen catalog cannot silently fall back to the controller's bundled catalog", async () => {
  await using tmp = await tmpdir()
  const catalog = path.join(tmp.path, "catalog.json")
  await Bun.write(catalog, "{}")
  await expect(
    prepareRuntime(
      tmp.path,
      {
        providerID: "fixture",
        modelID: "model",
        upstream: "https://example.test",
        apiKeyFile: "unused",
        modelCatalog: catalog,
        config: {},
        deadlineMs: 1000,
      },
      { url: "http://127.0.0.1:1/v1", token: "fixture" },
    ),
  ).rejects.toThrow("Frozen model catalog")
})

test("acceptance Runtime returns its composed opaque Host origin without making a model request", async () => {
  await using tmp = await tmpdir()
  let calls = 0
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      return new Response(null, { status: 500 })
    },
  })
  const settings = await fixtureSettings(tmp.path, provider.url.href)
  await using host = await acceptanceRuntime(path.join(tmp.path, "runtime"), settings)
  await host.runtime.run(async () => {
    const environment = await Environment.bind({ scopeID: "home", ownerID: "fixture", provider: "native", spec: {} })
    const lease = await Environment.acquire(environment.id, {
      scopeID: "home",
      useID: "controlled-observation",
      ownership: host.origin("controlled-observation"),
      capabilities: ["exec"],
    })
    try {
      expect(await Environment.uses(environment.id)).toMatchObject([
        {
          ownership: {
            kind: "admission",
            origin: { kind: "host", owner: "acceptance-controller", invocationID: "controlled-observation" },
          },
        },
      ])
      expect(calls).toBe(0)
    } finally {
      await lease.release()
    }
    expect(await Environment.uses(environment.id)).toEqual([])
  })
}, 30_000)
