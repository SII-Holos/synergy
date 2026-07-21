import fs from "fs"
import path from "path"
import type { Argv } from "yargs"
import { PluginArtifact, PluginManifest } from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { buildPluginProject } from "./build.js"

function debounce(delay: number, callback: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(callback, delay)
  }
}

export async function publishGeneration(pluginDir: string, serverUrl?: string) {
  const root = path.join(pluginDir, "dist", "dev")
  const staging = path.join(root, `.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(root, { recursive: true })
  const built = await buildPluginProject(pluginDir, { outputDir: staging })
  if (!built) {
    fs.rmSync(staging, { recursive: true, force: true })
    return false
  }
  const manifest = PluginManifest.parse(
    JSON.parse(fs.readFileSync(path.join(staging, PluginArtifact.manifestFile), "utf-8")),
  )
  const generationDir = path.join(root, manifest.artifacts.generation)
  if (fs.existsSync(generationDir)) fs.rmSync(staging, { recursive: true, force: true })
  else fs.renameSync(staging, generationDir)

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

  if (serverUrl) {
    if (!process.env.SYNERGY_HOME) {
      throw new Error("Live reload requires an explicit isolated SYNERGY_HOME")
    }
    const response = await fetch(new URL("/plugin/dev/reload", serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: manifest.id,
        generation: manifest.artifacts.generation,
        artifactDir: generationDir,
      }),
    })
    if (!response.ok) throw new Error(`Synergy dev reload failed: ${response.status} ${await response.text()}`)
  }
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
    let building = false
    let queued = false
    const build = async () => {
      if (building) {
        queued = true
        return
      }
      building = true
      try {
        await publishGeneration(pluginDir, serverUrl)
      } catch (error) {
        UI.error(error instanceof Error ? error.message : String(error))
      } finally {
        building = false
        if (queued) {
          queued = false
          void build()
        }
      }
    }
    await build()
    UI.println(`Watching ${pluginDir}`)
    const schedule = debounce(200, () => void build())
    const watchers = ["src", "package.json", "themes", "icons"]
      .map((relative) => path.join(pluginDir, relative))
      .filter((target) => fs.existsSync(target))
      .map((target) => fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, schedule))

    const shutdown = () => {
      for (const watcher of watchers) watcher.close()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  },
})
