import { expect, test } from "bun:test"
import { createSynergy } from "@ericsanchezok/synergy-sdk"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { fileURLToPath } from "node:url"
import { version } from "../../package.json" with { type: "json" }

test("the public SDK owns an authenticated real source runtime and drains its data home on close", async () => {
  await using fixture = await runtimeHome()
  const options = {
    mode: "managed" as const,
    executable: process.execPath,
    args: ["--conditions=browser", fileURLToPath(new URL("../../src/index.ts", import.meta.url))],
    version: "local",
    home: fixture.host.root,
    components: { server: version },
    timeout: 30_000,
    client: { scopeID: "home" },
  }
  const { server, client } = await createSynergy(options)
  try {
    expect(server.ready?.home).toBe(fixture.host.root)
    expect((await fetch(`${server.url}/global/health`)).status).toBe(401)
    expect((await client.global.health()).data?.healthy).toBe(true)
    expect((await client.global.capabilities()).data?.components.some((item) => item.id === "server")).toBe(true)
    expect((await client.session.list()).error).toBeUndefined()
  } finally {
    await server.close()
  }
  const reopened = await createSynergy(options)
  await reopened.server.close()
}, 65_000)
