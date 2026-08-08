import { cmd } from "./cmd"
import { detectPlatform } from "../../sandbox/detect"
import { getSandboxReadiness } from "../../sandbox/readiness"
import fs from "fs/promises"
import { Installation } from "../../global/installation"
import { DesktopInstallation } from "../../global/desktop-installation"

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose synergy sandbox and environment",
  handler: async () => {
    console.log("Synergy Doctor")
    console.log("=".repeat(40))

    // Platform
    const platform = detectPlatform()
    console.log(`\nPlatform: ${platform}`)

    await printInstallationChecks()
    // Readiness checks
    try {
      const readiness = await getSandboxReadiness()
      console.log(`\nSandbox checks:`)
      for (const check of readiness.checks) {
        const icon = check.status === "pass" ? "✅" : check.status === "warn" ? "⚠️" : "❌"
        console.log(`  ${icon} ${check.label}: ${check.detail}`)
        if (check.recovery) {
          console.log(`     → Recovery: ${check.recovery.action}`)
        }
      }

      console.log(`\nOverall: ${readiness.ready ? "✅ Ready" : "❌ Issues found"}`)
      if (!readiness.ready) {
        console.log("\nFix:")
        for (const check of readiness.checks) {
          if (check.status === "fail") {
            console.log(`  • ${check.label}: ${check.detail}`)
          }
        }
      }
    } catch (error) {
      console.log(`\n  Failed to run sandbox readiness checks: ${(error as Error).message ?? String(error)}`)
    }

    // Environment
    console.log(`\nEnvironment:`)
    console.log(`  HOME: ${process.env.HOME ?? "not set"}`)
    console.log(`  SHELL: ${process.env.SHELL ?? "not set"}`)
  },
})

async function printInstallationChecks() {
  const inspection = await Installation.inspect()
  const method = inspection.current
  const realExecPath = await fs.realpath(process.execPath).catch(() => process.execPath)
  const context = { platform: process.platform, execPath: process.execPath, realExecPath, env: process.env }

  console.log(`\nInstallation:`)
  console.log(`  Current method: ${method}`)
  console.log(`  Executable: ${process.execPath}`)
  console.log(`  Real executable: ${realExecPath}`)

  if (inspection.installations.length === 0) {
    console.log(`  ⚠️ No supported Synergy installation was detected.`)
    process.exitCode = 1
  } else {
    console.log(`  Installed channels:`)
    for (const installation of inspection.installations) {
      const icon = installation.status === "ok" ? (installation.current ? "✅" : "•") : "⚠️"
      const version = installation.version ?? "version probe failed"
      const executable = installation.executable ? ` — ${installation.executable}` : ""
      const flags = [installation.current ? "current" : "", installation.pathFirst ? "PATH first" : ""]
        .filter(Boolean)
        .join(", ")
      console.log(`    ${icon} ${installation.method}: ${version}${executable}${flags ? ` (${flags})` : ""}`)
    }
  }

  if (inspection.conflict) {
    process.exitCode = 1
    console.log(`  ⚠️ Multiple Synergy installation channels were found.`)
    console.log(`     Keep one channel, or run synergy uninstall --installation-only --method <method>.`)
  }
  if (inspection.installations.some((installation) => installation.status === "failed")) {
    process.exitCode = 1
    console.log(`  ⚠️ One or more installed versions could not be verified.`)
  }

  if (method === "desktop") {
    console.log(`  Updates: Desktop updates are managed from the Synergy app.`)
    const link = await DesktopInstallation.inspectCliLink(context)
    const icon = link.status === "healthy" ? "✅" : link.status === "not-applicable" ? "ℹ️" : "⚠️"
    console.log(`  ${icon} Desktop CLI link: ${link.message}`)
    if (link.path) console.log(`     Path: ${link.path}`)
    if (link.target) console.log(`     Target: ${link.target}`)

    const versionStatus = await DesktopInstallation.packageVersionStatus(context, Installation.VERSION)
    const versionIcon =
      versionStatus.status === "matching" ? "✅" : versionStatus.status === "not-applicable" ? "ℹ️" : "⚠️"
    console.log(`  ${versionIcon} Desktop package version: ${versionStatus.message}`)
    if (versionStatus.metadataPath) console.log(`     Metadata: ${versionStatus.metadataPath}`)
  }

  const candidates = inspection.path
  if (candidates.length === 0) {
    console.log(`  ⚠️ PATH: no synergy command found on PATH`)
    return
  }

  console.log(`  PATH candidates:`)
  candidates.forEach((candidate, index) => {
    const first = index === 0
    const icon = candidate.isCurrent ? "✅" : first ? "⚠️" : "•"
    console.log(`    ${icon} ${candidate.path}${candidate.isCurrent ? " (current)" : ""}`)
  })

  if (!candidates[0]?.isCurrent) {
    console.log(`  ⚠️ PATH conflict: the first synergy command is not the current CLI.`)
  }
}
