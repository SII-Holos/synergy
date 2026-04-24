import * as prompts from "@clack/prompts"
import { cmd } from "../cmd"
import { UI } from "../../ui"
import { CATEGORIES, scanCategories, formatSize, shortenPath, dataRoot } from "./shared"

export const DataPathCommand = cmd({
  command: "path",
  describe: "show current data location and usage",
  builder: (yargs) => yargs,
  handler: async () => {
    const root = dataRoot()
    const catStats = await scanCategories(root)

    let totalSize = 0
    for (const stats of catStats.values()) totalSize += stats.size

    UI.empty()
    prompts.intro("Synergy Data")

    const homeOverride = process.env.SYNERGY_HOME
    if (homeOverride) {
      prompts.log.info(`SYNERGY_HOME=${homeOverride} (overrides default ~/.synergy)`)
    }

    prompts.log.info(`Location: ${shortenPath(root)} (${formatSize(totalSize)})`)

    for (const cat of CATEGORIES) {
      const stats = catStats.get(cat.key)
      if (!stats || stats.size === 0) continue
      const subdirs = cat.subdirs.map((d) => `${d}/`.padEnd(12)).join("  ")
      prompts.log.info(`  ${subdirs} ${formatSize(stats.size)}`)
    }

    if (!homeOverride) {
      UI.empty()
      prompts.log.info(`Set SYNERGY_HOME to change the data location`)
    }

    prompts.outro("Done")
  },
})
