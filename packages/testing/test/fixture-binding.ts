import { createFixture } from "../src/fixture"
import path from "node:path"

export const tmpdir = createFixture<Record<string, unknown>, string>({
  sanitizePath: (value) => value,
  writeConfig: async (directory, config) => {
    await Bun.write(path.join(directory, "fixture-config.json"), JSON.stringify(config))
  },
  scope: async (directory) => directory,
})
