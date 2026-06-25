import path from "path"
import type { Argv } from "yargs"
import { cmd } from "../cmd"
import { UI } from "../ui"
import { githubEntry, writeGithubEntry } from "../lib/market-entry"

export const PluginEntryCommand = cmd({
  command: "entry <tarball>",
  describe: "generate a SII-Holos/synergy-plugins registry entry JSON",
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
      .option("write-entry", {
        type: "string",
        describe: "write or update a synergy-plugins plugins/<id>.json entry",
      })
      .option("verified", {
        type: "boolean",
        default: false,
        describe: "mark the entry as verified",
      })
      .option("official", {
        type: "boolean",
        default: false,
        describe: "mark the entry as official",
      })
      .option("changelog", {
        type: "string",
        describe: "version changelog",
      }),
  async handler(args) {
    try {
      const tarballPath = path.resolve(args.tarball as string)
      const entry = githubEntry({
        tarballPath,
        repo: args.repo as string | undefined,
        downloadUrl: args.downloadUrl as string | undefined,
        signatureUrl: args.signatureUrl as string | undefined,
        verified: Boolean(args.verified),
        official: Boolean(args.official),
        changelog: args.changelog as string | undefined,
      })
      const writeEntry = args.writeEntry as string | undefined
      if (writeEntry) {
        const outputPath = path.resolve(writeEntry)
        writeGithubEntry(outputPath, entry)
        UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Wrote GitHub registry entry ${outputPath}`)
      } else {
        UI.println(JSON.stringify(entry, null, 2))
      }
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})
