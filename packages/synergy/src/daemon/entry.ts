import { run as runServerRuntime } from "../server/runtime"
import { Installation } from "../global/installation"
import { Log } from "../util/log"
import { DaemonSpec } from "./spec"
import { ensureMigrations } from "../migration"

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
