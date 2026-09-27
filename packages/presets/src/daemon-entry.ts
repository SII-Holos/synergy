import { run as runServerRuntime } from "./server/runtime"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { DaemonSpec } from "@ericsanchezok/synergy-cli/daemon/spec"

const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const

export async function main() {
  await runServerRuntime({
    logging: {
      print: true,
      dev: Installation.isLocal(),
      level: LOG_LEVELS.find((level) => level === process.env.LOG_LEVEL) ?? "INFO",
    },
    interactive: false,
    printBanner: false,
    printChannelStatus: false,
    network: () => DaemonSpec.resolveNetwork({ argv: process.argv }),
  })
}

if (import.meta.main) await main()
