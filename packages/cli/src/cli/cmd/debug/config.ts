import { EOL } from "os"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { withScopeContext } from "@ericsanchezok/synergy-local-runtime/cli/scope"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"

export const ConfigCommand = cmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) => yargs,
  async handler() {
    await withScopeContext(process.cwd(), async () => {
      const config = await Config.current()
      process.stdout.write(JSON.stringify(config, null, 2) + EOL)
    })
  },
})
