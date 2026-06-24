import { cmd } from "./cmd"
import { detectPlatform } from "../../sandbox/detect"
import { getSandboxReadiness } from "../../sandbox/readiness"

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose synergy sandbox and environment",
  handler: async () => {
    console.log("Synergy Doctor")
    console.log("=".repeat(40))

    // Platform
    const platform = detectPlatform()
    console.log(`\nPlatform: ${platform}`)

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
