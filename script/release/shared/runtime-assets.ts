import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import {
  APP_DIST_DIR,
  CLI_DIR,
  CORE_RUNTIME_DIST_DIR,
  PRODUCT_RUNTIME_DIR,
  PRODUCT_RUNTIME_DIST_DIR,
  RELEASE_CATALOG,
  REPO_ROOT,
  type RuntimeArtifactProfile,
} from "./packages"
import { stagePlaywrightCoreRuntime } from "../../../packages/product-runtime/script/playwright-runtime-assets"
import { writeRuntimeManifest } from "./runtime-contract"

type RuntimeAssetOptions = {
  profile?: RuntimeArtifactProfile
  runtimeDir: string
  appDistDir?: string
  schemaPath?: string
  playwrightCoreDir?: string
}

const astGrepPlatformPackages: Record<string, string> = {
  "darwin-arm64": "@ast-grep/cli-darwin-arm64",
  "darwin-x64": "@ast-grep/cli-darwin-x64",
  "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
  "linux-x64": "@ast-grep/cli-linux-x64-gnu",
  "windows-x64": "@ast-grep/cli-win32-x64-msvc",
}

function watcherBindingPackageName(targetOs: string, targetArch: string, musl: boolean): string {
  const os = targetOs === "windows" ? "win32" : targetOs
  const libc = musl ? "-musl" : "-glibc"
  return targetOs === "linux" ? `@parcel/watcher-${os}-${targetArch}${libc}` : `@parcel/watcher-${os}-${targetArch}`
}

export async function prepareRuntimeApplicationAssets(options: RuntimeAssetOptions) {
  const profile = options.profile ?? "full"
  const appDistDir = options.appDistDir ?? APP_DIST_DIR
  const schemaPath =
    options.schemaPath ?? path.join(profile === "core" ? CLI_DIR : PRODUCT_RUNTIME_DIR, "schema/config.schema.json")
  const appIndexPath = path.join(appDistDir, "index.html")

  if (profile === "full" && !(await Bun.file(appIndexPath).exists())) {
    throw new Error(`Web application entry point is missing: ${appIndexPath}`)
  }
  if (!(await Bun.file(schemaPath).exists())) {
    throw new Error(`Runtime configuration schema is missing: ${schemaPath}`)
  }

  if (profile === "full") {
    const appDestination = path.join(options.runtimeDir, "app")
    await fs.rm(appDestination, { recursive: true, force: true })
    await fs.cp(appDistDir, appDestination, { recursive: true })
  }

  const schemaDestination = path.join(options.runtimeDir, "schema/config.schema.json")
  await fs.mkdir(path.dirname(schemaDestination), { recursive: true })
  await fs.copyFile(schemaPath, schemaDestination)
  if (profile === "full")
    await stagePlaywrightCoreRuntime({
      runtimeDir: options.runtimeDir,
      playwrightCoreDir: options.playwrightCoreDir,
    })
}

export async function prepareRuntimeAssets(name: string, profile: RuntimeArtifactProfile = "full") {
  const runtimeDir = path.join(profile === "core" ? CORE_RUNTIME_DIST_DIR : PRODUCT_RUNTIME_DIST_DIR, name)
  if (!existsSync(path.join(runtimeDir, "bin"))) {
    throw new Error(`Runtime binary directory is missing: ${runtimeDir}`)
  }

  await prepareRuntimeApplicationAssets({ runtimeDir, profile })

  const dependencies = await runtimeDependencies(profile)
  const { targetOs, targetArch, musl } = runtimeTarget(name)
  if (musl) {
    await removeUnsupportedMuslAssets(runtimeDir)
    console.warn(`Skipping ast-grep and sqlite-vec for ${name}; no musl-compatible release assets are available`)
  } else {
    if (profile === "full") await copySqliteVec(runtimeDir, targetOs, targetArch, dependencies)
    if (profile === "full") await copyAstGrep(runtimeDir, targetOs, targetArch, dependencies)
  }
  // The watcher binding is copied for every target including musl: unlike
  // ast-grep/sqlite-vec, @parcel/watcher publishes musl packages.
  await copyWatcherBinding(runtimeDir, targetOs, targetArch, musl, dependencies)
  await writeRuntimeManifest(runtimeDir, name, profile)
}

async function copyWatcherBinding(
  runtimeDir: string,
  targetOs: string,
  targetArch: string,
  musl: boolean,
  dependencies: Record<string, string>,
) {
  const packageName = watcherBindingPackageName(targetOs, targetArch, musl)
  const version = dependencies[packageName]
  if (!version) {
    // watcher.node is unconditionally required by the runtime manifest for
    // every target (including musl), so a missing declaration is fatal.
    throw new Error(`watcher binding package not declared for ${packageName}`)
  }
  const source = resolveDependencyAsset(packageName, version, "watcher.node")
  if (!source) {
    throw new Error(`watcher binding (watcher.node) not found for ${packageName}`)
  }
  await fs.copyFile(source, path.join(runtimeDir, "watcher.node"))
}

