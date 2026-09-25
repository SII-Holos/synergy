import { expect, test } from "bun:test"
import { openAgentRuntime } from "../src"
import { lsp } from "@ericsanchezok/synergy-lsp/component"
import { formatter } from "@ericsanchezok/synergy-formatter/component"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"

test("embedding selects only explicit components and isolates clients across two homes", async () => {
  await using a = await runtimeHome()
  await using b = await runtimeHome()
  await using first = await openAgentRuntime({ home: a.host.root, host: a.host, components: [lsp()] })
  await using second = await openAgentRuntime({ home: b.host.root, host: b.host, components: [formatter()] })
  expect(first.components.map((component) => component.id)).toEqual(["local-runtime", "lsp", "plugin-host"])
  first.run(() => {
    expect("lsp" in Config.Info.shape).toBe(true)
    expect("formatter" in Config.Info.shape).toBe(false)
    expect("mcp" in Config.Info.shape).toBe(false)
  })
  second.run(() => {
    expect("formatter" in Config.Info.shape).toBe(true)
    expect("lsp" in Config.Info.shape).toBe(false)
  })
  const aClient = first.client({ directory: a.host.home })
  const bClient = second.client({ directory: b.host.home })
  const aSession = (await aClient.session.create({ title: "first" })).data
  const bSession = (await bClient.session.create({ title: "second" })).data
  expect(aSession.id).not.toBe(bSession.id)
  expect((await aClient.session.list()).data.data.map((session) => session.id)).toEqual([aSession.id])
  expect((await bClient.session.list()).data.data.map((session) => session.id)).toEqual([bSession.id])
  await first.close()
  expect((await bClient.session.list()).data.data).toHaveLength(1)
  expect(() => first.run(() => undefined)).toThrow("closed")
}, 30_000)

test("component graph rejection happens before creating the requested runtime home", async () => {
  await using fixture = await runtimeHome()
  const home = `${fixture.host.root}/unopened`
  await expect(openAgentRuntime({ home, components: [lsp(), lsp()] })).rejects.toThrow("Duplicate component")
  expect(await Bun.file(`${home}/authority.sqlite`).exists()).toBe(false)
})
