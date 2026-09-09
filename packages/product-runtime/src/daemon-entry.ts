import { run as runServerRuntime } from "./server/runtime"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { DaemonSpec } from "@ericsanchezok/synergy-cli/daemon/spec"
import { ensureMigrations } from "@ericsanchezok/synergy-harness/migration"

async function main() {
  await Log.init({
    print: true,
    dev: Installation.isLocal(),
    level: Installation.isLocal() ? "DEBUG" : "INFO",
  })

  await ensureMigrations()
  const network = await DaemonSpec.resolveNetwork({ argv: process.argv })

  await runServerRuntime({
    interactive: false,
    printBanner: false,
    printChannelStatus: false,
    network,
  })
}

await main()
