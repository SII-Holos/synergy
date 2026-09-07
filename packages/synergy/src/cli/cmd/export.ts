import type { Argv } from "yargs"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { withScopeContext } from "../scope"
import { UI } from "../../util/ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { SessionExport } from "../../session/session-export"
import { RolloutArchive } from "../../session/rollout/archive"
import { open, rename, unlink } from "node:fs/promises"

export const ExportCommand = cmd({
  command: "export [sessionID]",
  describe: "export a session transcript or self-contained rollout ZIP",
  builder: (yargs: Argv) => {
    return yargs
      .option("format", { choices: ["json", "rollout"] as const, default: "json", describe: "export format" })
      .option("run", { type: "string", describe: "root run ID to include in the rollout" })
      .option("output", { type: "string", describe: "destination file (required for rollout ZIP)" })
      .check((args) => {
        if (args.format === "rollout" && !args.output) throw new Error("Rollout export requires --output")
        if (args.run && args.format !== "rollout") throw new Error("--run requires --format rollout")
        return true
      })
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
  },
  handler: async (args) => {
    await withScopeContext(process.cwd(), async () => {
      let sessionID = args.sessionID
      process.stderr.write(`Exporting session: ${sessionID ?? "latest"}`)

      if (!sessionID) {
        UI.empty()
        prompts.intro("Export session", {
          output: process.stderr,
        })

        const sessions = []
        for await (const session of Session.listAll()) {
          sessions.push(session)
        }

        if (sessions.length === 0) {
          prompts.log.error("No sessions found", {
            output: process.stderr,
          })
          prompts.outro("Done", {
            output: process.stderr,
          })
          return
        }

        sessions.sort((a, b) => b.time.updated - a.time.updated)

        const selectedSession = await prompts.autocomplete({
          message: "Select session to export",
          maxItems: 10,
          options: sessions.map((session) => ({
            label: session.title,
            value: session.id,
            hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
          })),
          output: process.stderr,
        })

        if (prompts.isCancel(selectedSession)) {
          throw new UI.CancelledError()
        }

        sessionID = selectedSession as string

        prompts.outro("Exporting session...", {
          output: process.stderr,
        })
      }

      if (!sessionID) throw new Error("No session selected")
      if (args.format === "rollout") {
        const output = args.output!
        const temporary = `${output}.${crypto.randomUUID()}.tmp`
        const file = await open(temporary, "wx", 0o600)
        try {
          await RolloutArchive.write(
            { sessionID, runID: args.run },
            new WritableStream<Uint8Array>({
              async write(chunk) {
                let offset = 0
                while (offset < chunk.byteLength) {
                  const { bytesWritten } = await file.write(chunk.subarray(offset))
                  if (!bytesWritten) throw new Error("Could not write rollout archive")
                  offset += bytesWritten
                }
              },
            }),
          )
          await file.sync()
          await file.close()
          await rename(temporary, output)
        } catch (error) {
          await file.close().catch(() => {})
          await unlink(temporary).catch(() => {})
          throw error
        }
        return
      }
      const json = JSON.stringify(await SessionExport.generate({ sessionID, mode: "full" }), null, 2) + EOL
      if (args.output) await Bun.write(args.output, json)
      else process.stdout.write(json)
    })
  },
})
