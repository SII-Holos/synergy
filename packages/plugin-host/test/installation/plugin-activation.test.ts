import { expect, test } from "bun:test"
import path from "node:path"
import { definePlugin, compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { testRuntime } from "../support/runtime"
import { prepareInstallation } from "../../src/installation/manager"
import { preparePluginActivation, activateInstalledPlugins } from "../../src/installation/plugin-activation"
import { InstallationGenerations } from "../../src/installation/generations"
import * as Lockfile from "../../src/plugin/lockfile"
import { getApproval } from "../../src/plugin/consent/approval-store"

test("module trust cannot approve API4 plugins, and committed activation recovers idempotently", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const root = RuntimeContext.current().host.root
    const directory = path.join(root, "fixture")
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "activation-fixture", version: "2.0.0" }),
    )
    const manifest = compilePluginManifest(
      definePlugin({
        id: "activation-fixture",
        version: "2.0.0",
        description: "activation fixture",
        contributions: [],
      }),
      { generation: "fixture-generation" },
    )
    await Bun.write(path.join(directory, "plugin.json"), JSON.stringify(manifest))
    await using plan = await prepareInstallation(root, { hostVersion: "local", sources: [directory] })
    await expect(preparePluginActivation(plan, async () => false)).rejects.toThrow("capability approval")
    expect(await InstallationGenerations.current(root)).toBeUndefined()
    expect(await getApproval(manifest.id)).toBeUndefined()
    await preparePluginActivation(plan, async (item) => item.id === manifest.id)
    const generation = await plan.commit({ trustHostCode: true })
    await using pending = await prepareInstallation(root, { hostVersion: "local", remove: [manifest.id] })
    await expect(pending.commit({ trustHostCode: true })).rejects.toThrow("pending plugin activation")
    await activateInstalledPlugins(generation)
    const installed = (await Lockfile.read()).plugins[manifest.id]
    expect(installed.version).toBe("2.0.0")
    expect((await getApproval(manifest.id))?.approvedBy).toBe("user")
    await activateInstalledPlugins(generation)
    expect((await Lockfile.read()).plugins[manifest.id]).toEqual(installed)
    await using removal = await prepareInstallation(root, { hostVersion: "local", remove: [manifest.id] })
    await preparePluginActivation(removal, async () => false)
    await activateInstalledPlugins(await removal.commit({ trustHostCode: true }))
    expect((await Lockfile.read()).plugins[manifest.id]).toBeUndefined()
    await activateInstalledPlugins(generation)
    expect((await Lockfile.read()).plugins[manifest.id]).toBeUndefined()
  })
}, 15_000)
