import type { Argv } from "yargs"
import { UI } from "../../util/ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../global/installation"
import { DesktopInstallation } from "../../global/desktop-installation"
import { StandaloneInstallation } from "../../global/standalone-installation"
import { Global } from "../../global"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import os from "os"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  installationOnly: boolean
  method?: string
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfigs: string[]
  standaloneHome: string | null
  desktopCliLink: string | null
  desktopPathEntry: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: "uninstall synergy and remove all related files",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("installation-only", {
        type: "boolean",
        describe: "remove only the selected installation channel and preserve user data",
        default: false,
      })
      .option("method", {
        alias: "m",
        describe: "installed channel to remove when multiple channels coexist",
        type: "string",
        choices: ["npm", "yarn", "pnpm", "bun", "desktop", "standalone"],
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall Synergy")

    const inspection = await Installation.inspect()
    let method: Installation.InstalledMethod
    try {
      method = Installation.resolveRemovalMethod(inspection, args.method as Installation.InstalledMethod | undefined)
    } catch (error) {
      process.exitCode = 1
      if (error instanceof Installation.MultipleInstallationsError) {
        prompts.log.error("Multiple Synergy installations were found. Select one with --method <method>.")
      } else if (error instanceof Installation.InstallationMethodNotFoundError) {
        prompts.log.error(`Installation method '${error.data.method}' was not found.`)
      } else if (error instanceof Error) {
        prompts.log.error(error.message)
      }
      prompts.outro("Done")
      return
    }
    prompts.log.info(`Installation method: ${method}`)

    const selected = inspection.installations.find((installation) => installation.method === method)
    const targets = await collectRemovalTargets(args, method, selected)

    await showRemovalSummary(targets, method)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    const errors = await executeUninstall(method, targets)
    if (errors.length > 0) process.exitCode = 1

    prompts.outro("Done")
  },
}

