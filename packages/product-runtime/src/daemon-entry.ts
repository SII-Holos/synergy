import { run as runServerRuntime } from "./server/runtime"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { DaemonSpec } from "@ericsanchezok/synergy-cli/daemon/spec"

async function main() {
  await Log.init({
    print: true,
    dev: Installation.isLocal(),
    level: Installation.isLocal() ? "DEBUG" : "INFO",
  })

  await runServerRuntime({
    interactive: false,
    printBanner: false,
    printChannelStatus: false,
    network: () => DaemonSpec.resolveNetwork({ argv: process.argv }),
  })
}

await main()
