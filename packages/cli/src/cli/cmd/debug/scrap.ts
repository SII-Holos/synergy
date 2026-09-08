import { EOL } from "os"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { cmd } from "../cmd"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) => yargs,
  async handler() {
    const timer = Log.Default.time("scrap")
    const list = await Scope.list()
    process.stdout.write(JSON.stringify(list, null, 2) + EOL)
    timer.stop()
  },
})
