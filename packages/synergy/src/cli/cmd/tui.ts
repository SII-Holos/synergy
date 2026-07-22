import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"

declare const SYNERGY_LIBC: string

export const TuiCommand = cmd({
  command: "tui",
  describe: "open terminal interface (connects to running server)",
  builder: (yargs) =>
    yargs
      .option("attach", {
        type: "string",
        describe: "URL of a running synergy server",
        default: Server.DEFAULT_URL,
      })
      .option("directory", {
        type: "string",
        describe: "directory used to resolve the active Scope",
      })
      .option("scope", {
        type: "string",
        describe: "explicit Scope ID",
      })
      .option("session", {
        alias: "s",
        type: "string",
        describe: "session to open initially",
      })
      .option("theme", {
        type: "string",
        choices: ["system", "light", "dark"] as const,
        default: "system" as const,
        describe: "terminal color theme",
      })
      .conflicts("directory", "scope"),
  handler: async (args) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      UI.error("The terminal interface requires an interactive terminal.")
      process.exitCode = 1
      return
    }

    if (typeof SYNERGY_LIBC !== "undefined" && SYNERGY_LIBC === "musl") {
      process.env.OPENTUI_LIBC = "musl"
    }

    const { runTui } = await import("@ericsanchezok/synergy-tui")
    await runTui({
      baseUrl: args.attach,
      directory: args.scope ? undefined : (args.directory ?? process.cwd()),
      scopeID: args.scope,
      sessionID: args.session,
      theme: args.theme,
    })
  },
})
