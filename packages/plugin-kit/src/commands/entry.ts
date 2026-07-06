import path from "path"
import type { Argv } from "yargs"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { copyRegistryEntryIcon, registryEntry, writeRegistryEntry } from "../lib/market-entry.js"

export const PluginEntryCommand = cmd({
  command: "entry <tarball>",
  describe: "generate a marketplace registry entry JSON",
  builder: (yargs: Argv) =>
    yargs
      .positional("tarball", {
        type: "string",
        describe: "path to the plugin .synergy-plugin.tgz tarball",
        demandOption: true,
      })
      .option("repo", {
        type: "string",
        describe: "plugin GitHub repository URL",
      })
      .option("download-url", {
        type: "string",
        describe: "release asset URL for the .synergy-plugin.tgz",
      })
      .option("signature-url", {
        type: "string",
        describe: "release asset URL for the .sig file",
      })
      .option("release-backend", {
        type: "string",
        choices: ["github", "manual"] as const,
        default: "github",
        describe: "release asset URL backend",
      })
      .option("release-url-template", {
        type: "string",
        describe: "release asset URL template using {repo}, {version}, {tag}, and {filename}",
      })
      .option("release-tag-template", {
        type: "string",
        describe: "release tag template used by GitHub URLs; supports {version} and {tag}",
      })
      .option("write-entry", {
        type: "string",
        describe: "write or update a marketplace plugins/<id>.json entry",
      })
      .option("changelog", {
        type: "string",
        describe: "version changelog",
      }),
  async handler(args) {
    try {
      const tarballPath = path.resolve(args.tarball as string)
      const entry = registryEntry({
        tarballPath,
        repo: args.repo as string | undefined,
        downloadUrl: args.downloadUrl as string | undefined,
        signatureUrl: args.signatureUrl as string | undefined,
        releaseBackend: args["release-backend"] as "github" | "manual" | undefined,
        releaseUrlTemplate: args["release-url-template"] as string | undefined,
        releaseTagTemplate: args["release-tag-template"] as string | undefined,
        changelog: args.changelog as string | undefined,
      })
      const writeEntry = args.writeEntry as string | undefined
      if (writeEntry) {
        const outputPath = path.resolve(writeEntry)
        writeRegistryEntry(outputPath, entry)
        copyRegistryEntryIcon({ tarballPath, entryPath: outputPath, entry })
        UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Wrote marketplace registry entry ${outputPath}`)
      } else {
        UI.println(JSON.stringify(entry, null, 2))
      }
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})
