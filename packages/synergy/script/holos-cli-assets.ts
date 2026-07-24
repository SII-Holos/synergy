import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const PACKAGE_NAME = "@sii-holos/holos-cli"
const DEPENDENCIES = ["ws", "zod"] as const
export const HOLOS_CLI_RUNTIME_PATH = path.join("lib", "holos-cli")

function packageRoot(packageName: string, paths?: string[]): string {
  const require = createRequire(import.meta.url)
  const packageJson = require.resolve(`${packageName}/package.json`, paths ? { paths } : undefined)
  return path.dirname(packageJson)
}

export function copyHolosCliAsset(targetDirectory: string): void {
  const cliRoot = packageRoot(PACKAGE_NAME)
  const destination = path.join(targetDirectory, HOLOS_CLI_RUNTIME_PATH)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  fs.cpSync(path.join(cliRoot, "dist"), destination, { recursive: true })

  const dependencyRoot = path.join(destination, "node_modules")
  fs.mkdirSync(dependencyRoot, { recursive: true })
  for (const dependency of DEPENDENCIES) {
    const source = packageRoot(dependency, [cliRoot])
    fs.cpSync(source, path.join(dependencyRoot, dependency), { recursive: true })
  }
  assertPackagedHolosCliAsset(targetDirectory)
}

export function assertPackagedHolosCliAsset(targetDirectory: string): void {
  const root = path.join(targetDirectory, HOLOS_CLI_RUNTIME_PATH)
  const required = [
    path.join(root, "index.js"),
    path.join(root, "vendor", "clarus-shared", "index.js"),
    path.join(root, "node_modules", "ws", "package.json"),
    path.join(root, "node_modules", "zod", "package.json"),
  ]
  for (const file of required) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Packaged Synergy runtime is missing ${path.relative(targetDirectory, file)}`)
    }
  }
}
