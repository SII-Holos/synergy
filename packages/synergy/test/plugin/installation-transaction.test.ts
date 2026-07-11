import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { readApprovals, writeApprovals, type PluginApprovalRecord } from "../../src/plugin/consent/approval-store"
import { IncompatiblePluginStore } from "../../src/plugin/incompatible-store"
import { PluginInstallationTransaction, selectPluginRegistrationSpecs } from "../../src/plugin/installation-transaction"
import * as Lockfile from "../../src/plugin/lockfile"

describe("plugin uninstall registration selection", () => {
  test("removes every duplicate of an explicitly registered spec", async () => {
    const target = "file:///plugins/focus"
    const result = await selectPluginRegistrationSpecs({
      pluginId: "focus",
      specs: [target, "npm:other", target],
      knownSpecs: [target],
      resolvePluginId: async () => null,
    })

    expect(result).toEqual({
      kept: ["npm:other"],
      removed: [target, target],
    })
  })

  test("removes every configured spec that resolves to the same plugin id", async () => {
    const ids = new Map([
      ["file:///plugins/focus", "focus"],
      ["file:///archives/focus.tgz", "focus"],
      ["npm:other", "other"],
    ])
    const result = await selectPluginRegistrationSpecs({
      pluginId: "focus",
      specs: [...ids.keys()],
      knownSpecs: [],
      resolvePluginId: async (spec) => ids.get(spec) ?? null,
    })

    expect(result).toEqual({
      kept: ["npm:other"],
      removed: ["file:///plugins/focus", "file:///archives/focus.tgz"],
    })
  })

  test("does not remove unrelated unresolved registrations", async () => {
    const result = await selectPluginRegistrationSpecs({
      pluginId: "focus",
      specs: ["file:///broken-one", "file:///broken-two"],
      knownSpecs: ["file:///broken-one"],
      resolvePluginId: async () => null,
    })

    expect(result).toEqual({
      kept: ["file:///broken-two"],
      removed: ["file:///broken-one"],
    })
  })
})

function approval(pluginId: string): PluginApprovalRecord {
  return {
    pluginId,
    source: "official",
    version: "1.0.0",
    manifestHash: "manifest",
    capabilitiesHash: "capabilities",
    approvedAt: 1,
    approvedBy: "user",
    trustTier: "declarative",
    approvedCapabilities: [],
    risk: "low",
    status: "approved",
  }
}

