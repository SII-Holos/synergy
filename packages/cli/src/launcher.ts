import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { z } from "zod"
import { serialize } from "node:v8"
import {
  prepareInstalledLaunch,
  verifyInstalledWorkerPlan,
} from "@ericsanchezok/synergy-plugin-host/installation/bootstrap"
import { loadInstalledComponents } from "@ericsanchezok/synergy-plugin-host/installation/component-loader"
import { version as packageVersion } from "../package.json" with { type: "json" }

declare const SYNERGY_STANDALONE: boolean | undefined
declare const SYNERGY_LIBC: string | undefined
declare const SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY: string | undefined

export async function launch() {
  const earlyMessages: unknown[] = []
  let earlyBytes = 0
  const receive = (message: unknown) => {
    earlyBytes += serialize(message).byteLength
    if (earlyMessages.length >= 256 || earlyBytes > 64 * 1024 * 1024)
      throw new Error("Worker bootstrap IPC queue exceeded its limit")
    earlyMessages.push(message)
  }
  if (process.send) process.on("message", receive)
  const resumeWorker = () => {
    process.off("message", receive)
    for (const message of earlyMessages.splice(0)) process.emit("message", message, undefined)
  }
  const standalone = typeof SYNERGY_STANDALONE === "boolean" && SYNERGY_STANDALONE
  const version = typeof SYNERGY_VERSION === "string" ? SYNERGY_VERSION : packageVersion
  const home = path.resolve(process.env.SYNERGY_HOME ?? process.env.SYNERGY_TEST_HOME ?? os.homedir())
  const root = path.resolve(process.env.SYNERGY_RUNTIME_ROOT ?? path.join(home, ".synergy"))
  const seed = path.resolve(path.dirname(process.execPath), "../runtime")
  const runner = process.argv.find((arg) => arg.startsWith("__"))
  if (runner?.endsWith("-runner") && !process.env.SYNERGY_INSTALLATION_PIN)
    throw new Error("An installed worker requires its parent installation pin")
  const installationRoot =
    runner && process.env.SYNERGY_INSTALLATION_PIN ? path.resolve(process.env.SYNERGY_INSTALLATION_ROOT ?? root) : root
  const generation = await prepareInstalledLaunch(installationRoot, {
    version,
    ...(!standalone ? { installedCore: path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))) } : {}),
    pin: runner ? process.env.SYNERGY_INSTALLATION_PIN : undefined,
    ...(standalone &&
    (await fs.access(path.join(seed, "generation.json")).then(
      () => true,
      () => false,
    ))
      ? { seed }
      : {}),
  })
  Object.assign(globalThis, {
    SYNERGY_VERSION: generation.hostVersion,
    SYNERGY_CHANNEL: typeof SYNERGY_CHANNEL === "string" ? SYNERGY_CHANNEL : "stable",
    SYNERGY_COMMIT: typeof SYNERGY_COMMIT === "string" ? SYNERGY_COMMIT : "",
    SYNERGY_SANDBOX_HELPER_SHA256:
      typeof SYNERGY_SANDBOX_HELPER_SHA256 === "string" ? SYNERGY_SANDBOX_HELPER_SHA256 : "",
    SYNERGY_LIBC: typeof SYNERGY_LIBC === "string" ? SYNERGY_LIBC : undefined,
    SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY:
      typeof SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY === "string" ? SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY : "",
  })
  process.env.SYNERGY_HOME = home
  process.env.SYNERGY_RUNTIME_ROOT = root
  process.env.SYNERGY_INSTALLATION_ROOT = installationRoot
  process.env.SYNERGY_INSTALLATION_PIN = JSON.stringify({ id: generation.id, sha256: generation.sha256 })
  process.env.SYNERGY_LAUNCHER_COMMAND = JSON.stringify(
    standalone ? [process.execPath] : [process.execPath, fileURLToPath(import.meta.url)],
  )
  if (runner === "__agent-turn-runner" || runner === "__policy-worker-runner")
    await verifyInstalledWorkerPlan(generation, process.env.SYNERGY_WORKER_COMPONENTS)
  const entry = Bun.resolveSync("@ericsanchezok/synergy-cli/index", generation.directory)
  const cli: typeof import("./index") = await import(pathToFileURL(entry).href)
  if (runner) {
    const candidates = Object.values(generation.packages).flatMap((pkg) => {
      const selected = pkg.metadata?.kind === "component" ? pkg.metadata.runners?.[runner.slice(2)] : undefined
      return selected ? [{ directory: pkg.directory, ...selected }] : []
    })
    if (candidates.length > 1) throw new Error(`Component runner is ambiguous: ${runner}`)
    if (candidates.length === 1) {
      const selected = candidates[0]
      const relative = path.posix.join(selected.directory, selected.entry)
      if (generation.files[relative]?.kind !== "file")
        throw new Error("Component runner is outside its sealed generation")
      await cli.runComponentRunner(pathToFileURL(path.join(generation.directory, relative)), selected.export)
      return
    }
  }
  const components =
    runner && runner !== "__storage-maintenance-runner"
      ? []
      : await loadInstalledComponents(
          generation,
          process.env.SYNERGY_COMPONENTS
            ? z.record(z.string(), z.string()).parse(JSON.parse(process.env.SYNERGY_COMPONENTS))
            : undefined,
        )
  await cli.main(components, resumeWorker)
}

if (import.meta.main) {
  try {
    await launch()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}
