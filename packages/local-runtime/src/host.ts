import path from "node:path"
import os from "node:os"
import type { RuntimeHost, RuntimeLaunch } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { RuntimeStorage } from "@ericsanchezok/synergy-harness/lifecycle"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { readOrCreateIdentityFile } from "@ericsanchezok/synergy-util/filesystem-identity"
import { identifyDirectory } from "./workspace/identity"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { spawnSync } from "node:child_process"
import { version } from "../package.json" with { type: "json" }

const launchEntries: readonly RuntimeLaunch["entry"][] = [
  "dev-server",
  "dev-web",
  "dev-desktop",
  "dev-desktop-managed",
  "dev-send",
  "desktop-managed",
  "daemon",
  "cli-server",
  "cli-send",
  "embedded",
]

function localLaunch(env: Record<string, string | undefined>, fallback: RuntimeLaunch["entry"]): RuntimeLaunch {
  const requested = env.SYNERGY_RUNTIME_ENTRY
  const entry =
    env.SYNERGY_DAEMON === "1"
      ? "daemon"
      : env.SYNERGY_DESKTOP_STARTUP_PROGRESS === "1" && requested !== "dev-desktop-managed"
        ? "desktop-managed"
        : (launchEntries.find((entry) => entry === requested) ?? fallback)
  const installed = Boolean(env.SYNERGY_INSTALLATION_PIN) || !Installation.isLocal()
  const sourceCheckout =
    !installed && import.meta.url.endsWith("/src/host.ts") ? path.resolve(import.meta.dir, "../../..") : undefined
  const revision =
    sourceCheckout && env.SYNERGY_AGENT_WORKER !== "1" && env.SYNERGY_POLICY_WORKER !== "1"
      ? spawnSync("git", ["--no-optional-locks", "rev-parse", "--verify", "HEAD"], {
          cwd: sourceCheckout,
          encoding: "utf8",
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
        }).stdout?.trim()
      : undefined
  return {
    entry:
      installed && entry.startsWith("dev-")
        ? env.SYNERGY_DESKTOP_STARTUP_PROGRESS === "1"
          ? "desktop-managed"
          : fallback
        : entry,
    distribution: installed ? "installed" : sourceCheckout ? "source" : "unknown",
    version: Installation.VERSION === "local" ? version : Installation.VERSION,
    channel: Installation.CHANNEL,
    ...(sourceCheckout ? { sourceCheckout } : {}),
    ...(Installation.COMMIT
      ? { revision: Installation.COMMIT }
      : revision && /^[a-f0-9]{40,64}$/.test(revision)
        ? { revision }
        : {}),
  }
}

export function createLocalHost(
  options: {
    home?: string
    root?: string
    env?: Record<string, string | undefined>
    entry?: RuntimeLaunch["entry"]
  } = {},
): RuntimeHost {
  const env = { ...(options.env ?? process.env) }
  const home = path.resolve(options.home ?? env.SYNERGY_HOME ?? env.SYNERGY_TEST_HOME ?? os.homedir())
  const root = path.resolve(options.root ?? env.SYNERGY_RUNTIME_ROOT ?? path.join(home, ".synergy"))
  if (env.SYNERGY_INSTALLATION_ROOT && path.resolve(env.SYNERGY_INSTALLATION_ROOT) !== root) {
    delete env.SYNERGY_INSTALLATION_PIN
    delete env.SYNERGY_INSTALLATION_ROOT
    delete env.SYNERGY_LAUNCHER_COMMAND
  }
  let identity: Promise<string> | undefined
  return {
    home,
    root,
    env: { ...env, SYNERGY_HOME: home, AGENT: "1", SYNERGY: "1" },
    launch: localLaunch(env, options.entry ?? (env.SYNERGY_DAEMON === "1" ? "daemon" : "embedded")),
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