function runtimeTarget(name: string) {
  const [packageName, targetOs, targetArch, ...variants] = name.split("-")
  if (packageName !== "synergy" || !targetOs || !targetArch) {
    throw new Error(`Invalid Synergy runtime package name: ${name}`)
  }
  return { targetOs, targetArch, musl: variants.includes("musl") }
}

async function removeUnsupportedMuslAssets(runtimeDir: string) {
  await Promise.all([
    fs.rm(path.join(runtimeDir, "bin", "ast-grep"), { force: true }),
    fs.rm(path.join(runtimeDir, "bin", "ast-grep.exe"), { force: true }),
    fs.rm(path.join(runtimeDir, "vec0.so"), { force: true }),
    fs.rm(path.join(runtimeDir, "vec0.dylib"), { force: true }),
    fs.rm(path.join(runtimeDir, "vec0.dll"), { force: true }),
  ])
}

export async function runtimeDependencies(profile: RuntimeArtifactProfile = "full") {
  const entries =
    profile === "core"
      ? [RELEASE_CATALOG.cli, RELEASE_CATALOG.harness, RELEASE_CATALOG.runtimeLocal]
      : Object.values(RELEASE_CATALOG)
  const dependencies: Record<string, string> = {}
  for (const entry of entries) {
    const pkg = (await Bun.file(path.join(REPO_ROOT, entry.directory, "package.json")).json()) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    Object.assign(dependencies, pkg.dependencies, pkg.devDependencies)
  }
  return dependencies
}

async function copySqliteVec(
  runtimeDir: string,
  targetOs: string,
  targetArch: string,
  dependencies: Record<string, string>,
) {
  const extension = targetOs === "windows" ? "dll" : targetOs === "darwin" ? "dylib" : "so"
  const packageName = `sqlite-vec-${targetOs}-${targetArch}`
  const filename = `vec0.${extension}`
  const version = dependencies[packageName]
  if (!version) {
    console.warn(`sqlite-vec extension package not declared for ${packageName}; vector search will be unavailable`)
    return
  }

  const source = resolveDependencyAsset(packageName, version, filename)
  if (!source) {
    throw new Error(`sqlite-vec extension (${filename}) not found for ${packageName}`)
  }
  await fs.copyFile(source, path.join(runtimeDir, filename))
}

async function copyAstGrep(
  runtimeDir: string,
  targetOs: string,
  targetArch: string,
  dependencies: Record<string, string>,
) {
  const packageName = astGrepPlatformPackages[`${targetOs}-${targetArch}`]
  if (!packageName) return

  const filename = targetOs === "windows" ? "ast-grep.exe" : "ast-grep"
  const source = resolveDependencyAsset(packageName, dependencies[packageName], filename)
  if (!source) {
    console.warn(`ast-grep binary not found for ${packageName}`)
    return
  }

  const destination = path.join(runtimeDir, "bin", filename)
  await fs.copyFile(source, destination)
  if (targetOs !== "windows") await fs.chmod(destination, 0o755)
}

function resolveDependencyAsset(packageName: string, version: string | undefined, filename: string) {
  try {
    const req = createRequire(import.meta.url)
    const packageJsonPath = req.resolve(`${packageName}/package.json`)
    const source = path.join(path.dirname(packageJsonPath), filename)
    if (existsSync(source)) return source
  } catch {}

  for (const entry of Object.values(RELEASE_CATALOG)) {
    const directory = path.join(REPO_ROOT, entry.directory)
    try {
      const ownerRequire = createRequire(path.join(directory, "package.json"))
      const packageJsonPath = ownerRequire.resolve(`${packageName}/package.json`)
      const source = path.join(path.dirname(packageJsonPath), filename)
      if (existsSync(source)) return source
    } catch {}
  }

  let searchDir = PRODUCT_RUNTIME_DIR
  while (searchDir !== path.dirname(searchDir)) {
    const bunCacheBase = path.join(searchDir, "node_modules", ".bun")
    const candidates = [
      version ? path.join(bunCacheBase, `${packageName}@${version}`, "node_modules", packageName, filename) : undefined,
      path.join(bunCacheBase, packageName, "node_modules", packageName, filename),
      path.join(bunCacheBase, "node_modules", packageName, filename),
    ]
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate
    }
    searchDir = path.dirname(searchDir)
  }
  return undefined
}
