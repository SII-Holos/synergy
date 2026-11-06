import path from "node:path"
import { $ } from "bun"
import { readPackedArchives, type PackedArchive } from "../../package-install-check"
import { DESKTOP_APP_PACKAGE, NPM_REGISTRY, PRESETS_DIST_DIR } from "./packages"
import { npmAuthArgs, npmEnsureDistTag, npmVersionExists, retry, waitForNpmVersion } from "./runtime"

export const NPM_ARCHIVE_BUDGET = 190 * 1024 * 1024
const PUBLICATION_CONCURRENCY = 4

export async function assertNpmArchiveSize(pkg: Pick<PackedArchive, "name" | "archive">) {
  const archive = Bun.file(pkg.archive)
  if (!(await archive.exists())) throw new Error(`Missing publication archive: ${pkg.name}`)
  if (archive.size > NPM_ARCHIVE_BUDGET)
    throw new Error(`Publication archive exceeds the ${NPM_ARCHIVE_BUDGET}-byte budget: ${pkg.name} (${archive.size})`)
}

function publicationDependencies(pkg: PackedArchive) {
  return Object.entries({
    ...(pkg.manifest.dependencies as Record<string, string> | undefined),
    ...(pkg.manifest.optionalDependencies as Record<string, string> | undefined),
  }).filter(([name]) => name.startsWith("@ericsanchezok/synergy-"))
}

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
    for (const [name, version] of publicationDependencies(pkg)) {
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
  await assertNpmArchiveSize(pkg)
  if (!(await npmVersionExists(pkg.name, pkg.version))) {
    const auth = npmAuthArgs()
    console.log(`Publishing ${pkg.name}@${pkg.version} to ${channel}`)
    await retry(
      () =>
        $`npm publish ${pkg.archive} --registry ${NPM_REGISTRY} --tag ${channel} --access public --loglevel warn ${auth}`,
    )
  }
  if (!(await waitForNpmVersion(pkg.name, pkg.version)))
    throw new Error(`Published module is not available: ${pkg.name}@${pkg.version}`)
  await npmEnsureDistTag(pkg.name, pkg.version, channel)
  console.log(`Ready ${pkg.name}@${pkg.version} on ${channel}`)
}

export async function publishPackedArchives(
  archives: PackedArchive[],
  version: string,
  channel: string,
  {
    deferred = [],
    publish = publishPackedArchive,
  }: {
    deferred?: string[]
    publish?: (pkg: PackedArchive, channel: string) => Promise<void>
  } = {},
) {
  const ordered = modulePublishOrder(archives, deferred)
  for (const pkg of ordered) {
    if (pkg.version !== version) throw new Error(`Stale module publication version: ${pkg.name}@${pkg.version}`)
    await assertNpmArchiveSize(pkg)
  }
  const names = new Set(ordered.map((pkg) => pkg.name))
  const dependencies = new Map(
    ordered.map((pkg) => [
      pkg.name,
      publicationDependencies(pkg)
        .map(([name]) => name)
        .filter((name) => names.has(name)),
    ]),
  )
  const pending = new Set(ordered)
  const completed = new Set<string>()
  const active = new Set<Promise<void>>()
  const failures: unknown[] = []
  while (pending.size || active.size) {
    if (!failures.length) {
      for (const pkg of pending) {
        if (active.size === PUBLICATION_CONCURRENCY) break
        if (!dependencies.get(pkg.name)!.every((name) => completed.has(name))) continue
        pending.delete(pkg)
        const task: Promise<void> = Promise.resolve()
          .then(() => publish(pkg, channel))
          .then(
            () => {
              completed.add(pkg.name)
            },
            (error: unknown) => {
              failures.push(error)
            },
          )
          .finally(() => {
            active.delete(task)
          })
        active.add(task)
      }
    }
    if (!active.size) break
    await Promise.race(active)
  }
  if (failures.length) throw failures[0]
  if (pending.size) throw new Error("Publication dependencies could not complete")
  return ordered
}

export async function publishModuleCandidates(version: string, channel: string) {
  const archives = await readPackedArchives(path.join(PRESETS_DIST_DIR, "modules-packages"))
  if (!archives.length) throw new Error("No runtime module archives were built")
  const ordered = await publishPackedArchives(archives, version, channel, { deferred: [DESKTOP_APP_PACKAGE] })
  return ordered.map((pkg) => pkg.name)
}
