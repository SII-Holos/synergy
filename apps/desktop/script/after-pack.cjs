const fs = require("node:fs")
const crypto = require("node:crypto")
const path = require("node:path")
const { requiredRuntimeArtifactPaths } = require("../../../script/release/shared/runtime-layout.cjs")

exports.default = async function afterPack(context) {
  const runtimeName = runtimePackageName(context.electronPlatformName, context.arch)
  const source = path.resolve(__dirname, "../../../packages/presets/dist", runtimeName)
  if (!fs.existsSync(source)) {
    if (process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME === "1") {
      console.warn(`Synergy runtime is missing for desktop package: ${source}`)
      return
    }
    throw new Error(`Synergy runtime is missing for desktop package: ${source}`)
  }

  assertRuntimeAssets(source, context.electronPlatformName, archName(context.arch))

  const destination = path.join(resourcesPath(context), "synergy")
  fs.rmSync(destination, { recursive: true, force: true })
  copyDirectory(source, destination)
  writeDesktopPackageMetadata(destination, context)
}

function assertRuntimeAssets(runtimeDir, platform, arch = "x64") {
  const manifestPath = path.join(runtimeDir, "runtime-manifest.sha256")
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Synergy runtime manifest is missing: ${manifestPath}`)
  }

  const files = runtimeFiles(runtimeDir)

  const entries = new Map()
  for (const line of fs.readFileSync(manifestPath, "utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    const checksum = match?.[1]
    const relative = match?.[2]
    const components = relative?.split("/")
    if (
      !checksum ||
      !relative ||
      relative.startsWith("/") ||
      /[\\\x00-\x1f\x7f]/.test(relative) ||
      /^[A-Za-z]:/.test(relative) ||
      components?.some((component) => !component || component === "." || component === "..")
    ) {
      throw new Error(`Synergy runtime manifest contains an invalid entry: ${manifestPath}`)
    }
    if (entries.has(relative)) {
      throw new Error(`Synergy runtime manifest contains a duplicate entry ${relative}`)
    }
    entries.set(relative, checksum)
  }

  for (const file of files) {
    if (!entries.has(file)) throw new Error(`Synergy runtime manifest contains an unlisted file: ${file}`)
  }
  for (const relative of requiredRuntimeArtifactPaths(runtimePackageName(platform, arch))) {
    if (!entries.has(relative)) {
      throw new Error(`Synergy runtime manifest is missing required entry ${relative}: ${runtimeDir}`)
    }
  }

  for (const [relative, expected] of entries) {
    const absolute = path.join(runtimeDir, relative)
    if (!fs.existsSync(absolute)) {
      throw new Error(`Synergy runtime manifest file is missing: ${relative}`)
    }
    if (!runtimeFileIsSafe(runtimeDir, relative)) {
      throw new Error(`Synergy runtime manifest file is unsafe: ${relative}`)
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
    if (actual !== expected) {
      throw new Error(`Synergy runtime manifest checksum mismatch: ${relative}`)
    }
  }
}

function runtimeFileIsSafe(runtimeDir, relative) {
  const components = relative.split("/")
  let current = runtimeDir
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    const info = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!info || info.isSymbolicLink()) return false
    if (index < components.length - 1 && !info.isDirectory()) return false
    if (index === components.length - 1 && !info.isFile()) return false
  }
  return true
}

function runtimeFiles(runtimeDir) {
  const files = []
  const pending = [runtimeDir]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Synergy runtime contains a symbolic link: ${path.relative(runtimeDir, absolute)}`)
      }
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) {
        const relative = path.relative(runtimeDir, absolute).split(path.sep).join("/")
        if (!["package.json", "runtime-manifest.sha256"].includes(relative)) files.push(relative)
      } else throw new Error(`Synergy runtime contains an unsupported file: ${absolute}`)
    }
  }
  return files
}

exports.assertRuntimeAssets = assertRuntimeAssets

function runtimePackageName(platform, arch) {
  const platformName = platform === "win32" ? "windows" : platform
  return `synergy-${platformName}-${archName(arch)}`
}

function archName(arch) {
  if (arch === "x64" || arch === 1) return "x64"
  if (arch === "arm64" || arch === 3) return "arm64"
  if (arch === "ia32" || arch === 0) return "ia32"
  return String(arch)
}

function resourcesPath(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
  }
  return path.join(context.appOutDir, "resources")
}

function writeDesktopPackageMetadata(destination, context) {
  const version = context.packager?.appInfo?.version || packageVersion()
  fs.writeFileSync(path.join(destination, "desktop-package.json"), `${JSON.stringify({ version }, null, 2)}\n`)
}

function packageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"))
  return packageJson.version
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
      continue
    }
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath)
      continue
    }
    fs.copyFileSync(sourcePath, destinationPath)
  }
}
