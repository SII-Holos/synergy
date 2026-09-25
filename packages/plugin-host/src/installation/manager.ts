import { InstallationGenerations, type InstalledGeneration, type InstalledPackage } from "./generations"
import { preparePackageGraph, type PackageGraphOptions } from "./package-resolution"
import { resolveBuiltinPackage } from "./catalog"

export interface PackageChange {
  name: string
  id: string
  kind: NonNullable<InstalledPackage["metadata"]>["kind"]
  action: "install" | "update" | "remove"
  version: string
  previousVersion?: string
}

function packageName(generation: InstalledGeneration | undefined, target: string) {
  if (generation?.packages[target]) return target
  const matches = Object.entries(generation?.packages ?? {}).filter(([, pkg]) => pkg.metadata?.id === target)
  if (matches.length !== 1) throw new Error(`Installed package name or id is not unique: ${target}`)
  return matches[0][0]
}

export async function listInstalledPackages(root: string) {
  const generation = await InstallationGenerations.current(root)
  return Object.entries(generation?.packages ?? {})
    .flatMap(([name, pkg]) =>
      pkg.metadata
        ? [
            {
              name,
              id: pkg.metadata.id,
              kind: pkg.metadata.kind,
              version: pkg.version,
              explicit: Object.hasOwn(generation!.roots, name),
              requiredBy: Object.entries(generation!.packages)
                .filter(([, owner]) => Object.hasOwn(owner.dependencies ?? {}, name))
                .map(([name]) => name),
            },
          ]
        : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function prepareInstallation(
  root: string,
  options: Omit<PackageGraphOptions, "previous" | "sources"> & { sources?: readonly string[]; updateAll?: boolean },
) {
  const previous = await InstallationGenerations.current(root)
  const prepared = await preparePackageGraph(root, {
    ...options,
    previous,
    sources: (options.sources ?? []).map((spec) => resolveBuiltinPackage(spec, options.hostVersion)),
    remove: options.remove?.map((target) => packageName(previous, target)),
    update: options.updateAll
      ? Object.keys(previous?.roots ?? {})
      : options.update?.map((target) => packageName(previous, target)),
  })
  const changes: PackageChange[] = []
  for (const [name, pkg] of Object.entries(prepared.packages)) {
    if (!pkg.metadata) continue
    const before = previous?.packages[name]
    if (before?.version === pkg.version && JSON.stringify(before.metadata) === JSON.stringify(pkg.metadata)) continue
    changes.push({
      name,
      id: pkg.metadata.id,
      kind: pkg.metadata.kind,
      action: before ? "update" : "install",
      version: pkg.version,
      ...(before ? { previousVersion: before.version } : {}),
    })
  }
  for (const [name, pkg] of Object.entries(previous?.packages ?? {})) {
    if (!pkg.metadata || prepared.packages[name]) continue
    changes.push({ name, id: pkg.metadata.id, kind: pkg.metadata.kind, action: "remove", version: pkg.version })
  }
  return {
    ...prepared,
    previous,
    changes,
    commit(input: { trustHostCode: boolean }) {
      return InstallationGenerations.commit(root, {
        ...prepared,
        ...input,
        previous: previous?.id,
        hostVersion: options.hostVersion,
      })
    },
  }
}
