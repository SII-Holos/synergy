const fs = require("node:fs")
const path = require("node:path")
const { createRequire } = require("node:module")
const { assertRuntimeAssets, prepareRuntimeSeal } = require("./runtime-seal.cjs")
const builderRequire = createRequire(require.resolve("electron-builder"))
const { signAsync } = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/osx-sign")

exports.sign = async function sign(options) {
  const app = path.resolve(options.app)
  const runtimeDir = path.join(app, "Contents/Resources/synergy")
  const reseal = fs.existsSync(runtimeDir) ? prepareRuntimeSeal(runtimeDir) : undefined
  const signedFiles = new Set()
  let sealed = false
  await signAsync({
    ...options,
    // Provenance: https://unpkg.com/@electron/osx-sign@1.3.3/dist/cjs/sign.js
    // and https://unpkg.com/@electron/osx-sign@1.3.3/dist/cjs/types.d.ts (children precede app; synchronous optionsForFile).
    // Local adaptation: reseal at the app callback, before its signature covers the manifests.
    optionsForFile(file) {
      if (sealed) throw new Error("macOS signing attempted to mutate the app after runtime sealing")
      const perFile = options.optionsForFile?.(file)
      const absolute = path.resolve(file)
      if (absolute === app) {
        reseal?.(signedFiles)
        sealed = true
      } else signedFiles.add(absolute)
      return perFile
    },
  })
  if (!sealed) throw new Error("macOS signing did not sign the top-level app")
  if (reseal) assertRuntimeAssets(runtimeDir)
}
