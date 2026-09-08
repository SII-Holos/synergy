#!/usr/bin/env bun
import { cp, mkdir, mkdtemp, rm, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { workspaces, workspaceGraph } from "./workspace-dependencies"
import { buildWorkspace } from "./build-workspace"
import { createPublishablePackageJson, readCatalog } from "./release/shared/package-manifest"

import { stageWorkspaceSandbox } from "./release/shared/build/workspace-sandbox"
import type { SandboxRuntimeTarget } from "./release/shared/build/sandbox-assets"

const root = path.resolve(import.meta.dir, "..")
const runtimePackages = new Set(
  [
    "harness",
    "runtime-local",
    "cli",
    "server",
    "product-runtime",
    "browser-runtime",
    "computer-runtime",
    "library",
    "note",
    "workflows",
    "connections",
    "workbench",
    "agent-integrations",
    "media",
    "plugin-host",
  ].map((name) => `packages/${name}`),
)

export async function packWorkspace(
  directory: string,
  output: string,
  options: { target?: SandboxRuntimeTarget; assetsRoot?: string } = {},
) {
  const target = options.target ?? { os: process.platform, arch: process.arch as "arm64" | "x64" }
  const packages = workspaces(root)
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const entry = packages.find((pkg) => pkg.directory === directory)
  if (!entry) throw new Error(`Unknown workspace: ${directory}`)
  const graph = workspaceGraph(packages)
  const archivePaths = new Map<string, string>()
  const catalog = await readCatalog()
  const dependencyVersions = Object.fromEntries(
    await Promise.all(
      packages.map(async (pkg) => {
        const manifest = await Bun.file(path.join(root, pkg.directory, "package.json")).json()
        return [pkg.name, manifest.version]
      }),
    ),
  )
  await mkdir(output, { recursive: true })
  async function pack(name: string): Promise<void> {
    if (archivePaths.has(name)) return
    const pkg = byName.get(name)!
    for (const dependency of graph[name] ?? []) await pack(dependency)
    const sourceDirectory = path.join(root, pkg.directory)
    const original = await Bun.file(path.join(sourceDirectory, "package.json")).json()
    const isRuntime = runtimePackages.has(pkg.directory)
    const nested = ["packages/cli", "packages/product-runtime"].includes(pkg.directory)
    if (isRuntime) await buildWorkspace(pkg.directory, { output: nested ? "dist/modules" : "dist" })
    else if (original.scripts?.build) {
      const process = Bun.spawn(["bun", "run", "build"], { cwd: sourceDirectory, stdout: "inherit", stderr: "inherit" })
      if (await process.exited) throw new Error(`Package build failed: ${name}`)
    }
    if (pkg.directory === "packages/runtime-local") {
      await stageWorkspaceSandbox(path.join(sourceDirectory, "dist"), target, options.assetsRoot)
    }
    if (pkg.directory === "packages/product-runtime") {
      await cp(path.join(sourceDirectory, "schema"), path.join(sourceDirectory, "dist/schema"), { recursive: true })
    }
    const stage = await mkdtemp(path.join(os.tmpdir(), "synergy-library-pack-"))
    try {
      let manifest = createPublishablePackageJson({
        packageJson: original,
        version: original.version,
        catalog,
        dependencyVersions,
      })
      if (isRuntime) {
        const exports: Record<string, unknown> = {}
        for (const [key, source] of Object.entries(original.exports ?? {})) {
          if (key.startsWith("./test/") || key.startsWith("./script/")) continue
          if (typeof source !== "string" || !source.startsWith("./src/"))
            throw new Error(`${name}: unsupported runtime export ${key}`)
          const target = source
            .replace("./src/", nested ? "./dist/modules/" : "./dist/")
            .replace(/\.(ts|tsx|mts)$/, ".js")
          exports[key] = { types: source, bun: target, import: target }
        }
        manifest = {
          ...manifest,
          exports,
          files: ["src", nested ? "dist/modules" : "dist", "README.md", "AGENTS.md"],
          engines: { bun: ">=1.3.14" },
        }
        if (pkg.directory === "packages/product-runtime") (manifest.files as string[]).push("dist/schema")
        if (pkg.directory === "packages/runtime-local") {
          manifest.os = [target.os]
          manifest.cpu = [target.arch]
        }
        delete manifest.scripts
        if (pkg.directory === "packages/cli") manifest.bin = { synergy: "./dist/modules/index.js" }
      }
      for (const item of (manifest.files as string[]) ?? ["dist", "README.md"]) {
        const source = path.join(sourceDirectory, item)
        if (!(await Bun.file(source).exists()) && !(await Bun.file(path.join(source, "index.js")).exists())) {
          const { existsSync } = await import("node:fs")
          if (!existsSync(source)) continue
        }
        await cp(source, path.join(stage, item), { recursive: true })
      }
      if (pkg.directory === "packages/cli") {
        const bin = path.join(stage, "dist/modules/index.js")
        await Bun.write(bin, "#!/usr/bin/env bun\n" + (await Bun.file(bin).text()))
        await chmod(bin, 0o755)
      }
      await Bun.write(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
      const archive = path.join(output, `${name.replace(/^@/, "").replaceAll("/", "-")}-${original.version}.tgz`)
      const process = Bun.spawn(["bun", "pm", "pack", "--filename", archive, "--ignore-scripts"], {
        cwd: stage,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, errors] = await Promise.all([process.exited, new Response(process.stderr).text()])
      if (code) throw new Error(`Packing ${name} failed: ${errors}`)
      archivePaths.set(name, archive)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  await pack(entry.name)
  return { entry: archivePaths.get(entry.name)!, archives: Object.fromEntries(archivePaths) }
}

if (import.meta.main) {
  const directory = process.argv[2]
  const output = process.argv[3]
  if (!directory || !output)
    throw new Error("Usage: bun script/pack-workspace.ts <workspace directory> <archive directory>")
  const requested = process.argv.find((argument) => argument.startsWith("--target="))?.slice(9)
  const match = requested?.match(/^(darwin|linux|win32)-(arm64|x64)(-musl)?$/)
  if (requested && !match) throw new Error("Target must be darwin/linux/win32-arm64/x64 with optional Linux -musl")
  if (match?.[3] && match[1] !== "linux") throw new Error("The musl ABI is supported only on Linux")
  const target = match
    ? { os: match[1]!, arch: match[2] as "arm64" | "x64", ...(match[3] ? { abi: "musl" as const } : {}) }
    : undefined
  console.log(JSON.stringify(await packWorkspace(directory, path.resolve(output), { target }), null, 2))
}
