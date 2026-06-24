import { cmd } from "./cmd"
import { UI } from "../ui"
import path from "path"
import fs from "fs"
import type { Argv } from "yargs"
import { fetchRegistryApi } from "./plugin-server"

// ---------------------------------------------------------------------------
// publish <tarball>
// ---------------------------------------------------------------------------

interface RegistryPluginVersion {
  version: string
  manifestHash: string
  permissionsHash: string
  risk: "low" | "medium" | "high"
  permissionsSummary: Array<{ key: string; description: string; risk: string }>
  publishedAt: number
  integrity: string
  downloadUrl?: string
}

interface PublishInput {
  id: string
  name: string
  description: string
  author: { name: string; email?: string; url?: string }
  verified: boolean
  official: boolean
  keywords: string[]
  compatibility: { synergy: string }
  versions: RegistryPluginVersion[]
}

export const PluginPublishCommand = cmd({
  command: "publish <tarball>",
  describe: "submit a plugin tarball to the registry",
  builder: (yargs: Argv) =>
    yargs.positional("tarball", {
      type: "string",
      describe: "path to the plugin .tar.gz tarball",
      demandOption: true,
    }),
  async handler(args) {
    const tarballPath = path.resolve(args.tarball as string)

    if (!fs.existsSync(tarballPath)) {
      UI.error(`Tarball not found: ${tarballPath}`)
      process.exitCode = 1
      return
    }

    // Parse metadata from tarball name: <name>-<version>.tar.gz
    const filename = path.basename(tarballPath)
    const match = filename.match(/^(.+)-(\d+\.\d+\.\d+.*)\.tar\.gz$/)
    if (!match) {
      UI.error(`Cannot parse tarball filename: ${filename}`)
      UI.println(
        `${UI.Style.TEXT_DIM}Expected format: <name>-<version>.tar.gz (e.g. my-plugin-1.0.0.tar.gz)${UI.Style.TEXT_NORMAL}`,
      )
      process.exitCode = 1
      return
    }

    const pluginName = match[1]
    const version = match[2]
    const pluginId = pluginName

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Publishing${UI.Style.TEXT_NORMAL} ${pluginName} v${version}`)
    UI.println(`  ${UI.Style.TEXT_DIM}Tarball:${UI.Style.TEXT_NORMAL} ${tarballPath}`)

    // Build publish payload from metadata parsed from tarball name
    const serverUrl = "http://localhost:3000" // registry is local-only in dev mode

    const now = Date.now()
    const input: PublishInput = {
      id: pluginId,
      name: pluginName,
      description: `${pluginName} plugin`,
      author: { name: "unknown" },
      verified: false,
      official: false,
      keywords: ["synergy-plugin"],
      compatibility: { synergy: ">=1.0.0" },
      versions: [
        {
          version,
          manifestHash: "tarball",
          permissionsHash: "tarball",
          risk: "medium",
          permissionsSummary: [],
          publishedAt: now,
          integrity: `sha256:${filename}`,
        },
      ],
    }

    try {
      const result = await fetchRegistryApi<PublishInput>(serverUrl, "/plugins/publish", "POST", input)
      UI.println(
        `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Published ${result.name} v${result.versions[result.versions.length - 1]?.version}`,
      )
      UI.println(`  ${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL} ${result.id}`)
      UI.println(
        `${UI.Style.TEXT_DIM}Updated:${UI.Style.TEXT_NORMAL} ${new Date(result.versions[result.versions.length - 1]?.publishedAt ?? 0).toISOString()}`,
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      UI.error(`Publish failed: ${msg}`)
      process.exitCode = 1
    }
  },
})