async function collectRemovalTargets(
  args: UninstallArgs,
  method: Installation.InstalledMethod,
  selected?: Installation.InstalledChannel,
): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.installationOnly || args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: args.installationOnly },
    { path: Global.Path.config, label: "Config", keep: args.installationOnly || args.keepConfig },
    { path: Global.Path.state, label: "State", keep: args.installationOnly },
  ]

  let shellConfigs: string[] = []
  let standaloneHome: string | null = null
  let desktopCliLink: string | null = null
  let desktopPathEntry: string | null = null

  if (method === "standalone") {
    const executable = selected?.executable ?? process.execPath
    const realExecPath = await fs.realpath(executable).catch(() => executable)
    standaloneHome =
      StandaloneInstallation.installationHome({
        platform: process.platform,
        execPath: executable,
        realExecPath,
        env: process.env,
      }) ?? os.homedir()
    if (process.platform !== "win32") {
      shellConfigs = await StandaloneInstallation.findShellConfigs({
        home: standaloneHome,
        shell: process.env.SHELL,
        xdgConfigHome: process.env.XDG_CONFIG_HOME,
      })
    }
  }

  if (method === "desktop") {
    const executable = selected?.executable ?? process.execPath
    const realExecPath = await fs.realpath(executable).catch(() => executable)
    const context = { platform: process.platform, execPath: executable, realExecPath, env: process.env }
    const cliLink = await DesktopInstallation.inspectCliLink(context)
    if (cliLink.path && (cliLink.status === "healthy" || cliLink.status === "broken")) {
      desktopCliLink = cliLink.path
    }
    desktopPathEntry = DesktopInstallation.launcherDirectory(context)
  }

  return { directories, shellConfigs, standaloneHome, desktopCliLink, desktopPathEntry }
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.InstalledMethod) {
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.standaloneHome) {
    prompts.log.info(`  ✓ Standalone runtime files: ${shortenPath(path.join(targets.standaloneHome, ".synergy"))}`)
  }

  for (const shellConfig of targets.shellConfigs) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(shellConfig)}`)
  }

  if (targets.desktopCliLink) {
    prompts.log.info(`  ✓ Desktop CLI link: ${shortenPath(targets.desktopCliLink)}`)
  }

  if (targets.desktopPathEntry) {
    prompts.log.info(`  ✓ Desktop CLI PATH entry: ${shortenPath(targets.desktopPathEntry)}`)
  }

  if (method === "desktop") {
    prompts.log.info(`  ○ Desktop app: ${DesktopInstallation.desktopRemovalHint(process.platform)}`)
    return
  }

  if (method !== "standalone") {
    const cmds: Record<string, string> = {
      npm: "npm uninstall -g @ericsanchezok/synergy",
      pnpm: "pnpm uninstall -g @ericsanchezok/synergy",
      bun: "bun remove -g @ericsanchezok/synergy",
      yarn: "yarn global remove @ericsanchezok/synergy",
    }
    prompts.log.info(`  ✓ Package: ${cmds[method] || method}`)
  }
}

async function executeUninstall(method: Installation.InstalledMethod, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (preserved)`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.standaloneHome) {
    spinner.start("Removing standalone runtime...")
    const currentExecutable = await fs.realpath(process.execPath).catch(() => process.execPath)
    const result = await StandaloneInstallation.remove({
      home: targets.standaloneHome,
      platform: process.platform,
      currentExecutable,
    }).catch((error) => error)
    if (result instanceof Error) {
      spinner.stop("Failed to remove standalone runtime", 1)
      errors.push(`Standalone runtime: ${result.message}`)
    } else if (result.deferred.length > 0) {
      spinner.stop("Standalone runtime removal will finish after Synergy exits")
    } else {
      spinner.stop("Removed standalone runtime")
    }
  }

  for (const shellConfig of targets.shellConfigs) {
    spinner.start(`Cleaning shell config ${shortenPath(shellConfig)}...`)
    const err = await StandaloneInstallation.cleanShellConfig(shellConfig, targets.standaloneHome!).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to clean shell config ${shortenPath(shellConfig)}`, 1)
      errors.push(`Shell config ${shortenPath(shellConfig)}: ${err.message}`)
    } else {
      spinner.stop(`Cleaned shell config ${shortenPath(shellConfig)}`)
    }
  }

  if (targets.desktopCliLink) {
    spinner.start("Removing Desktop CLI link...")
    const err = await fs.rm(targets.desktopCliLink, { force: true }).catch((e) => e)
    if (err) {
      spinner.stop("Failed to remove Desktop CLI link", 1)
      errors.push(`Desktop CLI link: ${err.message}`)
    } else {
      spinner.stop("Removed Desktop CLI link")
    }
  }

  if (method === "desktop" && targets.desktopPathEntry && process.platform === "win32") {
    spinner.start("Removing Desktop CLI PATH entry...")
    const result = await DesktopInstallation.removeWindowsUserPathEntry(targets.desktopPathEntry).catch((e) => e)
    if (result instanceof Error) {
      spinner.stop("Failed to remove Desktop CLI PATH entry", 1)
      errors.push(`Desktop CLI PATH entry: ${result.message}`)
    } else if (result.removed) {
      spinner.stop("Removed Desktop CLI PATH entry")
    } else {
      spinner.stop("Desktop CLI PATH entry was already absent")
    }
  }

  if (method !== "desktop" && method !== "standalone") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "@ericsanchezok/synergy"],
      pnpm: ["pnpm", "uninstall", "-g", "@ericsanchezok/synergy"],
      bun: ["bun", "remove", "-g", "@ericsanchezok/synergy"],
      yarn: ["yarn", "global", "remove", "@ericsanchezok/synergy"],
    }

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      const result = await $`${cmd}`.quiet().nothrow()
      if (result.exitCode !== 0) {
        spinner.stop(`Package manager uninstall failed`, 1)
        prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
        errors.push(`Package manager: exit code ${result.exitCode}`)
      } else {
        spinner.stop("Package removed")
      }
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("Thank you for using Synergy!")
  return errors
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
