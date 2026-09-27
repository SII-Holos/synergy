import path from "node:path"
import { computeManifestHash } from "@ericsanchezok/synergy-plugin/integrity"
import { PluginActivationJournal } from "./activation-journal"
import { FULL_COMPONENTS, PRESET_IDS } from "./catalog"
import { readPluginManifest } from "./plugin-manifest"
import type { InstalledGeneration } from "./generations"
import type { prepareInstallation } from "./manager"

const official = new Set(
  [...FULL_COMPONENTS, ...PRESET_IDS, "web-app", "desktop-app"].map((id) => `@ericsanchezok/synergy-${id}`),
)

export function upgradeInstallationRoots(previous: InstalledGeneration, version: string) {
  return Object.fromEntries(
    Object.entries(previous.roots).map(([name, spec]) => [
      name,
      official.has(name) && spec === previous.hostVersion ? version : spec,
    ]),
  )
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
