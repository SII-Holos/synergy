import path from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { computeManifestHash } from "@ericsanchezok/synergy-plugin/integrity"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { Plugin } from "../plugin"
import * as Lockfile from "../plugin/lockfile"
import {
  getApproval,
  createApprovalRecord,
  verifyApproval,
  type PluginApprovalRecord,
} from "../plugin/consent/approval-store"
import { sourceFromSpec } from "../plugin/source"
import { readPluginManifest } from "./plugin-manifest"
import { InstallationGenerations, type InstalledGeneration } from "./generations"
import type { prepareInstallation } from "./manager"
import { withInstallationLock } from "./lock"

import { PluginActivationJournal as Journal } from "./activation-journal"

export async function preparePluginActivation(
  plan: Awaited<ReturnType<typeof prepareInstallation>>,
  approve: (input: {
    id: string
    version: string
    capabilities: string[]
    grant: PluginApprovalRecord["grant"]
  }) => Promise<boolean>,
) {
  const installs: z.infer<typeof Journal>["installs"] = []
  const removes: z.infer<typeof Journal>["removes"] = []
  const lock = await Lockfile.read()
  for (const [name, pkg] of Object.entries(plan.packages)) {
    if (pkg.metadata?.kind !== "plugin") continue
    const manifest = await readPluginManifest(
      path.join(plan.directory, pkg.directory),
      Installation.VERSION,
      pkg.metadata.manifest,
    )
    const source = sourceFromSpec(pkg.spec.startsWith("file:") ? "file://" : pkg.spec)
    let approval = await getApproval(manifest.id)
    if (!approval || !verifyApproval(approval, manifest, undefined, { source })) {
      approval = createApprovalRecord({ pluginId: manifest.id, source, manifest, approvedBy: "user" })
      if (
        !(await approve({
          id: manifest.id,
          version: manifest.version,
          capabilities: approval.approvedCapabilities,
          grant: approval.grant,
        }))
      )
        throw new Error(`Plugin ${manifest.id} requires capability approval`)
    }
    installs.push({ name, source, manifestHash: computeManifestHash(manifest), approval })
  }
  for (const [name, pkg] of Object.entries(plan.previous?.packages ?? {})) {
    if (pkg.metadata?.kind !== "plugin" || plan.packages[name]) continue
    const entry = lock.plugins[pkg.metadata.id]
    const previous = path.join(plan.previous!.directory, pkg.directory)
    if (entry && entry.spec === pathToFileURL(previous).href)
      removes.push({ id: pkg.metadata.id, resolved: entry.resolved })
  }
  if (installs.length || removes.length)
    await Bun.write(
      path.join(plan.directory, "plugin-activation.json"),
      JSON.stringify({ version: 1, installs, removes }),
    )
}

export async function activateInstalledPlugins(generation: InstalledGeneration) {
  const root = RuntimeContext.current().host.root
  return withInstallationLock(path.join(root, "installation-activation"), async () => {
    const current = await InstallationGenerations.current(root)
    if (current?.id !== generation.id) return
    await activate(generation)
    await AtomicFile.writeJsonAtomic(
      path.join(root, "installations", "activated", generation.id + ".json"),
      JSON.stringify(generation.sha256),
      { durable: true, private: true },
    )
  })
}

async function activate(generation: InstalledGeneration) {
  const filename = path.join(generation.directory, "plugin-activation.json")
  if (!(await Bun.file(filename).exists())) return
  const journal = Journal.parse(await Bun.file(filename).json())
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      for (const item of journal.installs) {
        const key = ["installation-activation", generation.id, "install", item.name]
        if ((await Storage.readMany<boolean>([key]))[0]) continue
        const pkg = generation.packages[item.name]
        if (pkg?.metadata?.kind !== "plugin") throw new Error("Plugin activation names an unselected package")
        const pluginDir = path.join(generation.directory, pkg.directory)
        const manifest = await readPluginManifest(pluginDir, generation.hostVersion, pkg.metadata.manifest)
        if (computeManifestHash(manifest) !== item.manifestHash) throw new Error("Approved plugin manifest changed")
        const spec = pathToFileURL(pluginDir).href
        await Plugin.add(spec, {
          source: item.source,
          preApproved: item.approval as PluginApprovalRecord,
          resolved: {
            spec,
            pkg: item.name,
            version: manifest.version,
            source: item.source,
            pluginDir,
            manifest,
            ...(manifest.artifacts.runtime
              ? { entryPath: path.join(pluginDir, manifest.artifacts.runtime.entry) }
              : {}),
          },
        })
        await Storage.write(key, true)
      }
      for (const item of journal.removes) {
        const key = ["installation-activation", generation.id, "remove", item.id]
        if ((await Storage.readMany<boolean>([key]))[0]) continue
        const entry = (await Lockfile.read()).plugins[item.id]
        if (entry?.resolved === item.resolved) await Plugin.remove(item.id)
        await Storage.write(key, true)
      }
    },
  })
}

export async function recoverInstalledPlugins() {
  if (RuntimeContext.current().host.env.SYNERGY_INSTALLATION_ROOT !== RuntimeContext.current().host.root) return
  const raw = RuntimeContext.current().host.env.SYNERGY_INSTALLATION_PIN
  if (!raw) return
  const pin = z.object({ id: z.uuid(), sha256: z.string() }).strict().parse(JSON.parse(raw))
  await activateInstalledPlugins(await InstallationGenerations.pin(RuntimeContext.current().host.root, pin))
}
