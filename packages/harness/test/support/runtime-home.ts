import fs from "node:fs/promises"
import path from "node:path"
import type { RuntimeHost } from "../../src/lifecycle/context"
import { identifyDirectory, readOrCreateIdentityFile } from "@ericsanchezok/synergy-util/filesystem-identity"

export async function runtimeHome(options: { home?: string } = {}) {
  const home = options.home ?? (await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "runtime-")))
  const root = path.join(home, ".synergy")
  const cache = path.join(root, "cache")
  await fs.mkdir(cache, { recursive: true })
  await Bun.write(path.join(cache, "version"), "15")
  await Bun.write(path.join(cache, "models.json"), Bun.file(process.env.MODELS_DEV_API_JSON!))
  const host: RuntimeHost = {
    home,
    root,
    workspaceLocation: {
      hostID: () => readOrCreateIdentityFile(path.join(root, "workspace-host")),
      identify: identifyDirectory,
    },
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      BASH_ENV: undefined,
      ZDOTDIR: undefined,
      SYNERGY_TEST_HOME: home,
      SYNERGY_HOME: home,
    },
  }
  return {
    host,
    async [Symbol.asyncDispose]() {
      if (!options.home) await fs.rm(home, { recursive: true, force: true })
    },
  }
}
