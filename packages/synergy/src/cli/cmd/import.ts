import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { withScopeContext } from "../scope"
import { SessionImport } from "../../session/session-import"
import { EOL } from "os"

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON or JSON.GZ export file",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await withScopeContext(process.cwd(), async () => {
      const file = Bun.file(args.file)
      if (!(await file.exists())) {
        process.stdout.write(`File not found: ${args.file}`)
        process.stdout.write(EOL)
        return
      }

      try {
        const result = await SessionImport.fromBuffer(await file.arrayBuffer())
        process.stdout.write(
          `Imported session: ${result.rootSessionID} (${result.sessionCount} session${
            result.sessionCount === 1 ? "" : "s"
          }, ${result.messageCount} message${result.messageCount === 1 ? "" : "s"})`,
        )
        process.stdout.write(EOL)
      } catch (error) {
        process.stderr.write(`Import failed: ${error instanceof Error ? error.message : String(error)}`)
        process.stderr.write(EOL)
        process.exitCode = 1
      }
    })
  },
})
