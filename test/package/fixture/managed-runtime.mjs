import assert from "node:assert/strict"
import path from "node:path"
import { createSynergy } from "@ericsanchezok/synergy-sdk"

const version = process.env.SYNERGY_FIXTURE_VERSION
const web = process.env.SYNERGY_FIXTURE_WEB === "1"
const selected = { server: version, [web ? "web-app" : "mcp"]: version }
const { client, server } = await createSynergy({
  mode: "managed",
  executable: process.env.SYNERGY_BUN_EXECUTABLE,
  args: [path.join(process.cwd(), "node_modules/.bin/synergy")],
  version,
  home: process.env.SYNERGY_RUNTIME_ROOT,
  components: selected,
  timeout: 120_000,
  config: { execution: { agentWorkerMinIdle: 0 }, logLevel: "ERROR" },
  client: { scopeID: "home" },
})
try {
  assert.equal(server.owned, true)
  const capabilities = await client.global.capabilities({ throwOnError: true })
  assert.deepEqual(
    capabilities.data.components.map((item) => item.id).sort(),
    ["local-runtime", "plugin-host", ...Object.keys(selected)].sort(),
  )
  const denied = await fetch(`${server.url}/global/capabilities`)
  assert.equal(denied.status, 401)
  const attached = await createSynergy({
    mode: "attach",
    url: server.url,
    headers: server.headers,
    version,
    components: selected,
    client: { scopeID: "home" },
  })
  const session = await attached.client.session.create({ title: "Installed Node SDK" }, { throwOnError: true })
  assert.equal(session.data.title, "Installed Node SDK")
  assert.equal(attached.server.owned, false)
  await attached.server.close()
  assert.equal((await client.global.health({ throwOnError: true })).data.healthy, true)
  if (web) {
    const response = await fetch(server.url, { headers: server.headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<!doctype html>/i)
  }
} finally {
  await server.close()
  await server.close()
}
await assert.rejects(fetch(`${server.url}/global/health`))
console.log(`PASS installed Node managed/attach ${web ? "Web" : "MCP"}: exact composition, auth, session, ownership`)
