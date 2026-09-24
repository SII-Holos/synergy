import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { ROOT, OUTPUT } from "./catalog"
import { workspaces, workspaceGraph } from "../workspace-manifest"

export const BUILD_INPUTS = [
  "bun.lock",
  "package.json",
  "turbo.json",
  "script/ci.ts",
  "script/ci/artifacts.ts",
  "script/workspace-manifest.ts",
  "script/build-workspace.ts",
  "script/generate-openapi.ts",
  ".github/actions/ci-setup/action.yml",
  "packages/runtime-local/package.json",
  "packages/runtime-local/script/build-watcher.ts",
  "tsconfig.json",
]

export async function filesIn(directory: string, ignored: string[] = []): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (ignored.includes(entry.name)) return []
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`CI output must not follow a symlink: ${entry.name}`)
      return entry.isDirectory() ? filesIn(file, ignored) : [file]
    }),
  )
  return nested.flat().sort()
}

export async function fileHash(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
}

function buildWorkspaces(root: string) {
  const packages = workspaces(root)
  const graph = workspaceGraph(
    packages.map((entry) => ({
      ...entry,
      dependencies: { ...entry.dependencies, ...entry.devDependencies },
    })),
  )
  const plugin = packages.find((entry) => entry.directory === "packages/plugin")
  if (!plugin) throw new Error("Missing plugin build workspace")
  const selected = new Set<string>()
  const active = new Set<string>()
  function visit(name: string) {
    if (selected.has(name)) return
    if (active.has(name)) throw new Error("Cyclic build dependency")
    active.add(name)
    for (const dependency of graph[name] ?? []) visit(dependency)
    active.delete(name)
    selected.add(name)
  }
  visit(plugin.name)
  return [...selected].map((name) => packages.find((entry) => entry.name === name)!)
}

export function buildCommands(root = ROOT) {
  return buildWorkspaces(root)
    .filter((entry) => entry.scripts?.build)
    .map((entry) => ({
      cwd: path.join(root, entry.directory),
      args: [process.execPath, "run", "build", ...(entry.directory === "packages/sdk/js" ? ["--compile-only"] : [])],
    }))
}

function buildPaths(root: string) {
  return [
    "packages/runtime-local/.artifacts/watcher",
    ...(process.env.SYNERGY_CI_SANDBOX_BUNDLE === "1" ? ["packages/runtime-local/sandbox-assets/linux-x64"] : []),
    ...buildWorkspaces(root)
      .filter((entry) => entry.scripts?.build)
      .map((entry) => `${entry.directory}/dist`),
  ]
}

export async function buildIdentity(root = ROOT): Promise<string> {
  const abi =
    process.platform === "linux"
      ? execFileSync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" }).trim()
      : process.platform
  const hash = createHash("sha256").update(
    `ci-build-v4:${process.platform}:${process.arch}:${Bun.version}:${abi}:node22.14.0-bullseye:${process.env.SYNERGY_CI_SANDBOX_BUNDLE ?? "0"}`,
  )
  const files = [...BUILD_INPUTS]
  for (const entry of buildWorkspaces(root)) {
    for (const file of await filesIn(path.join(root, entry.directory), [
      "dist",
      "node_modules",
      ".turbo",
      "coverage",
      "test",
    ]))
      files.push(path.relative(root, file))
  }
  for (const directory of [
    "packages/runtime-local/script/watcher",
    "packages/runtime-local/src/sandbox/helper-linux",
  ]) {
    for (const file of await filesIn(path.join(root, directory), ["target", "node_modules"]))
      files.push(path.relative(root, file))
  }
  for (const file of [...new Set(files)].sort()) {
    const source = path.join(root, file)
    hash
      .update(file)
      .update(String((await stat(source)).mode & 0o777))
      .update(await readFile(source))
  }
  return hash.digest("hex")
}

export async function buildCacheIdentity(root = ROOT): Promise<string> {
  const toolchain = [process.env.ImageVersion ?? "local"]
  if (process.env.SYNERGY_CI_SANDBOX_BUNDLE === "1")
    for (const [command, args] of [
      ["rustc", ["-vV"]],
      ["cc", ["--version"]],
    ] as const)
      toolchain.push(execFileSync(command, [...args], { encoding: "utf8" }).trim())
  return createHash("sha256")
    .update(await buildIdentity(root))
    .update(JSON.stringify(toolchain))
    .digest("hex")
}

export async function publishBuild(root = ROOT) {
  const files: Array<{ path: string; sha256: string; mode: number }> = []
  for (const directory of buildPaths(root)) {
    const outputs = await filesIn(path.join(root, directory))
    if (!outputs.length) throw new Error(`Missing build output: ${directory}`)
    for (const file of outputs) {
      files.push({
        path: path.relative(root, file).split(path.sep).join("/"),
        sha256: await fileHash(file),
        mode: (await stat(file)).mode & 0o777,
      })
    }
  }
  const destination = path.join(root, OUTPUT, "build")
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const file of files) {
    await mkdir(path.dirname(path.join(destination, file.path)), { recursive: true })
    await cp(path.join(root, file.path), path.join(destination, file.path), { recursive: true, force: true })
  }
  await Bun.write(
    path.join(destination, "manifest.json"),
    JSON.stringify({ identity: await buildIdentity(root), files }),
  )
}

export async function restoreBuild(root = ROOT) {
  const directory = path.join(root, OUTPUT, "build")
  const paths = buildPaths(root)
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
    identity: string
    files: Array<{ path: string; sha256: string; mode: number }>
  }
  if (manifest.identity !== (await buildIdentity(root)))
    throw new Error("Build artifact inputs differ from this checkout")
  const expected = (await filesIn(directory))
    .map((file) => path.relative(directory, file).split(path.sep).join("/"))
    .filter((file) => file !== "manifest.json")
  const declared = manifest.files.map((file) => file.path)
  if (new Set(declared).size !== declared.length || declared.toSorted().join("\0") !== expected.sort().join("\0"))
    throw new Error("Build artifact inventory differs from its manifest")
  for (const prefix of paths) {
    if (!declared.some((file) => file.startsWith(prefix + "/"))) throw new Error(`Missing build output: ${prefix}`)
  }
  for (const entry of manifest.files) {
    if (!paths.some((prefix) => entry.path.startsWith(prefix + "/")) || entry.path.split("/").includes(".."))
      throw new Error("Unowned build artifact path")
    const file = path.join(directory, entry.path)
    if ((await fileHash(file)) !== entry.sha256 || ((await stat(file)).mode & 0o777) !== entry.mode)
      throw new Error(`Build artifact changed: ${entry.path}`)
  }
  for (const prefix of paths)
    if (declared.some((file) => file.startsWith(prefix + "/")))
      await rm(path.join(root, prefix), { recursive: true, force: true })
  for (const entry of manifest.files) {
    await mkdir(path.dirname(path.join(root, entry.path)), { recursive: true })
    await cp(path.join(directory, entry.path), path.join(root, entry.path))
  }
}
