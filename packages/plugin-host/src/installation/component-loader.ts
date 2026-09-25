import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import type { ComponentPackage } from "@ericsanchezok/synergy-plugin/package"
import type { InstalledGeneration, InstalledPackage } from "./generations"

const core = new Set(["local-runtime", "plugin-host"])
const harness = "@ericsanchezok/synergy-harness"

export async function assertHarnessIdentity(generation: InstalledGeneration) {
  const copies = Object.keys(generation.files).filter((filename) =>
    filename.endsWith(`node_modules/${harness}/package.json`),
  )
  if (copies.length !== 1 || copies[0] !== `node_modules/${harness}/package.json`)
    throw new Error("The installation must have exactly one canonical Harness identity")
  return fs.realpath(Bun.resolveSync(`${harness}/lifecycle`, generation.directory))
}

function selectedPackages(generation: InstalledGeneration, selection?: Readonly<Record<string, string>>) {
  const packages = new Map<string, InstalledPackage & { metadata: ComponentPackage }>()
  for (const pkg of Object.values(generation.packages)) {
    if (pkg.metadata?.kind === "component" && !core.has(pkg.metadata.id))
      packages.set(pkg.metadata.id, { ...pkg, metadata: pkg.metadata })
  }
  const selected = new Set<string>()
  function visit(id: string) {
    if (core.has(id) || selected.has(id)) return
    const pkg = packages.get(id)
    if (!pkg) throw new Error(`Component is not installed: ${id}`)
    selected.add(id)
    for (const required of Object.keys(pkg.metadata.requires ?? {})) visit(required)
  }
  for (const id of selection ? Object.keys(selection) : packages.keys()) {
    visit(id)
    const version =
      packages.get(id)?.version ??
      generation.packages[`@ericsanchezok/synergy-${id}`]?.version ??
      generation.hostVersion
    if (selection && selection[id] !== version)
      throw new Error(`Component ${id} requires exact version ${selection[id]}; installed ${version}`)
  }
  return [...selected].map((id) => packages.get(id)!)
}

const requirements = (value: Readonly<Record<string, string>> = {}) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))

export async function loadInstalledComponents(
  generation: InstalledGeneration,
  selection?: Readonly<Record<string, string>>,
): Promise<RuntimeComponent[]> {
  const packages = selectedPackages(generation, selection)
  const canonical = await assertHarnessIdentity(generation)
  for (const pkg of packages) {
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
      requirements(component.requires) !== requirements(pkg.metadata.requires)
    )
      throw new Error(`Component executable does not match approved metadata: ${pkg.metadata.id}`)
    for (const url of [...Object.values(component.adapters ?? {}), ...Object.values(component.workers ?? {})]) {
      if (!(url instanceof URL) || url.protocol !== "file:")
        throw new Error(`Component entry is not a local file: ${component.id}`)
      const file = await fs.realpath(fileURLToPath(url))
      const relative = path.relative(generation.directory, file).split(path.sep).join("/")
      if (generation.files[relative]?.kind !== "file")
        throw new Error(`Component entry is outside its sealed generation: ${component.id}`)
    }
    result.push(component as RuntimeComponent)
  }
  return result
}
