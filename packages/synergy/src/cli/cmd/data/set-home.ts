import fs from "fs/promises"
import path from "path"
import os from "os"
import * as prompts from "@clack/prompts"
import { cmd } from "../cmd"
import { UI } from "../../ui"
import { Global } from "../../../global"
import {
  shortenPath,
  dirExists,
  updateShellProfile,
  removeShellProfile,
  isDirEmpty,
  scanCategories,
  formatSize,
} from "./shared"

export const DataSetHomeCommand = cmd({
  command: "set-home <path>",
  describe: "set SYNERGY_HOME to change data location (does not move data)",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "new data home path",
        demandOption: true,
      })
      .option("unset", {
        type: "boolean",
        describe: "remove SYNERGY_HOME, revert to default ~/.synergy",
        default: false,
      }),
  handler: async (args) => {
    const unset = args.unset as boolean
    const inputPath = args.path as string

    UI.empty()
    prompts.intro("Set Data Home")

    if (unset) {
      const result = await removeShellProfile()
      if (result.removed) {
        prompts.log.success(`Removed SYNERGY_HOME from ${shortenPath(result.file!)}`)
      } else {
        prompts.log.info("SYNERGY_HOME is not set in any shell profile")
      }
      prompts.log.info("Data location reverts to ~/.synergy on next shell session")
      prompts.outro("Done")
      return
    }

    const targetPath = path.resolve(inputPath)
    const currentRoot = Global.Path.root
    const currentHome = process.env.SYNERGY_HOME || ""

    // The actual data root is SYNERGY_HOME/.synergy (same as root() logic)
    const targetRoot = targetPath.endsWith(".synergy") ? targetPath : path.join(targetPath, ".synergy")

    prompts.log.info(`Current: ${shortenPath(currentRoot)}`)

    if (targetRoot === currentRoot || targetRoot === path.join(os.homedir(), ".synergy")) {
      if (currentHome && targetRoot === currentRoot) {
        prompts.log.info("SYNERGY_HOME already points to this location")
        prompts.outro("No change needed")
        return
      }
    }

    // Check if target has existing data
    const targetExists = await dirExists(targetRoot)
    const targetEmpty = targetExists ? await isDirEmpty(targetRoot).catch(() => true) : true

    if (targetExists && !targetEmpty) {
      const catStats = await scanCategories(targetRoot)
      let totalSize = 0
      for (const stats of catStats.values()) totalSize += stats.size
      prompts.log.info(`Found existing data at ${shortenPath(targetRoot)} (${formatSize(totalSize)})`)
    }

    // Check if current location has data
    const currentHasData = await dirExists(currentRoot).then(async (exists) => {
      if (!exists) return false
      return !(await isDirEmpty(currentRoot))
    })

    if (currentHasData && !targetExists) {
      const catStats = await scanCategories(currentRoot)
      let totalSize = 0
      for (const stats of catStats.values()) totalSize += stats.size
      prompts.log.warn(
        `Current data at ${shortenPath(currentRoot)} (${formatSize(totalSize)}) will not be moved.\n  Run \`synergy data move ${shortenPath(targetPath)}\` first if needed.`,
      )
    }

    // Create target directory structure
    if (!targetExists) {
      await fs.mkdir(targetRoot, { recursive: true })
      prompts.log.info(`Created directory at ${shortenPath(targetRoot)}`)
    }

    // SYNERGY_HOME = what the user typed (the base path).
    // root() = path.join(SYNERGY_HOME, ".synergy"), which equals targetRoot.
    const envValue = targetPath

    const result = await updateShellProfile(envValue)
    if (result.updated) {
      prompts.log.success(`Added SYNERGY_HOME to ${shortenPath(result.file!)}`)
    } else if (result.file) {
      prompts.log.warn(
        `SYNERGY_HOME already set in ${shortenPath(result.file!)} — verify it points to the right location`,
      )
    } else {
      prompts.log.warn("Could not find a shell profile to update. Add this line manually:")
      prompts.log.info(`  export SYNERGY_HOME=${envValue}`)
    }

    prompts.log.info("Restart your shell for the change to take effect")
    prompts.outro("Done")
  },
})
