import assert from "node:assert/strict"
import path from "node:path"
import { createComputerRoute } from "@ericsanchezok/synergy-computer-runtime/routes/computer-route"

const { assertInstalledPackageBoundaries } = await import("./package-boundary")
await assertInstalledPackageBoundaries()

const route = createComputerRoute()
assert.ok(route.routes.some((entry) => entry.method === "GET" && entry.path === "/computer/host/broker"))
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: route.fetch })
try {
  assert.equal((await fetch(new URL("/missing", server.url))).status, 404)
  for (const owner of ["server", "product-runtime", "library", "browser-runtime", "plugin-host"]) {
    assert.equal(
      await Bun.file(path.join("node_modules/@ericsanchezok", `synergy-${owner}/package.json`)).exists(),
      false,
    )
  }
} finally {
  await server.stop(true)
}
console.log(JSON.stringify({ mode: "computer", executed: true, closed: true }))
