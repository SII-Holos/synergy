import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { watchPluginSources } from "../lib/source-watch.js"
import fs from "fs"
import path from "path"
import type { Argv } from "yargs"
import { PluginArtifact, PluginManifest } from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { buildPluginProject } from "./build.js"

export async function publishGeneration(
  pluginDir: string,
  serverUrl?: string,
  dependencies?: (files: string[], valid: boolean) => void,
  isolatedHome = process.env.SYNERGY_HOME,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const root = path.join(pluginDir, "dist", "dev")
  const staging = path.join(root, `.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(root, { recursive: true })
  const built = await buildPluginProject(pluginDir, { outputDir: staging, dependencies })
  if (!built || signal?.aborted) {
    fs.rmSync(staging, { recursive: true, force: true })
    return false
  }
  const manifest = PluginManifest.parse(
    JSON.parse(fs.readFileSync(path.join(staging, PluginArtifact.manifestFile), "utf-8")),
  )
  const generationDir = path.join(root, manifest.artifacts.generation)
  if (fs.existsSync(generationDir)) fs.rmSync(staging, { recursive: true, force: true })
  else fs.renameSync(staging, generationDir)

  if (serverUrl) {
    if (!isolatedHome) {
      throw new Error("Live reload requires an explicit isolated SYNERGY_HOME")
    }
    const client = createSynergyClient({ baseUrl: serverUrl })
    const result = await client.plugin.reloadDevelopment(
      {
        pluginId: manifest.id,
        generation: manifest.artifacts.generation,
        artifactDir: generationDir,
      },
      { signal },
    )
    if (result.error) {
      const error: unknown = result.error
      const message = typeof error === "string" ? error : JSON.stringify(error)
      throw new Error(`Synergy dev reload failed: ${result.response.status} ${message}`)
    }
  }
  const pointer = path.join(root, "current.json")
  const temporaryPointer = `${pointer}.tmp`
  fs.writeFileSync(
    temporaryPointer,
    `${JSON.stringify({ pluginId: manifest.id, generation: manifest.artifacts.generation, directory: generationDir }, null, 2)}\n`,
  )
  fs.renameSync(temporaryPointer, pointer)

  const generations = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".staging-"))
    .map((entry) => ({ name: entry.name, time: fs.statSync(path.join(root, entry.name)).mtimeMs }))
    .sort((left, right) => right.time - left.time)
  for (const old of generations.slice(3)) fs.rmSync(path.join(root, old.name), { recursive: true, force: true })

  UI.println(`generation ${manifest.artifacts.generation.slice(0, 12)} ready`)
  return true
}

export const PluginDevCommand = cmd({
  command: "dev [path]",
  describe: "watch, rebuild, and atomically reload a plugin generation",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", { type: "string", describe: "plugin directory (defaults to cwd)" })
      .option("server-url", { type: "string", describe: "isolated Synergy server URL for live reload" }),
  async handler(args) {
    const pluginDir = path.resolve((args.path as string) ?? process.cwd())
    const serverUrl = args["server-url"] as string | undefined
    const watcher = watchPluginProject(pluginDir, { serverUrl, initialBuild: true })
    const shutdown = async () => {
      await watcher.close()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  },
})

export function watchPluginProject(
  pluginDir: string,
  options: { serverUrl?: string; isolatedHome?: string; initialBuild?: boolean } = {},
) {
  let closed = false
  const controller = new AbortController()
  let pending: Promise<void> | undefined
  let building = false
  let queued = false
  const build = async () => {
    if (closed) return
    if (building) {
      queued = true
      return
    }
    building = true
    try {
      await publishGeneration(pluginDir, options.serverUrl, watcher.update, options.isolatedHome, controller.signal)
    } catch (error) {
      if (!closed) UI.error(error instanceof Error ? error.message : String(error))
    } finally {
      building = false
      if (queued) {
        queued = false
        start()
      }
    }
  }
  const start = () => {
    if (closed) return
    if (building) {
      queued = true
      return
    }
    pending = build()
  }
  const watcher = watchPluginSources(pluginDir, start)
  if (options.initialBuild) start()
  UI.println(`Watching ${pluginDir}`)

  return {
    async close() {
      closed = true
      queued = false
      watcher.close()
      controller.abort()
      await pending
    },
  }
}
