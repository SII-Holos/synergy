import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ComponentFeatures, FeatureSelection, type FeaturePlan } from "@ericsanchezok/synergy-util/features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import type { InstalledGeneration } from "./generations"

const core = new Set(["local-runtime", "plugin-host"])
const harness = "@ericsanchezok/synergy-harness"

export async function assertHarnessIdentity(generation: Pick<InstalledGeneration, "files" | "directory">) {
  const copies = Object.keys(generation.files).filter((filename) =>
    filename.endsWith(`node_modules/${harness}/package.json`),
  )
  if (copies.length !== 1 || copies[0] !== `node_modules/${harness}/package.json`)
    throw new Error("The installation must have exactly one canonical Harness identity")
  return fs.realpath(Bun.resolveSync(`${harness}/lifecycle`, generation.directory))
}

function selectedPackages(
  generation: InstalledGeneration,
  selection: Readonly<Record<string, string>> | undefined,
  options: { desktop?: boolean; optIn?: readonly string[] },
) {
  const packages = Object.values(generation.packages).flatMap((pkg) =>
    pkg.metadata?.kind === "component" &&
    !core.has(pkg.metadata.id) &&
    (options.desktop || pkg.metadata.id !== "browser-runtime")
      ? [{ ...pkg, metadata: pkg.metadata }]
      : [],
  )
  const features = FeatureSelection.resolve(
    packages.map((pkg) => ({ ...pkg.metadata, version: pkg.version })),
    {
      selection,
      optIn: options.optIn,
      provided: { "local-runtime": generation.hostVersion, "plugin-host": generation.hostVersion },
    },
  )
  return { packages, features }
}

const requirements = (value: Readonly<Record<string, string>> = {}) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))

export async function loadInstalledComponents(
  generation: InstalledGeneration,
  selection?: Readonly<Record<string, string>>,
  options: { desktop?: boolean; optIn?: readonly string[] } = {},
): Promise<{ components: RuntimeComponent[]; features: FeaturePlan; maintenance: URL[] }> {
  const catalog = selectedPackages(generation, selection, options)
  const packages = catalog.packages.filter((pkg) => catalog.features.components.includes(pkg.metadata.id))
  const canonical = await assertHarnessIdentity(generation)
  for (const pkg of catalog.packages.filter(
    (pkg) => catalog.features.components.includes(pkg.metadata.id) || pkg.metadata.maintenance,
  )) {
    const resolved = await fs.realpath(
      Bun.resolveSync(`${harness}/lifecycle`, path.join(generation.directory, pkg.directory)),
    )
    if (resolved !== canonical) throw new Error(`Component ${pkg.metadata.id} has a different Harness identity`)
  }
  const result: RuntimeComponent[] = []
  for (const pkg of packages) {
    const entry = path.join(generation.directory, pkg.directory, pkg.metadata.entry)
    const module: Record<string, unknown> = await import(pathToFileURL(entry).href)
    const factory = module[pkg.metadata.export]
    if (typeof factory !== "function") throw new Error(`Component factory is missing: ${pkg.metadata.id}`)
    const component: Partial<RuntimeComponent> = await factory()
    if (
      !component ||
      component.id !== pkg.metadata.id ||
      component.version !== pkg.metadata.version ||
      component.apiVersion !== pkg.metadata.apiVersion ||
      typeof component.register !== "function" ||
      requirements(component.requires) !== requirements(pkg.metadata.requires) ||
      Boolean(component.maintenance) !== Boolean(pkg.metadata.maintenance) ||
      JSON.stringify(component.features && ComponentFeatures.parse(component.features)) !==
        JSON.stringify(pkg.metadata.features && ComponentFeatures.parse(pkg.metadata.features))
    )
      throw new Error(`Component executable does not match approved metadata: ${pkg.metadata.id}`)
    for (const url of [
      ...Object.values(component.adapters ?? {}),
      ...Object.values(component.workers ?? {}),
      ...(component.maintenance ? [component.maintenance] : []),
    ]) {
      if (!(url instanceof URL) || url.protocol !== "file:")
        throw new Error(`Component entry is not a local file: ${component.id}`)
      const file = await fs.realpath(fileURLToPath(url))
      if (
        url === component.maintenance &&
        file !== (await fs.realpath(path.join(generation.directory, pkg.directory, pkg.metadata.maintenance!)))
      )
        throw new Error(`Component maintenance does not match approved metadata: ${component.id}`)
      const relative = path.relative(generation.directory, file).split(path.sep).join("/")
      if (generation.files[relative]?.kind !== "file")
        throw new Error(`Component entry is outside its sealed generation: ${component.id}`)
    }
    result.push(component as RuntimeComponent)
  }
  const maintenance = catalog.packages.flatMap((pkg) => {
    if (catalog.features.components.includes(pkg.metadata.id) || !pkg.metadata.maintenance) return []
    const relative = path.posix.join(pkg.directory, pkg.metadata.maintenance)
    if (generation.files[relative]?.kind !== "file")
      throw new Error(`Maintenance entry is outside its sealed generation: ${pkg.metadata.id}`)
    return [pathToFileURL(path.join(generation.directory, relative))]
  })
  return { components: result, features: catalog.features, maintenance }
}
