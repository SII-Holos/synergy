const path = require("node:path")
const { createRequire } = require("node:module")
const builderRequire = createRequire(require.resolve("electron-builder"))
builderRequire("app-builder-lib")
const { MacPackager } = builderRequire("app-builder-lib/out/macPackager")
const { MacTargetHelper } = builderRequire("app-builder-lib/out/mac/MacTargetHelper")
const config = require("../../electron-builder.json")

const app = process.argv[2]
const entitlements = path.resolve(__dirname, "../../build/entitlements.mac.plist")

async function main() {
  const packager = {
    appInfo: { type: "module" },
    info: { getWorkspaceRoot: async () => path.resolve(__dirname, "../../../..") },
    config: { electronVersion: require("../../package.json").devDependencies.electron },
    resourceList: Promise.resolve([]),
    platformSpecificBuildOptions: config.mac,
    expandArch: (destination) => [destination],
  }
  const identity = { name: "-", hash: "-" }
  const options = await new MacTargetHelper(packager).buildSignOptions(
    app,
    identity,
    "distribution",
    false,
    { ...config.mac, entitlements, entitlementsInherit: entitlements, timestamp: "none", preAutoEntitlements: false },
    undefined,
    process.arch === "arm64" ? 3 : 1,
  )
  const optionsForFile = options.optionsForFile
  await MacPackager.prototype.doSign.call(
    packager,
    {
      ...options,
      preEmbedProvisioningProfile: false,
      optionsForFile(file) {
        const result = optionsForFile(file)
        if (process.argv[3] === "fail-child" || (process.argv[3] === "fail-app" && file === app)) {
          return { ...result, entitlements: path.join(app, "missing-entitlements.plist") }
        }
        return result
      },
    },
    config.mac,
    identity,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
