import path from "node:path"
import os from "node:os"
import type { RuntimeHost } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { RuntimeStorage } from "@ericsanchezok/synergy-harness/lifecycle"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { identifyDirectory, readOrCreateIdentityFile } from "@ericsanchezok/synergy-util/filesystem-identity"

export function createLocalHost(
  options: { home?: string; root?: string; env?: Record<string, string | undefined> } = {},
): RuntimeHost {
  const env = { ...(options.env ?? process.env) }
  const home = path.resolve(options.home ?? env.SYNERGY_HOME ?? env.SYNERGY_TEST_HOME ?? os.homedir())
  const root = path.resolve(options.root ?? env.SYNERGY_RUNTIME_ROOT ?? path.join(home, ".synergy"))
  let identity: Promise<string> | undefined
  return {
    home,
    root,
    env: { ...env, SYNERGY_HOME: home, AGENT: "1", SYNERGY: "1" },
    workspaceLocation: {
      hostID: () => (identity ??= readOrCreateIdentityFile(path.join(root, "workspace-host"))),
      identify: identifyDirectory,
    },
  }
}

export function createLocalStorage(
  host: RuntimeHost,
  progress?: Parameters<typeof StorageBootstrap.prepare>[0]["progress"],
): RuntimeStorage {
  return {
    kind: "owned",
    async open() {
      const prepared = await StorageBootstrap.prepare({ root: host.root, progress })
      return {
        handle: { store: prepared.store, artifactDirectory: path.join(host.root, "data") },
        needsValidation: prepared.manifest.phase !== "active",
        activate: () => prepared.activate(),
      }
    },
  }
}
