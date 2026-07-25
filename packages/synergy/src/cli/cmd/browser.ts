import { BrowserInstall, type ChromiumDiagnosis, type ChromiumInstallReport } from "../../browser/install"
import { cmd } from "./cmd"

export const BrowserCommand = cmd({
  command: "browser",
  describe: "diagnose and install Chromium for Browser tools",
  builder: (yargs) => yargs.command(BrowserDoctorCommand).command(BrowserInstallCommand).demandCommand(),
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
      }),
  async handler(options) {
    try {
      const report = await BrowserInstall.installChromium({ force: options.force })
      if (options.json) printJson(report)
      else printInstallReport(report)
    } catch (error) {
      if (!options.json) throw error
      printJson({ error: error instanceof Error ? error.message : String(error) })
      process.exitCode = 1
    }
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

function printInstallReport(report: ChromiumInstallReport): void {
  const action =
    report.action === "up-to-date"
      ? "Managed Chromium is already up to date."
      : report.action === "reinstalled"
        ? "Managed Chromium was reinstalled."
        : "Managed Chromium was installed."
  console.log(action)
  console.log(`Version: ${report.browserVersion} (revision ${report.revision})`)
  console.log(`Executable: ${report.executablePath}`)
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}
