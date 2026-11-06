import { expect, test } from "bun:test"
import path from "node:path"
import { compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { testRuntime } from "../support/runtime"
import { InstallationGenerations } from "../../src/installation/generations"
import { prepareInstallation } from "../../src/installation/manager"
import { activateInstalledPlugins, preparePluginActivation } from "../../src/installation/plugin-activation"
import { expandLegacyComponentSelection, legacyComponentSelections } from "../../src/installation/selection-upgrade"
import { preservePluginActivation, upgradeInstallationRoots } from "../../src/installation/upgrade"
import { getApproval } from "../../src/plugin/consent/approval-store"
import * as Lockfile from "../../src/plugin/lockfile"

test("legacy Connections retains its Channel workflow integrations without adding them to standalone Workflows", () => {
  const connections = expandLegacyComponentSelection(["@ericsanchezok/synergy-connections"])
  const workflows = expandLegacyComponentSelection(["@ericsanchezok/synergy-workflows"])
  for (const id of ["channel-blueprint", "channel-light-loop", "channel-lattice"]) {
    expect(connections).toContain(`@ericsanchezok/synergy-${id}`)
    expect(workflows).not.toContain(`@ericsanchezok/synergy-${id}`)
  }
})

for (const aggregate of ["@ericsanchezok/synergy-workflows", "@ericsanchezok/synergy-connections"]) {
  test(`${aggregate} selection replacement retains API4 grants, locks and generations across retry, removal and reinstall`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const root = RuntimeContext.current().host.root
      async function archive(name: string, id: string, plugin = false) {
        const manifest = plugin
          ? compilePluginManifest(
              definePlugin({ id, version: "2.0.0", description: "Retained plugin", contributions: [] }),
              { generation: "retained-generation" },
            )
          : undefined
        const files = {
          "package/package.json": JSON.stringify({
            name,
            version: "2.0.0",
            type: "module",
            ...(!plugin
              ? {
                  synergy: {
                    formatVersion: 1,
                    kind: "component",
                    id,
                    version: "2.0.0",
                    compatibility: { synergy: ">=2.0.0" },
                    apiVersion: 1,
                    entry: "./component.js",
                    export: "component",
                  },
                }
              : {}),
          }),
          "package/component.js": "throw new Error('Installation must not evaluate components')",
          ...(manifest ? { "package/plugin.json": JSON.stringify(manifest) } : {}),
        }
        const file = path.join(root, "fixture", id + ".tgz")
        await Bun.write(file, Bun.gzipSync(await new Bun.Archive(files).bytes()))
        return file
      }
      const pluginID = "retained-plugin"
      await using initial = await prepareInstallation(root, {
        hostVersion: "local",
        sources: [
          await archive(aggregate, "workflows"),
          await archive(pluginID, pluginID, true),
          await archive("@ericsanchezok/synergy-holos", "holos"),
          await archive("@ericsanchezok/synergy-channel-clarus", "channel-clarus"),
        ],
      })
      await preparePluginActivation(initial, async () => true)
      const first = await initial.commit({ trustHostCode: true })
      await activateInstalledPlugins(first)
      const approval = await getApproval(pluginID)
      const originalPlugin = (await Lockfile.read()).plugins[pluginID]
      const roots = upgradeInstallationRoots(first, "local")
      expect(roots[pluginID]).toBe(first.roots[pluginID])
      expect(roots[aggregate]).toBeUndefined()
      expect(roots["@ericsanchezok/synergy-holos"]).toBeUndefined()
      expect(roots["@ericsanchezok/synergy-channel-clarus"]).toBeUndefined()
      const sources = await Promise.all(
        legacyComponentSelections[aggregate]
          .filter((name) => name in roots)
          .map((name) => archive(name, name.split("synergy-")[1])),
      )
      {
        await using interrupted = await prepareInstallation(root, {
          hostVersion: "local",
          sources,
          remove: [aggregate, "@ericsanchezok/synergy-holos", "@ericsanchezok/synergy-channel-clarus"],
        })
        await preservePluginActivation(interrupted, "local")
        expect((await InstallationGenerations.current(root))?.id).toBe(first.id)
        expect(await getApproval(pluginID)).toEqual(approval)
      }
      await using retry = await prepareInstallation(root, {
        hostVersion: "local",
        sources,
        remove: [aggregate, "@ericsanchezok/synergy-holos", "@ericsanchezok/synergy-channel-clarus"],
      })
      await preservePluginActivation(retry, "local")
      const upgraded = await retry.commit({ trustHostCode: true })
      await activateInstalledPlugins(upgraded)
      expect(Object.keys(upgraded.roots).sort()).toEqual(Object.keys(roots).sort())
      expect(upgraded.roots[pluginID]).toBe(first.roots[pluginID])
      expect(upgraded.files["bun.lock"] ?? upgraded.files["bun.lockb"]).toBeDefined()
      const { resolved: previousResolved, spec: previousSpec, ...originalIdentity } = originalPlugin
      expect((await Lockfile.read()).plugins[pluginID]).toMatchObject(originalIdentity)
      expect((await Lockfile.read()).plugins[pluginID].resolved).not.toBe(previousResolved)
      expect(previousSpec).toContain(first.id)
      expect((await getApproval(pluginID))?.grant).toEqual(approval?.grant)
      const removable = "@ericsanchezok/synergy-blueprint"
      await using removed = await prepareInstallation(root, { hostVersion: "local", remove: [removable] })
      await preservePluginActivation(removed, "local")
      await activateInstalledPlugins(await removed.commit({ trustHostCode: true }))
      await using reinstall = await prepareInstallation(root, {
        hostVersion: "local",
        sources: [await archive(removable, "blueprint")],
      })
      await preservePluginActivation(reinstall, "local")
      const restored = await reinstall.commit({ trustHostCode: true })
      await activateInstalledPlugins(restored)
      expect(restored.packages[removable]?.metadata?.id).toBe("blueprint")
      expect((await getApproval(pluginID))?.grant).toEqual(approval?.grant)
      expect((await InstallationGenerations.pin(root, { id: first.id, sha256: first.sha256 })).roots).toEqual(
        first.roots,
      )
    })
  }, 30_000)
}
