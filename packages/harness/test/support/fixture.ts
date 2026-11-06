import path from "node:path"
import { createFixture } from "@ericsanchezok/synergy-testing/fixture"
import type { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Scope } from "../../src/scope"
import { Filesystem } from "../../src/util/filesystem"

export { initializeGitFixture, type GitFixtureRunner } from "@ericsanchezok/synergy-testing/fixture"

export const tmpdir = createFixture<Config.Info, Scope>({
  sanitizePath: Filesystem.sanitizePath,
  writeConfig: async (directory, config) => {
    const fragments = ConfigDomain.split({ $schema: "https://synergy.holosai.io/config.json", ...config })
    const configDirectory = path.join(directory, ".synergy")
    await ConfigDomain.ensureDir(configDirectory)
    for (const [id, fragment] of fragments) {
      await Bun.write(ConfigDomain.filepath(id, configDirectory), JSON.stringify(fragment, null, 2))
    }
  },
  scope: async (directory) => (await Scope.fromDirectory(directory)).scope,
})
