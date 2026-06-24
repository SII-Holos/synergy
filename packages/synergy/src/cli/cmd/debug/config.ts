import { EOL } from "os"
import { Config } from "../../../config/config"
import { withScopeContext } from "../../scope"
import { cmd } from "../cmd"

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
