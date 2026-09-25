import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { SynergyPackage, SynergyPackageName } from "@ericsanchezok/synergy-plugin/package"
import { InstallationGenerations, type InstalledPackage } from "./generations"
import { sha256File } from "./files"

const PackageJson = z.object({
  name: SynergyPackageName,
  version: z.string().min(1),
  synergy: SynergyPackage.optional(),
})
const Dependencies = z.record(SynergyPackageName, z.string().min(1))

export interface PackageGraphOptions {
  sources: readonly string[]
  hostVersion: string
  basePackages?: Record<string, string>
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

async function packageManager(root: string, directory: string, args: string[], options: PackageGraphOptions) {
  options.signal?.throwIfAborted()
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: directory,
    env: {
      ...(options.env ?? process.env),
      BUN_BE_BUN: "1",
      BUN_INSTALL_CACHE_DIR: path.join(root, "cache", "bun-install"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const abort = () => child.kill()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    options.signal?.throwIfAborted()
    if (code) throw new Error(`Package resolution failed with exit code ${code}`)
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }
}

async function sourceSpec(root: string, spec: string, options: PackageGraphOptions) {
  if (spec.startsWith("npm:")) return spec.slice(4)
  const local = spec.startsWith("file:")
    ? spec.startsWith("file://")
      ? fileURLToPath(spec)
      : spec.slice(5)
    : path.isAbsolute(spec) || spec.startsWith(".")
      ? spec
      : undefined
  if (local === undefined) return spec
  const filename = path.resolve(options.cwd ?? process.cwd(), local)
  const stat = await fs.stat(filename)
  const cache = path.join(root, "installations", "sources")
  await fs.mkdir(cache, { recursive: true, mode: 0o700 })
  if (!stat.isDirectory()) {
    const digest = await sha256File(filename)
    const cached = path.join(cache, digest + ".tgz")
    await fs.copyFile(filename, cached, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    if ((await sha256File(cached)) !== digest) throw new Error("Cached package integrity mismatch")
    return "file:" + cached
  }
  const archive = path.join(cache, crypto.randomUUID() + ".tgz")
  await packageManager(root, filename, ["pm", "pack", "--ignore-scripts", "--filename", archive], options)
  return "file:" + archive
}

export async function preparePackageGraph(root: string, options: PackageGraphOptions) {
  options.signal?.throwIfAborted()
  const directory = await InstallationGenerations.stage(root)
  const dispose = () => fs.rm(directory, { recursive: true, force: true })
  try {
    const basePackages = Dependencies.parse(options.basePackages ?? {})
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies: basePackages }),
    )
    const sources: string[] = []
    for (const spec of options.sources) sources.push(await sourceSpec(root, spec, options))
    if (sources.length)
      await packageManager(root, directory, ["add", "--ignore-scripts", "--exact", ...sources], options)
    else if (Object.keys(basePackages).length)
      await packageManager(root, directory, ["install", "--ignore-scripts"], options)
    const dependencies = async () =>
      Dependencies.parse((await Bun.file(path.join(directory, "package.json")).json()).dependencies ?? {})
    const initial = await dependencies()
    const roots = Object.fromEntries(Object.entries(initial).filter(([name]) => !Object.hasOwn(basePackages, name)))
    const selected = new Set(Object.keys(initial))
    const packages: Record<string, InstalledPackage> = {}
    const expanded = new Set<string>()
    for (let round = 0; ; round++) {
      if (round > 64) throw new Error("Package selections exceed the supported dependency depth")
      const pending: Record<string, string> = {}
      const installed = await dependencies()
      for (const name of selected) {
        if (expanded.has(name)) continue
        const relative = `node_modules/${SynergyPackageName.parse(name)}`
        const pkg = PackageJson.parse(await Bun.file(path.join(directory, relative, "package.json")).json())
        if (pkg.name !== name) throw new Error(`Package identity mismatch: ${name}`)
        const metadata = pkg.synergy
        if (!metadata && !Object.hasOwn(basePackages, name))
          throw new Error(`Package ${name} has no Synergy package metadata`)
        if (metadata && pkg.version !== metadata.version) throw new Error(`Package version mismatch: ${name}`)
        if (
          metadata &&
          options.hostVersion !== "local" &&
          !Bun.semver.satisfies(options.hostVersion, metadata.compatibility.synergy)
        )
          throw new Error(`${metadata.id} requires Synergy ${metadata.compatibility.synergy}`)
        packages[name] = {
          directory: relative,
          version: pkg.version,
          spec: installed[name],
          ...(metadata ? { metadata } : {}),
        }
        expanded.add(name)
        if (metadata?.kind !== "preset" && metadata?.kind !== "component") continue
        const resolvedDependencies: Record<string, string> = {}
        for (const [dependency, spec] of Object.entries(metadata.packages ?? {})) {
          const normalized = await sourceSpec(root, spec, { ...options, cwd: path.join(directory, relative) })
          resolvedDependencies[dependency] = normalized
          if (selected.has(dependency)) {
            const existing =
              packages[dependency] ??
              PackageJson.parse(await Bun.file(path.join(directory, "node_modules", dependency, "package.json")).json())
            if (Bun.semver.satisfies(existing.version, spec)) continue
            if (installed[dependency] === normalized) continue
            throw new Error(`Conflicting package selection for ${dependency}`)
          }
          if (pending[dependency] && pending[dependency] !== normalized)
            throw new Error(`Conflicting package selection for ${dependency}`)
          pending[dependency] = normalized
        }
        packages[name].dependencies = resolvedDependencies
      }
      if (!Object.keys(pending).length) break
      const manifest = await Bun.file(path.join(directory, "package.json")).json()
      manifest.dependencies = { ...installed, ...pending }
      await Bun.write(path.join(directory, "package.json"), JSON.stringify(manifest))
      await packageManager(root, directory, ["install", "--ignore-scripts"], options)
      for (const name of Object.keys(pending)) selected.add(name)
    }
    return { directory, roots, packages, [Symbol.asyncDispose]: dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
