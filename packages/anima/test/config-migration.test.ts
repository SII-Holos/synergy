import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { ConfigReferenceMigration } from "@ericsanchezok/synergy-harness/config/reference-migration"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime as harnessRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { disposeLibrary, registerLibrary } from "@ericsanchezok/synergy-library/register"
import { anima } from "../src/component"

function testRuntime(options: Parameters<typeof harnessRuntime>[0]) {
  return harnessRuntime({
    ...options,
    composition: { register() {}, services: () => ({ disposeExtensions: disposeLibrary }) },
  })
}

function register(installed: boolean) {
  registerLibrary()
  if (installed) anima().register()
  ConfigExtensions.completeRegistration()
}

for (const source of ["domain", "legacy"] as const) {
  test(`${source} Anima settings remain dormant until the owner is installed`, async () => {
    await using home = await runtimeHome()
    {
      await using absent = await testRuntime({ home: home.host.home, register: () => register(false) })
      await absent.run(async () => {
        const file =
          source === "domain" ? ConfigDomain.filepath("library") : path.join(Global.Path.config, "synergy.jsonc")
        await Bun.write(file, JSON.stringify({ library: { autonomy: false, memory: { enabled: false } } }))
        expect((await Config.globalResolved()).library).not.toHaveProperty("autonomy")
        expect(Config.Info.shape).not.toHaveProperty("anima")
        await Config.domainUpdate("library", { library: { memory: { enabled: true } } }, { mode: "replace-domain" })
        expect((await Bun.file(ConfigDomain.filepath("library")).json()).library.autonomy).toBe(false)
      })
    }
    {
      await using installed = await testRuntime({ home: home.host.home, register: () => register(true) })
      await installed.run(async () => {
        expect((await Config.globalResolved()).anima).toEqual({ enabled: false })
        expect((await Config.globalResolved()).library).not.toHaveProperty("autonomy")
        expect(Config.diagnostics()).toEqual([])
        const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-anima"])
        expect(receipt["20261012-anima-config-owner"]).toBeGreaterThan(0)
        await Config.domainUpdate("anima", { anima: { enabled: true } })
      })
    }
    {
      await using restored = await testRuntime({ home: home.host.home, register: () => register(true) })
      await restored.run(async () => expect((await Config.globalResolved()).anima).toEqual({ enabled: true }))
    }
  })
}

test("Anima relocation preserves explicit owner settings and retries after a failed target write", async () => {
  await using runtime = await testRuntime({ register: () => register(true) })
  await runtime.run(async () => {
    const source = ConfigDomain.filepath("library")
    const target = ConfigDomain.filepath("anima")
    await Bun.write(
      source,
      '// retained comment\n{ "library": { "autonomy": false, "memory": { "enabled": false } } }\n',
    )
    await fs.mkdir(target, { recursive: true })
    const before = await Bun.file(source).text()
    await expect(ConfigReferenceMigration.file(source)).rejects.toThrow()
    expect(await Bun.file(source).text()).toBe(before)
    await fs.rmdir(target)
    await Bun.write(target, '{ "anima": { "enabled": true } }\n')
    await ConfigReferenceMigration.file(source)
    const after = await Bun.file(source).text()
    expect(after).toContain("retained comment")
    expect(after).not.toContain("autonomy")
    expect(after).not.toContain("anima")
    expect((await Bun.file(target).json()).anima.enabled).toBe(true)
    await ConfigReferenceMigration.file(source)
    expect(await Bun.file(source).text()).toBe(after)
  })
})
