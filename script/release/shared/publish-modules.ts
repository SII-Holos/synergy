import path from "node:path"
import { $ } from "bun"
import { readPackedArchives, type PackedArchive } from "../../package-install-check"
import { DESKTOP_APP_PACKAGE, NPM_REGISTRY, PRESETS_DIST_DIR } from "./packages"
import { npmAuthArgs, npmEnsureDistTag, npmVersionExists, retry, waitForNpmVersion } from "./runtime"

export function modulePublishOrder(archives: PackedArchive[], deferred: string[] = []) {
  const byName = new Map(archives.map((pkg) => [pkg.name, pkg]))
  if (byName.size !== archives.length) throw new Error("Duplicate module publication identity")
  const ordered: PackedArchive[] = []
  const visited = new Set<string>()
  const active = new Set<string>()
  function visit(pkg: PackedArchive) {
    if (visited.has(pkg.name)) return
    if (active.has(pkg.name)) throw new Error(`Module publication dependency cycle: ${pkg.name}`)
    active.add(pkg.name)
    const dependencies = {
      ...(pkg.manifest.dependencies as Record<string, string> | undefined),
      ...(pkg.manifest.optionalDependencies as Record<string, string> | undefined),
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (!name.startsWith("@ericsanchezok/synergy-")) continue
      const dependency = byName.get(name)
      if (!dependency && deferred.includes(name)) continue
      if (!dependency) throw new Error(`Missing module publication dependency: ${pkg.name} -> ${name}`)
      if (dependency.version !== version) throw new Error(`Module publication version mismatch: ${name}@${version}`)
      visit(dependency)
    }
    active.delete(pkg.name)
    visited.add(pkg.name)
    ordered.push(pkg)
  }
  for (const pkg of archives) visit(pkg)
  return ordered
}

export async function publishPackedArchive(pkg: Pick<PackedArchive, "name" | "version" | "archive">, channel: string) {
  if (!(await npmVersionExists(pkg.name, pkg.version))) {
    const auth = npmAuthArgs()
    await retry(() => $`npm publish ${pkg.archive} --registry ${NPM_REGISTRY} --tag ${channel} --access public ${auth}`)
  }
  if (!(await waitForNpmVersion(pkg.name, pkg.version)))
    throw new Error(`Published module is not available: ${pkg.name}@${pkg.version}`)
  await npmEnsureDistTag(pkg.name, pkg.version, channel)
}

export async function publishModuleCandidates(version: string, channel: string) {
  const archives = await readPackedArchives(path.join(PRESETS_DIST_DIR, "modules-packages"))
  if (!archives.length) throw new Error("No runtime module archives were built")
  const ordered = modulePublishOrder(archives, [DESKTOP_APP_PACKAGE])
  for (const pkg of ordered) {
    if (pkg.version !== version) throw new Error(`Stale module publication version: ${pkg.name}@${pkg.version}`)
    await publishPackedArchive(pkg, channel)
  }
  return ordered.map((pkg) => pkg.name)
}