describe("plugin uninstall transaction", () => {
  test("removes config, lock, approval and incompatible records as one plugin identity", async () => {
    const pluginId = `remove-${crypto.randomUUID()}`
    const archive = `file:///${pluginId}.tgz`
    const duplicate = `file:///${pluginId}-copy.tgz`
    const unrelated = "npm:unrelated"
    const previousDomain = await Config.domainGet("plugins")
    const previousLockfile = await Lockfile.read()
    const previousApprovals = await readApprovals()
    const previousIncompatible = await IncompatiblePluginStore.read()
    let prepared = 0
    try {
      await Config.domainUpdate(
        "plugins",
        {
          ...previousDomain,
          plugin: [...(previousDomain.plugin ?? []), archive, archive, duplicate, unrelated],
          pluginConfig: { ...(previousDomain.pluginConfig ?? {}), [pluginId]: { enabled: true } },
        },
        { mode: "replace-domain" },
      )
      const locked = Lockfile.addEntry(previousLockfile, pluginId, {
        spec: archive,
        source: "official",
        version: "1.0.0",
        apiVersion: "3.0",
        generation: "generation",
        resolved: archive,
        manifestHash: "manifest",
        approvalId: pluginId,
      })
      locked.plugins[`${pluginId}-old-key`] = {
        ...locked.plugins[pluginId]!,
        spec: duplicate,
      }
      await Lockfile.write(locked)
      await writeApprovals([...previousApprovals, approval(pluginId)])
      await IncompatiblePluginStore.write([
        ...previousIncompatible,
        { pluginId, spec: archive, reason: "reinstallRequired" },
        { pluginId, spec: duplicate, reason: "reinstallRequired" },
      ])

      await PluginInstallationTransaction.remove({
        pluginId,
        knownSpecs: [archive],
        resolvePluginId: async (spec) => (spec === duplicate ? pluginId : null),
        beforeCommit: async () => {
          prepared++
        },
        reload: async () => undefined,
      })

      const domain = await Config.domainGet("plugins")
      expect(domain.plugin).not.toContain(archive)
      expect(domain.plugin).not.toContain(duplicate)
      expect(domain.plugin).toContain(unrelated)
      expect(domain.pluginConfig?.[pluginId]).toBeUndefined()
      expect((await Lockfile.read()).plugins[pluginId]).toBeUndefined()
      expect((await Lockfile.read()).plugins[`${pluginId}-old-key`]).toBeUndefined()
      expect((await readApprovals()).some((record) => record.pluginId === pluginId)).toBe(false)
      expect((await IncompatiblePluginStore.read()).some((record) => record.pluginId === pluginId)).toBe(false)
      expect(prepared).toBe(1)
    } finally {
      await Config.domainUpdate("plugins", previousDomain, { mode: "replace-domain" })
      await Lockfile.write(previousLockfile)
      await writeApprovals(previousApprovals)
      await IncompatiblePluginStore.write(previousIncompatible)
    }
  })

  test("restores every host record when reload fails", async () => {
    const pluginId = `rollback-${crypto.randomUUID()}`
    const spec = `file:///${pluginId}.tgz`
    const previousDomain = await Config.domainGet("plugins")
    const previousLockfile = await Lockfile.read()
    const previousApprovals = await readApprovals()
    const previousIncompatible = await IncompatiblePluginStore.read()
    try {
      const configured = { ...previousDomain, plugin: [...(previousDomain.plugin ?? []), spec] }
      const locked = Lockfile.addEntry(previousLockfile, pluginId, {
        spec,
        source: "local",
        version: "1.0.0",
        apiVersion: "3.0",
        generation: "generation",
        resolved: spec,
        manifestHash: "manifest",
        approvalId: pluginId,
      })
      const approvals = [...previousApprovals, approval(pluginId)]
      const incompatible = [...previousIncompatible, { pluginId, spec, reason: "reinstallRequired" as const }]
      await Config.domainUpdate("plugins", configured, { mode: "replace-domain" })
      await Lockfile.write(locked)
      await writeApprovals(approvals)
      await IncompatiblePluginStore.write(incompatible)

      await expect(
        PluginInstallationTransaction.remove({
          pluginId,
          knownSpecs: [spec],
          resolvePluginId: async () => null,
          reload: async () => {
            throw new Error("reload failed")
          },
        }),
      ).rejects.toThrow("reload failed")

      expect(await Config.domainGet("plugins")).toEqual(configured)
      expect(await Lockfile.read()).toEqual(locked)
      expect(await readApprovals()).toEqual(approvals)
      expect(await IncompatiblePluginStore.read()).toEqual(incompatible)
    } finally {
      await Config.domainUpdate("plugins", previousDomain, { mode: "replace-domain" })
      await Lockfile.write(previousLockfile)
      await writeApprovals(previousApprovals)
      await IncompatiblePluginStore.write(previousIncompatible)
    }
  })

  test("does not touch host records or reload when uninstall preparation fails", async () => {
    const pluginId = `prepare-${crypto.randomUUID()}`
    const spec = `file:///${pluginId}`
    const previousDomain = await Config.domainGet("plugins")
    const configured = { ...previousDomain, plugin: [...(previousDomain.plugin ?? []), spec] }
    let reloads = 0
    try {
      await Config.domainUpdate("plugins", configured, { mode: "replace-domain" })
      await expect(
        PluginInstallationTransaction.remove({
          pluginId,
          knownSpecs: [spec],
          resolvePluginId: async () => null,
          beforeCommit: async () => {
            throw new Error("cleanup failed")
          },
          reload: async () => {
            reloads++
          },
        }),
      ).rejects.toThrow("cleanup failed")

      expect(await Config.domainGet("plugins")).toEqual(configured)
      expect(reloads).toBe(0)
    } finally {
      await Config.domainUpdate("plugins", previousDomain, { mode: "replace-domain" })
    }
  })
})
