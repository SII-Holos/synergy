import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Server } from "../../src/server/server"

test("capabilities are global and report only the components selected for that runtime", async () => {
  const component = (id: string) => ({ id, apiVersion: 1 as const, version: "1.0.0", register() {} })
  const open = (ids: string[]) =>
    testRuntime({
      composition: RuntimeComponents.compose([
        { ...component("local-runtime"), register: registerLocalRuntime },
        ...ids.map(component),
      ]),
    })
  await using core = await open([])
  await using extended = await open(["mcp", "lsp"])
  const response = await core.run(() => Server.App().request("/global/capabilities"))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    apiVersion: 1,
    components: [{ id: "local-runtime", version: "1.0.0", apiVersion: 1 }],
  })
  const selected = await extended.run(async () => (await Server.App().request("/global/capabilities")).json())
  expect(selected.components.map((item: { id: string }) => item.id).sort()).toEqual(["local-runtime", "lsp", "mcp"])
})

test("managed runtime credentials protect every HTTP route without changing a separately owned runtime", async () => {
  await using runtime = await testRuntime({
    env: { SYNERGY_SERVER_TOKEN: "test-runtime-secret" },
    composition: { register: registerLocalRuntime },
  })
  await runtime.run(async () => {
    const app = Server.App()
    expect((await app.request("/global/capabilities")).status).toBe(401)
    expect((await app.request("/global/health", { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    expect(
      (await app.request("/global/capabilities", { headers: { authorization: "Bearer test-runtime-secret" } })).status,
    ).toBe(200)
  })
})
