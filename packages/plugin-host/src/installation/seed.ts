import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { SynergyPackage, SynergyPackageName } from "@ericsanchezok/synergy-plugin/package"
import { InstallationGenerations, type InstalledPackage } from "./generations"
import { assertHarnessIdentity } from "./component-loader"

const Dependencies = z.record(SynergyPackageName, z.string()).optional()
const Package = z.object({
  name: SynergyPackageName,
  version: z.string().min(1),
  synergy: SynergyPackage.optional(),
  dependencies: Dependencies,
  optionalDependencies: Dependencies,
  peerDependencies: Dependencies,
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
})

async function resolvePackage(directory: string, name: string) {
  for (;;) {
    const candidate = path.join(directory, "node_modules", name)
    if (await Bun.file(path.join(candidate, "package.json")).exists()) return fs.realpath(candidate)
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export async function canSeedInstalledCore(cliDirectory: string, roots: Record<string, string>) {
  for (const [name, spec] of Object.entries(roots)) {
    const source = await resolvePackage(cliDirectory, name)
    if (!source) return false
    const pkg = Package.parse(await Bun.file(path.join(source, "package.json")).json())
    if (!Bun.semver.satisfies(pkg.version, spec)) return false
  }
  return true
}

export async function seedInstalledCore(
  root: string,
  cliDirectory: string,
  version: string,
  options: { roots?: Record<string, string>; previous?: string } = {},
) {
  const directory = await InstallationGenerations.stage(root)
  const copied = new Map<string, string>()
  const roots = new Map<string, string>()
  async function copy(source: string, owner?: string, alias?: string): Promise<string> {
    source = await fs.realpath(source)
    const pkg = Package.parse(await Bun.file(path.join(source, "package.json")).json())
    const name = alias ?? pkg.name
    const existing = roots.get(name)
    const destination =
      existing && existing !== source
        ? path.join(owner!, "node_modules", name)
        : path.join(directory, "node_modules", name)
    if (copied.get(destination) === source) return destination
    if (copied.has(destination)) throw new Error(`Installed dependency identities conflict: ${pkg.name}`)
    if (!existing) roots.set(name, source)
    copied.set(destination, source)
    await fs.cp(source, destination, {
      recursive: true,
      dereference: true,
      async filter(filename) {
        const parts = path.relative(source, filename).split(path.sep)
        if (parts.some((part) => ["node_modules", ".git", ".npmrc"].includes(part))) return false
        const actual = path.relative(source, await fs.realpath(filename))
        if (actual === ".." || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual))
          throw new Error(`Installed package file escapes its owner: ${pkg.name}`)
        return true
      },
    })
    const required = {
      ...pkg.dependencies,
      ...Object.fromEntries(
        Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => !pkg.peerDependenciesMeta?.[name]?.optional),
      ),
    }
    const selected = { ...required, ...pkg.optionalDependencies }
    for (const name of Object.keys(selected)) {
      const dependency = await resolvePackage(source, name)
      if (!dependency) {
        if (Object.hasOwn(pkg.optionalDependencies ?? {}, name)) continue
        throw new Error(`Installed core is missing dependency ${name}`)
      }
      const metadata = Package.parse(await Bun.file(path.join(dependency, "package.json")).json())
      const expected = selected[name].startsWith("npm:")
        ? selected[name].slice(4).match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/)?.[1]
        : name
      if (metadata.name !== expected) throw new Error(`Installed dependency name does not match: ${name}`)
      await copy(dependency, destination, name)
    }
    return destination
  }
  try {
    const cli = Package.parse(await Bun.file(path.join(cliDirectory, "package.json")).json())
    if (cli.name !== "@ericsanchezok/synergy-cli" || cli.version !== version)
      throw new Error("The installed CLI does not match the launcher version")
    await copy(cliDirectory)
    const selected: Record<string, InstalledPackage> = {
      [cli.name]: { directory: `node_modules/${cli.name}`, version, spec: version },
    }
    async function select(name: string, spec: string) {
      if (selected[name]) {
        if (!Bun.semver.satisfies(selected[name].version, spec))
          throw new Error(`Conflicting offline seed selection: ${name}`)
        return
      }
      const source = await resolvePackage(cliDirectory, name)
      if (!source) throw new Error(`Offline seed is missing ${name}`)
      const pkg = Package.parse(await Bun.file(path.join(source, "package.json")).json())
      if (!pkg.synergy || pkg.name !== name || !Bun.semver.satisfies(pkg.version, spec))
        throw new Error(`Offline seed selection does not match ${name}@${spec}`)
      const location = await copy(source)
      const dependencies =
        pkg.synergy.kind === "component" || pkg.synergy.kind === "preset" ? pkg.synergy.packages : undefined
      selected[name] = {
        directory: path.relative(directory, location).split(path.sep).join("/"),
        version: pkg.version,
        spec,
        metadata: pkg.synergy,
        ...(dependencies ? { dependencies } : {}),
      }
      for (const [name, spec] of Object.entries(dependencies ?? {})) await select(name, spec)
    }
    for (const [name, spec] of Object.entries(options.roots ?? {})) await select(name, spec)
    const harness = "node_modules/@ericsanchezok/synergy-harness"
    const copies = [...copied.keys()].filter((filename) => filename.split(path.sep).join("/").endsWith(harness))
    if (copies.length !== 1 || copies[0] !== path.join(directory, harness))
      throw new Error("The installed core must have one canonical Harness identity")
    await fs.realpath(Bun.resolveSync("@ericsanchezok/synergy-harness/lifecycle", directory))
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: Object.fromEntries(Object.entries(selected).map(([name, pkg]) => [name, pkg.version])),
      }),
    )
    const generation = await InstallationGenerations.commit(root, {
      directory,
      previous: options.previous,
      hostVersion: version,
      roots: options.roots ?? {},
      trustHostCode: true,
      packages: selected,
    })
    await assertHarnessIdentity(generation)
    return generation
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
