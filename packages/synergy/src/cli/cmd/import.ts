import type { Argv } from "yargs"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { withScopeContext } from "../scope"
import { Identifier } from "../../id/id"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { ScopeContext } from "../../scope/context"
import { EOL } from "os"

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await withScopeContext(process.cwd(), async () => {
      let exportData:
        | {
            info: Session.Info
            messages: Array<{
              info: any
              parts: any[]
            }>
          }
        | undefined

      const file = Bun.file(args.file)
      exportData = await file.json().catch(() => {})
      if (!exportData) {
        process.stdout.write(`File not found: ${args.file}`)
        process.stdout.write(EOL)
        return
      }

      await Storage.write(
        StoragePath.sessionInfo(
          Identifier.asScopeID(ScopeContext.current.scope.id),
          Identifier.asSessionID(exportData.info.id),
        ),
        exportData.info,
      )

      for (const msg of exportData.messages) {
        await Storage.write(
          StoragePath.messageInfo(
            Identifier.asScopeID(ScopeContext.current.scope.id),
            Identifier.asSessionID(exportData.info.id),
            Identifier.asMessageID(msg.info.id),
          ),
          msg.info,
        )

        for (const part of msg.parts) {
          await Storage.write(
            StoragePath.messagePart(
              Identifier.asScopeID(ScopeContext.current.scope.id),
              Identifier.asSessionID(exportData.info.id),
              Identifier.asMessageID(msg.info.id),
              Identifier.asPartID(part.id),
            ),
            part,
          )
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
