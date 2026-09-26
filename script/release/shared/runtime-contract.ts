import fs from "node:fs/promises"
import path from "node:path"
import type { RuntimeArtifactProfile } from "./packages"
import { sha256File } from "../../../packages/plugin-host/src/installation/files"
import { FULL_COMPONENTS } from "../../../packages/plugin-host/src/installation/catalog"

export type { RuntimeArtifactProfile } from "./packages"

export const RUNTIME_MANIFEST_NAME = "runtime-manifest.sha256"
import { requiredRuntimeArtifactPaths } from "./runtime-layout.cjs"
export { requiredRuntimeArtifactPaths } from "./runtime-layout.cjs"

export async function writeRuntimeManifest(
  runtimeDir: string,
  name: string,
  profile: RuntimeArtifactProfile = "full",
): Promise<string> {
  if (profile === "core") await assertNoProductAssets(runtimeDir)
  await fs.writeFile(
    path.join(runtimeDir, "runtime-assets.txt"),
    requiredRuntimeArtifactPaths(name, profile).join("\n") + "\n",
  )
  for (const relative of requiredRuntimeArtifactPaths(name, profile))
    if (!(await runtimeFileIsSafe(runtimeDir, relative)))
      throw new Error(`missing runtime artifact ${relative}: ${runtimeDir}`)
  const lines: string[] = []
  for (const relative of await runtimeFiles(runtimeDir))
    lines.push(`${await sha256File(path.join(runtimeDir, relative))}  ${relative}`)
  const output = path.join(runtimeDir, RUNTIME_MANIFEST_NAME)
  await fs.writeFile(output, `${lines.join("\n")}\n`)
  return output
}

export async function assertRuntimeManifest(
  runtimeDir: string,
  expectedTarget?: string,
  profile: RuntimeArtifactProfile = "full",
): Promise<void> {
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST_NAME)
  const contents = await fs.readFile(manifestPath, "utf8").catch(() => undefined)
  if (!contents) throw new Error(`runtime manifest is missing: ${manifestPath}`)

  if (profile === "core") await assertNoProductAssets(runtimeDir)

  const entries = new Map<string, string>()
  for (const line of contents.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    const checksum = match?.[1]
    const relative = match?.[2]
    const components = relative?.split("/")
    if (
      !checksum ||
      !relative ||
      !safePath(relative) ||
      components?.some((component) => component === "." || component === "..")
    ) {
      throw new Error(`runtime manifest contains an invalid entry: ${manifestPath}`)
    }
    if (entries.has(relative)) throw new Error(`runtime manifest contains a duplicate entry ${relative}`)
    entries.set(relative, checksum)
  }
  for (const file of await runtimeFiles(runtimeDir))
    if (!entries.has(file)) throw new Error(`runtime manifest contains an unlisted file: ${file}`)

  if (expectedTarget) {
    for (const relative of requiredRuntimeArtifactPaths(expectedTarget, profile)) {
      if (!entries.has(relative)) throw new Error(`runtime manifest is missing required entry ${relative}`)
    }
  }

  for (const [relative, expected] of entries) {
    const absolute = path.join(runtimeDir, relative)
    if (!(await runtimeFileIsSafe(runtimeDir, relative))) {
      const exists = await fs.lstat(absolute).then(
        () => true,
        () => false,
      )
      if (!exists) throw new Error(`runtime manifest file is missing: ${relative}`)
      throw new Error(`runtime manifest file is unsafe: ${relative}`)
    }
    const actual = await sha256File(absolute)
    if (actual !== expected) throw new Error(`runtime manifest checksum mismatch: ${relative}`)
  }
}

async function runtimeFileIsSafe(runtimeDir: string, relative: string): Promise<boolean> {
  const components = relative.split("/")
  let current = runtimeDir
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    const info = await fs.lstat(current).catch(() => null)
    if (!info || info.isSymbolicLink()) return false
    if (index < components.length - 1 && !info.isDirectory()) return false
    if (index === components.length - 1 && !info.isFile()) return false
  }
  return true
}

function safePath(relative: string) {
  return (
    !relative.startsWith("/") &&
    !/^[A-Za-z]:/.test(relative) &&
    !/[\\\x00-\x1f\x7f]/.test(relative) &&
    relative.split("/").every((part) => part && part !== "." && part !== "..")
  )
}

async function runtimeFiles(runtimeDir: string): Promise<string[]> {
  const files: string[] = []
  const pending = [runtimeDir]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`runtime contains a symbolic link: ${path.relative(runtimeDir, absolute)}`)
      }
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(runtimeDir, absolute).split(path.sep).join("/")
        if (!safePath(relative)) throw new Error(`runtime contains an unsafe file path: ${relative}`)
        if (![RUNTIME_MANIFEST_NAME, "package.json"].includes(relative)) files.push(relative)
      } else throw new Error(`runtime contains an unsupported file: ${absolute}`)
    }
  }
  return files.sort()
}

async function assertNoProductAssets(runtimeDir: string): Promise<void> {
  const productPaths = [
    "app",
    "browser-runtime",
    "lib/onnxruntime-web",
    "lib/resvg-wasm",
    "lib/holos-cli",
    "computer",
    "vec0.so",
    "vec0.dylib",
    "vec0.dll",
    "bin/ast-grep",
    "bin/ast-grep.exe",
    ...FULL_COMPONENTS.map((name) => `runtime/node_modules/@ericsanchezok/synergy-${name}`),
  ]
  for (const relative of productPaths) {
    const entry = await fs.lstat(path.join(runtimeDir, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (entry) throw new Error(`core runtime contains product asset: ${relative}`)
  }
}
