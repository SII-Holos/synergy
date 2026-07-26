import { BrowserInstall, type ChromiumDiagnosis, type ChromiumInstallReport } from "../../browser/install"
import { cmd } from "./cmd"

export const BrowserCommand = cmd({
  command: "browser",
  describe: "diagnose and install Chromium for Browser tools",
  builder: (yargs) =>
    yargs
      .command(BrowserDoctorCommand)
      .command(BrowserInstallCommand)
      .command(BrowserInstallDepsCommand)
      .demandCommand(),
  async handler() {},
})

export const BrowserDoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose Chromium discovery and headless Browser readiness",
  builder: (yargs) =>
    yargs.option("json", {
      describe: "print the diagnosis as JSON",
      type: "boolean",
      default: false,
    }),
  async handler(options) {
    const report = await BrowserInstall.diagnoseChromium()
    if (options.json) printJson(report)
    else printDiagnosis(report)
    if (!report.ready) process.exitCode = 1
  },
})

export const BrowserInstallCommand = cmd({
  command: "install",
  describe: "install verified managed Chromium for Browser tools",
  builder: (yargs) =>
    yargs
      .option("force", {
        describe: "reinstall Chromium even when the managed version is current",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "print the installation result as JSON",
        type: "boolean",
        default: false,
      })
      .option("deps", {
        describe: "install required Linux system packages (use --no-deps to skip)",
        type: "boolean",
        default: true,
      }),
  async handler(options) {
    try {
      const report = await BrowserInstall.installChromium({ force: options.force })
      const systemDependencies = process.platform !== "linux" ? "not-required" : options.deps ? "installed" : "skipped"
      if (process.platform === "linux" && options.deps) {
        await BrowserInstall.installChromiumDependencies({ captureOutput: options.json })
      }
      if (options.json) printJson({ ...report, systemDependencies })
      else printInstallReport(report, systemDependencies)
    } catch (error) {
      if (!options.json) throw error
      printJson({ error: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
    }
  },
})

export const BrowserInstallDepsCommand = cmd({
  command: "install-deps",
  describe: "install Linux system packages required by Chromium",
  builder: (yargs) => yargs,
  async handler() {
    if (process.platform !== "linux") {
      console.log("Browser system dependency installation is not required on this platform.")
      return
    }
    const { PlaywrightRuntime } = await import("../../browser/playwright-runtime")
    await PlaywrightRuntime.installChromiumDependencies()
  },
})

function printDiagnosis(report: ChromiumDiagnosis): void {
  console.log("Synergy Browser Doctor")
  console.log("=".repeat(40))
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗"
    console.log(`${icon} ${check.label}: ${check.detail}`)
    if (check.recovery) console.log(`  Recovery: ${check.recovery.command}`)
  }
  console.log(`\nOverall: ${report.ready ? "Ready" : "Not ready"}`)
}

function printInstallReport(
  report: ChromiumInstallReport,
  systemDependencies: "installed" | "not-required" | "skipped",
): void {
  const action =
    report.action === "up-to-date"
      ? "Managed Chromium is already up to date."
      : report.action === "reinstalled"
        ? "Managed Chromium was reinstalled."
        : "Managed Chromium was installed."
  console.log(action)
  console.log(`Version: ${report.browserVersion} (revision ${report.revision})`)
  console.log(`Executable: ${report.executablePath}`)
  if (systemDependencies === "installed") console.log("Linux system dependencies were installed.")
  if (systemDependencies === "skipped") console.log("Linux system dependencies were skipped.")
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}
