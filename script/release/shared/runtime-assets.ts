import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { APP_DIST_DIR, SYNERGY_DIR, SYNERGY_DIST_DIR } from "./packages"
import { stagePlaywrightCoreRuntime } from "../../../packages/synergy/script/playwright-runtime-assets"
import { writeRuntimeManifest } from "./runtime-contract"

type RuntimeCoreAssetOptions = {
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

export async function prepareRuntimeCoreAssets(options: RuntimeCoreAssetOptions) {
  const appDistDir = options.appDistDir ?? APP_DIST_DIR
  const schemaPath = options.schemaPath ?? path.join(SYNERGY_DIR, "schema/config.schema.json")
  const appIndexPath = path.join(appDistDir, "index.html")

  if (!(await Bun.file(appIndexPath).exists())) {
    throw new Error(`Web application entry point is missing: ${appIndexPath}`)
  }
  if (!(await Bun.file(schemaPath).exists())) {
    throw new Error(`Runtime configuration schema is missing: ${schemaPath}`)
  }

  const appDestination = path.join(options.runtimeDir, "app")
  await fs.rm(appDestination, { recursive: true, force: true })
  await fs.cp(appDistDir, appDestination, { recursive: true })

  const schemaDestination = path.join(options.runtimeDir, "schema/config.schema.json")
  await fs.mkdir(path.dirname(schemaDestination), { recursive: true })
  await fs.copyFile(schemaPath, schemaDestination)
  await stagePlaywrightCoreRuntime({
    runtimeDir: options.runtimeDir,
    playwrightCoreDir: options.playwrightCoreDir,
  })
}

export async function prepareRuntimeAssets(name: string) {
  const runtimeDir = path.join(SYNERGY_DIST_DIR, name)
  if (!existsSync(path.join(runtimeDir, "bin"))) {
    throw new Error(`Runtime binary directory is missing: ${runtimeDir}`)
  }

  await prepareRuntimeCoreAssets({ runtimeDir })

  const dependencies = await runtimeDependencies()
  const { targetOs, targetArch, musl } = runtimeTarget(name)
  if (musl) {
    await removeUnsupportedMuslAssets(runtimeDir)
    console.warn(`Skipping ast-grep and sqlite-vec for ${name}; no musl-compatible release assets are available`)
  } else {
    await copySqliteVec(runtimeDir, targetOs, targetArch, dependencies)
    await copyAstGrep(runtimeDir, targetOs, targetArch, dependencies)
  }
  // The watcher binding is copied for every target including musl: unlike
  // ast-grep/sqlite-vec, @parcel/watcher publishes musl packages.
  await copyWatcherBinding(runtimeDir, targetOs, targetArch, musl, dependencies)
  await writeRuntimeManifest(runtimeDir, name)
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

async function runtimeDependencies() {
  const pkg = (await Bun.file(path.join(SYNERGY_DIR, "package.json")).json()) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return { ...pkg.dependencies, ...pkg.devDependencies }
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

  const localPath = path.join(SYNERGY_DIR, "node_modules", packageName, filename)
  if (existsSync(localPath)) return localPath

  let searchDir = SYNERGY_DIR
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
