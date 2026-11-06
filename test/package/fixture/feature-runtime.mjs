import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import { createSynergy } from "@ericsanchezok/synergy-sdk"

const version = process.env.SYNERGY_FIXTURE_VERSION
const home = process.env.SYNERGY_RUNTIME_ROOT
const components = Object.fromEntries(
  ["server", "workbench", "boss", "lattice", "channel-feishu", "boss-feishu", "channel-lattice"].map((id) => [
    id,
    version,
  ]),
)
const experiments = ["boss", "lattice", "kanban"]
const business = path.join(home, "config/synergy.d/120-runtime.jsonc")
await fs.mkdir(path.dirname(business), { recursive: true })
await fs.writeFile(business, JSON.stringify({ boss: { enabled: true, identityText: "Retained configuration" } }))
let history
for (const enabled of [false, true, false]) {
  const { client, server } = await createSynergy({
    mode: "managed",
    executable: process.env.SYNERGY_BUN_EXECUTABLE,
    args: [path.join(process.cwd(), "node_modules/.bin/synergy")],
    version,
    home,
    components,
    timeout: 120_000,
    config: { execution: { agentWorkers: 1, agentWorkerMinIdle: 1 }, logLevel: "ERROR" },
    client: { scopeID: "home" },
  })
  try {
    const deadline = Date.now() + 30_000
    let workers
    do {
      const response = await client.performance.summary()
      if (response.error && response.error.code !== "PERF_STORAGE_UNAVAILABLE") throw response.error
      workers = response.data?.runtime.execution?.agentWorkers
      if (workers?.ready === 1) break
      await setTimeout(250)
    } while (Date.now() < deadline)
    assert.equal(workers?.ready, 1, "The installed agent worker must start with the parent's feature plan")
    const capabilities = (await client.global.capabilities({ throwOnError: true })).data
    const catalog = (await client.global.features({ throwOnError: true })).data
    for (const id of experiments) {
      assert.equal(capabilities.features.includes(id), enabled, id)
      assert.equal(catalog.find((item) => item.id === id).available, true, id)
      assert.equal(catalog.find((item) => item.id === id).pendingRestart, false, id)
    }
    for (const id of ["boss", "lattice", "boss-feishu", "channel-lattice"])
      assert.equal(
        capabilities.components.some((component) => component.id === id),
        enabled,
        id,
      )
    for (const id of ["workbench", "blueprint", "channel-feishu", "channels", "library"])
      assert.equal(capabilities.features.includes(id), true, id)
    assert.equal((await client.tool.ids(undefined, { throwOnError: true })).data.includes("boss_assign"), enabled)
    assert.equal(
      (await client.app.agents(undefined, { throwOnError: true })).data.some((agent) => agent.name === "boss-synergy"),
      enabled,
    )
    if (!enabled) {
      for (const endpoint of ["/boss", "/lattice"])
        assert.equal((await fetch(server.url + endpoint, { headers: server.headers })).status, 404)
      await client.config.import.apply(
        {
          configDomainImportApplyInput: {
            config: { compaction: { auto: false } },
            only: ["runtime"],
            mode: "replace-domain",
            yes: true,
          },
        },
        { throwOnError: true },
      )
    }
    if (!history)
      history = (await client.session.create({ title: "Retained experimental history" }, { throwOnError: true })).data
        .id
    else
      assert.equal(
        (await client.session.get({ sessionID: history }, { throwOnError: true })).data.title,
        "Retained experimental history",
      )
    await client.config.domain.update(
      { domain: "features", configDomainUpdateInput: { config: { features: { optIn: enabled ? [] : experiments } } } },
      { throwOnError: true },
    )
    const pending = (await client.global.features({ throwOnError: true })).data
    for (const id of experiments) {
      assert.equal(pending.find((item) => item.id === id).enabled, enabled)
      assert.equal(pending.find((item) => item.id === id).pendingRestart, true)
    }
    assert.deepEqual(JSON.parse(await fs.readFile(business, "utf8")).boss, {
      enabled: true,
      identityText: "Retained configuration",
    })
  } finally {
    await server.close()
  }
  assert.throws(() => process.kill(server.pid, 0), { code: "ESRCH" })
}
console.log(
  "PASS installed experiments: managed selection, pinned workers, default off, bridges, pending restart, re-enable, history and business config",
)
