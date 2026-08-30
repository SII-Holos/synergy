import type { Argv } from "yargs"
import { UI } from "../../util/ui"
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
        choices: ["npm", "yarn", "pnpm", "bun", "desktop", "standalone"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")

    const inspection = await Installation.inspect()
    let method: Installation.InstalledMethod
    try {
      method = Installation.resolveUpgradeMethod(inspection, args.method as Installation.InstalledMethod | undefined)
    } catch (error) {
      process.exitCode = 1
      if (error instanceof Installation.MultipleInstallationsError) {
        prompts.log.error("Multiple Synergy installations were found. Upgrade was not started.")
        printInstallations(error.data.installations)
        prompts.log.info("Remove an extra installation or rerun with --method <method>.")
      } else if (error instanceof Installation.InstallationMethodNotFoundError) {
        prompts.log.error(`Installation method '${error.data.method}' was not found.`)
        printInstallations(error.data.installations)
      } else if (error instanceof Installation.InstallationProbeFailedError) {
        prompts.log.error(`Unable to verify the installed ${error.data.method} version. Upgrade was not started.`)
      } else if (error instanceof Error) {
        prompts.log.error(error.message)
      }
      prompts.outro("Done")
      return
    }

    prompts.log.info("Using method: " + method)
    const selected = inspection.installations.find((installation) => installation.method === method)
    if (selected && !selected.pathFirst && inspection.path[0]) {
      prompts.log.warn(`PATH currently resolves synergy to ${inspection.path[0].path}.`)
      prompts.log.info("Open a new shell and run `command -v synergy` after upgrading.")
    }

    if (method === "desktop") {
      prompts.log.info("Synergy is installed with the Desktop app.")
      prompts.log.info("Desktop updates are managed from the Synergy app. Open Synergy and use Settings → Updates.")
      prompts.outro("Done")
      return
    }
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest(method)

    if ((selected?.version ?? Installation.VERSION) === target) {
      prompts.log.warn(`synergy upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${selected?.version ?? Installation.VERSION} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target, selected?.executable ?? undefined).catch((err) => err)
    if (err) {
      process.exitCode = 1
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

function printInstallations(installations: Installation.InstalledChannel[]) {
  for (const installation of installations) {
    const version = installation.version ?? "version unavailable"
    const executable = installation.executable ? ` at ${installation.executable}` : ""
    prompts.log.info(`  ${installation.method}: ${version}${executable}`)
  }
}
