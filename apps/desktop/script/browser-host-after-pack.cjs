const fs = require("node:fs")
const path = require("node:path")
const asar = require("@electron/asar")

function assertBrowserHostClosure(archive) {
  const allowed = new Set(["/package.json", "/dist", "/dist/browser-host-main.js"])
  const entries = asar.listPackage(archive).map((entry) => entry.replace(/\\/g, "/"))
  for (const entry of entries) {
    if (!allowed.has(entry)) throw new Error(`Unexpected Browser Host archive entry: ${entry}`)
  }
  for (const entry of allowed) {
    if (!entries.includes(entry)) throw new Error(`Missing Browser Host archive entry: ${entry}`)
  }
  const manifest = JSON.parse(asar.extractFile(archive, "package.json").toString())
  if (manifest.main !== "dist/browser-host-main.js" || Object.keys(manifest.dependencies ?? {}).length > 0) {
    throw new Error("Browser Host must use its bundled entry without production package dependencies")
  }
  if (fs.existsSync(`${archive}.unpacked`)) {
    throw new Error("Browser Host must not include unpacked dependencies")
  }
}

exports.assertBrowserHostClosure = assertBrowserHostClosure
exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources")
  assertBrowserHostClosure(path.join(resources, "app.asar"))
}
