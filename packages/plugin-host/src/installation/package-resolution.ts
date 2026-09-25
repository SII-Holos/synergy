import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { ProcessGroup } from "@ericsanchezok/synergy-util/process-group"
import { z } from "zod"
import { SynergyPackage, SynergyPackageName } from "@ericsanchezok/synergy-plugin/package"
import { InstallationGenerations, type InstalledPackage, type InstalledGeneration } from "./generations"
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
  previous?: InstalledGeneration
  remove?: readonly string[]
  update?: readonly string[]
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
}

async function packageManager(root: string, directory: string, args: string[], options: PackageGraphOptions) {
  options.signal?.throwIfAborted()
  const command = ["add", "install", "update"].includes(args[0])
    ? [args[0], "--linker=hoisted", ...args.slice(1)]
    : args
  const invocation = ProcessGroup.prepareOwnedProcessGroup({ command: process.execPath, args: command })
  const child = spawn(invocation.command, invocation.args, {
    cwd: directory,
    detached: process.platform !== "win32",
    env: {
      ...(options.env ?? process.env),
      BUN_BE_BUN: "1",
      BUN_INSTALL_CACHE_DIR: path.join(root, "cache", "bun-install"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.resume()
  child.stderr.resume()
  let exited = false
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => {
      exited = true
      resolve(code)
    })
  })
  let stopping: Promise<void> | undefined
  const stop = () => (stopping ??= ProcessGroup.killTree(child, { exited: () => exited, allowExitedParent: true }))
  const abort = () => {
    void stop()
  }
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    if (options.signal?.aborted) await stop()
    const code = await result
    await stop()
    await closed
    options.signal?.throwIfAborted()
    if (code !== 0) throw new Error(`Package resolution failed with exit code ${code}`)
  } finally {
    options.signal?.removeEventListener("abort", abort)
    await stop()
    await closed
    ProcessGroup.releaseOwnedProcessGroup(child)
  }
}

async function sourceSpec(root: string, spec: string, options: PackageGraphOptions) {
  if (spec.startsWith("npm:")) spec = spec.slice(4)
  if (!spec || spec.startsWith("-") || spec.includes("\0"))
    throw new Error("Package source must name a package, Git URL, or local archive")
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
    const retained = { ...options.previous?.roots }
    for (const name of options.remove ?? []) {
      if (Object.hasOwn(basePackages, name)) throw new Error(`Cannot remove core package ${name}`)
      if (!Object.hasOwn(retained, name)) {
        const owners = Object.entries(options.previous?.packages ?? {})
          .filter(([, pkg]) => Object.hasOwn(pkg.dependencies ?? {}, name))
          .map(([owner]) => owner)
        throw new Error(
          owners.length ? `${name} is required by ${owners.join(", ")}` : `Package is not installed: ${name}`,
        )
      }
      delete retained[name]
    }
    if (options.previous) {
      await fs.cp(options.previous.directory, directory, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (filename) => filename !== path.join(options.previous!.directory, "generation.json"),
      })
    }
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies: { ...basePackages, ...retained } }),
    )
    const sources: string[] = []
    for (const spec of options.sources) sources.push(await sourceSpec(root, spec, options))
    if (sources.length)
      await packageManager(root, directory, ["add", "--ignore-scripts", "--exact", ...sources], options)
    else if (Object.keys(basePackages).length || Object.keys(retained).length || options.previous)
      await packageManager(root, directory, ["install", "--ignore-scripts"], options)
    if (options.update?.length) {
      for (const name of options.update) {
        if (!Object.hasOwn(retained, name))
          throw new Error(`Only explicitly installed packages can be updated: ${name}`)
      }
      await packageManager(root, directory, ["update", "--ignore-scripts", ...options.update], options)
    }
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
          const previous = options.previous?.packages[name]
          const pinned =
            JSON.stringify(previous?.metadata) === JSON.stringify(metadata) && previous?.dependencies?.[dependency]
          const normalized =
            pinned || (await sourceSpec(root, spec, { ...options, cwd: path.join(directory, relative) }))
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
    if (options.previous) {
      await fs.rm(path.join(directory, "node_modules"), { recursive: true, force: true })
      if (Object.keys(packages).length)
        await packageManager(root, directory, ["install", "--ignore-scripts", "--frozen-lockfile"], options)
    }
    for (const [name, pkg] of Object.entries(packages)) {
      const actual = PackageJson.parse(await Bun.file(path.join(directory, pkg.directory, "package.json")).json())
      if (actual.version !== pkg.version || JSON.stringify(actual.synergy) !== JSON.stringify(pkg.metadata))
        throw new Error(`Package resolution changed a previously validated selection: ${name}`)
    }
    return { directory, roots, packages, [Symbol.asyncDispose]: dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
