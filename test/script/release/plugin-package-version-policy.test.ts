import { expect, test } from "bun:test"
import path from "node:path"
import { PLUGIN_API_VERSION } from "../../../packages/plugin/src/version"

const repoRoot = path.resolve(import.meta.dir, "../../..")

async function packageVersion(relativePath: string) {
  const packageJson = (await Bun.file(path.join(repoRoot, relativePath)).json()) as { version: string }
  return packageJson.version
}

test("plugin npm packages follow the Synergy package version independently of Plugin API", async () => {
  const synergyVersion = await packageVersion("packages/synergy/package.json")

  expect(await packageVersion("packages/plugin/package.json")).toBe(synergyVersion)
  expect(await packageVersion("packages/plugin-kit/package.json")).toBe(synergyVersion)
  expect(PLUGIN_API_VERSION).toBe("4.0")
})
