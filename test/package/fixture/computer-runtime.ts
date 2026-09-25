import assert from "node:assert/strict"
import path from "node:path"
import { createComputerRoute } from "@ericsanchezok/synergy-computer-runtime/routes/computer-route"

const { assertInstalledPackageBoundaries } = await import("./package-boundary")
await assertInstalledPackageBoundaries()

const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
const home = process.env.SYNERGY_HOME!
const context = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: process.env })
const route = context.run(() => createComputerRoute())
assert.ok(route.routes.some((entry) => entry.method === "GET" && entry.path === "/computer/host/broker"))
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: context.bind(route.fetch) })
try {
  assert.equal((await fetch(new URL("/missing", server.url))).status, 404)
  for (const owner of ["server", "presets", "library", "browser-runtime", "plugin-host"]) {
    assert.equal(
      await Bun.file(path.join("node_modules/@ericsanchezok", `synergy-${owner}/package.json`)).exists(),
      false,
    )
  }
} finally {
  await server.stop(true)
  context.dispose()
}
console.log(JSON.stringify({ mode: "computer", executed: true, closed: true }))
