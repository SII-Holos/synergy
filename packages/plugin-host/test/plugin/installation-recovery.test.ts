import { expect, spyOn, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { PluginInstallationRecovery } from "../../src/plugin/installation-recovery"
import * as Lockfile from "../../src/plugin/lockfile"

test("restart recovery restores an interrupted installation without discarding unrelated metadata", async () => {
  const before = await Config.domainGet("plugins")
  const lockfile = await Lockfile.read()
  const next = { ...before, plugin: [...(before.plugin ?? []), "npm:interrupted"] }
  try {
    await PluginInstallationRecovery.begin("interrupted", next)
    await Config.domainUpdate("plugins", next, { mode: "replace-domain" })
    await Storage.write(["plugin-lock", "info"], { version: 2, unrelatedOwner: { retained: true } })
    await PluginInstallationRecovery.recover()
    expect(await Config.domainGet("plugins")).toEqual(before)
    expect(await Storage.read<{ unrelatedOwner: { retained: boolean } }>(["plugin-lock", "info"])).toMatchObject({
      unrelatedOwner: { retained: true },
    })
    expect(await Storage.list(["plugin-install-intents"])).toEqual([])
    await PluginInstallationRecovery.recover()
  } finally {
    await Config.domainUpdate("plugins", before, { mode: "replace-domain" })
    await Lockfile.write(lockfile)
  }
})

test("completed installation cleanup resumes without rolling back committed configuration", async () => {
  const before = await Config.domainGet("plugins")
  const next = { ...before, plugin: [...(before.plugin ?? []), "npm:completed"] }
  try {
    const intent = await PluginInstallationRecovery.begin("completed", next)
    await Config.domainUpdate("plugins", next, { mode: "replace-domain" })
    const remove = Storage.remove
    {
      using failure = spyOn(Storage, "remove").mockImplementation(async (key) => {
        if (key[0] === "plugin-install-intents") throw new Error("cleanup interrupted")
        return remove(key)
      })
      await expect(intent.finish()).rejects.toThrow("cleanup interrupted")
    }
    await PluginInstallationRecovery.recover()
    expect(await Config.domainGet("plugins")).toEqual(next)
    expect(await Storage.list(["plugin-install-intents"])).toEqual([])
  } finally {
    await Config.domainUpdate("plugins", before, { mode: "replace-domain" })
  }
})
