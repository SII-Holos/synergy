const fs = require("node:fs")
const path = require("node:path")

exports.default = async function afterPack(context) {
  const runtimeName = runtimePackageName(context.electronPlatformName, context.arch)
  const source = path.resolve(__dirname, "../../synergy/dist", runtimeName)
  if (!fs.existsSync(source)) {
    if (process.env.SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME === "1") {
      console.warn(`Synergy runtime is missing for desktop package: ${source}`)
      return
    }
    throw new Error(`Synergy runtime is missing for desktop package: ${source}`)
  }

  const destination = path.join(resourcesPath(context), "synergy")
  fs.rmSync(destination, { recursive: true, force: true })
  copyDirectory(source, destination)
}

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
