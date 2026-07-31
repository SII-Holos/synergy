import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../global/installation"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade synergy to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["npm", "yarn", "pnpm", "bun", "brew", "desktop", "standalone"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`Unable to determine how ${process.execPath} was installed.`)
      prompts.log.info("Reinstall with the official installer or pass a supported --method option.")
      prompts.outro("Done")
      return
    }
    prompts.log.info("Using method: " + method)
    if (method === "desktop") {
      const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest("desktop")
      if (Installation.VERSION === target) {
        prompts.log.warn(`synergy upgrade skipped: ${target} is already installed`)
      }
      prompts.log.info("Synergy is installed with the Desktop app.")
      prompts.log.info("Desktop updates are managed from the Synergy app. Open Synergy and use Settings → Updates.")
      prompts.outro("Done")
      return
    }
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest(method)

    if (Installation.VERSION === target) {
      prompts.log.warn(`synergy upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${Installation.VERSION} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) prompts.log.error(err.data.stderr)
      else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")

    prompts.outro("Done")
  },
}
