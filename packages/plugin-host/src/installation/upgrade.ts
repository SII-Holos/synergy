import path from "node:path"
import { computeManifestHash } from "@ericsanchezok/synergy-plugin/integrity"
import { PluginActivationJournal } from "./activation-journal"
import { ASSEMBLY_PRESET_IDS, PRESET_IDS, presetPackage } from "./catalog"
import { readPluginManifest } from "./plugin-manifest"
import type { InstalledGeneration } from "./generations"
import type { prepareInstallation } from "./manager"
import { legacyComponentSelections, retiredIdentityPackages } from "./selection-upgrade"

const official = new Set([
  ...ASSEMBLY_PRESET_IDS.map((id) => `@ericsanchezok/synergy-${id}`),
  ...PRESET_IDS.flatMap((id) => {
    const preset = presetPackage(id, "local")
    return [preset.name, ...Object.keys(preset.dependencies)]
  }),
])

export function upgradeInstallationRoots(previous: InstalledGeneration, version: string) {
  const roots = Object.fromEntries(
    Object.entries(previous.roots).map(([name, spec]) => [
      name,
      official.has(name) && spec === previous.hostVersion ? version : spec,
    ]),
  )
  for (const [name, replacement] of Object.entries(legacyComponentSelections)) {
    if (!(name in roots) || previous.packages[name]?.metadata?.kind !== "component") continue
    delete roots[name]
    for (const leaf of replacement) roots[leaf] ??= version
  }
  for (const name of retiredIdentityPackages) delete roots[name]
  return roots
}

export async function preservePluginActivation(plan: Awaited<ReturnType<typeof prepareInstallation>>, version: string) {
  const plugins = Object.entries(plan.packages).filter(([, pkg]) => pkg.metadata?.kind === "plugin")
  if (!plugins.length) return
  if (!plan.previous?.files["plugin-activation.json"])
    throw new Error("Installed plugins need reviewed activation before upgrading the core")
  const previous = PluginActivationJournal.parse(
    await Bun.file(path.join(plan.previous.directory, "plugin-activation.json")).json(),
  )
  const installs = []
  for (const [name, pkg] of plugins) {
    const approved = previous.installs.find((item) => item.name === name)
    const before = plan.previous.packages[name]
    if (
      !approved ||
      before?.version !== pkg.version ||
      JSON.stringify(before.metadata) !== JSON.stringify(pkg.metadata)
    )
      throw new Error(`Plugin ${name} must be reviewed before upgrading the core`)
    if (pkg.metadata?.kind !== "plugin") continue
    const manifest = await readPluginManifest(path.join(plan.directory, pkg.directory), version, pkg.metadata.manifest)
    if (computeManifestHash(manifest) !== approved.manifestHash)
      throw new Error(`Plugin ${name} changed during core upgrade`)
    installs.push(approved)
  }
  await Bun.write(
    path.join(plan.directory, "plugin-activation.json"),
    JSON.stringify({ version: 1, installs, removes: [] }),
  )
}
