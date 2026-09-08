import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { EMBEDDING_RUNTIME_REQUIRED_PATHS } from "../../../packages/library/script/embedding-runtime-assets"
import { PLAYWRIGHT_CORE_REQUIRED_PATHS } from "../../../packages/product-runtime/script/playwright-runtime-assets"
import { SVG_RASTER_RUNTIME_REQUIRED_PATHS } from "../../../packages/connections/script/svg-raster-runtime-assets"
import type { RuntimeArtifactProfile } from "./packages"

export type { RuntimeArtifactProfile } from "./packages"

export const RUNTIME_MANIFEST_NAME = "runtime-manifest.sha256"
export const HOLOS_CLI_REQUIRED_PATHS = [
  "lib/holos-cli/index.js",
  "lib/holos-cli/vendor/clarus-shared/index.js",
  "lib/holos-cli/node_modules/ws/package.json",
  "lib/holos-cli/node_modules/zod/package.json",
] as const

export function requiredRuntimeArtifactPaths(name: string, profile: RuntimeArtifactProfile = "full"): string[] {
  const target = runtimeTarget(name)
  const binary = target.os === "windows" ? "bin/synergy.exe" : "bin/synergy"
  const astGrep = target.os === "windows" ? "bin/ast-grep.exe" : "bin/ast-grep"
  const sqliteVec = target.os === "windows" ? "vec0.dll" : target.os === "darwin" ? "vec0.dylib" : "vec0.so"
  return [
    binary,
    ...(!target.musl && profile === "full" ? [astGrep] : []),
    ...(!target.musl && profile === "full" ? [sqliteVec] : []),
    // The watcher binding ships for every target: @parcel/watcher publishes
    // musl packages, so unlike ast-grep/sqlite-vec it is not glibc-only.
    "watcher.node",
    "schema/config.schema.json",
    ...(profile === "full"
      ? [
          "app/index.html",
          ...PLAYWRIGHT_CORE_REQUIRED_PATHS,
          ...EMBEDDING_RUNTIME_REQUIRED_PATHS,
          ...SVG_RASTER_RUNTIME_REQUIRED_PATHS,
          ...HOLOS_CLI_REQUIRED_PATHS,
        ]
      : []),
    ...(target.os === "linux" ? ["sandbox/synergy-sandbox-linux"] : []),
    ...(target.os === "windows" ? ["sandbox/synergy-sandbox-windows.exe"] : []),
  ]
}

export async function writeRuntimeManifest(
  runtimeDir: string,
  name: string,
  profile: RuntimeArtifactProfile = "full",
): Promise<string> {
  if (profile === "core") await assertNoProductAssets(runtimeDir)
  const lines = await Promise.all(
    requiredRuntimeArtifactPaths(name, profile).map(async (relative) => {
      const data = await fs.readFile(path.join(runtimeDir, relative)).catch(() => undefined)
      if (!data) throw new Error(`missing runtime artifact ${relative}: ${runtimeDir}`)
      return `${createHash("sha256").update(data).digest("hex")}  ${relative}`
    }),
  )
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

  await assertNoRuntimeSymlinks(runtimeDir)
  if (profile === "core") await assertNoProductAssets(runtimeDir)

  const entries = new Map<string, string>()
  for (const line of contents.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([^/\\\s]+(?:\/[^/\\\s]+)*)$/.exec(line)
    const checksum = match?.[1]
    const relative = match?.[2]
    const components = relative?.split("/")
    if (
      !checksum ||
      !relative ||
      /^[A-Za-z]:/.test(relative) ||
      components?.some((component) => component === "." || component === "..")
    ) {
      throw new Error(`runtime manifest contains an invalid entry: ${manifestPath}`)
    }
    if (entries.has(relative)) throw new Error(`runtime manifest contains a duplicate entry ${relative}`)
    entries.set(relative, checksum)
  }

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
    const data = await fs.readFile(absolute)
    const actual = createHash("sha256").update(data).digest("hex")
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

async function assertNoRuntimeSymlinks(runtimeDir: string): Promise<void> {
  const pending = [runtimeDir]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`runtime contains a symbolic link: ${path.relative(runtimeDir, absolute)}`)
      }
      if (entry.isDirectory()) pending.push(absolute)
    }
  }
}

function runtimeTarget(name: string): { os: "linux" | "darwin" | "windows"; musl: boolean } {
  const match = /^synergy-(linux|darwin|windows)-(?:x64|arm64)(?:-|$)/.exec(name)
  if (!match) throw new Error(`Invalid Synergy runtime package name: ${name}`)
  return { os: match[1] as "linux" | "darwin" | "windows", musl: name.split("-").includes("musl") }
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
  ]
  for (const relative of productPaths) {
    const entry = await fs.lstat(path.join(runtimeDir, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (entry) throw new Error(`core runtime contains product asset: ${relative}`)
  }
}
