import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { withScopeContext } from "../scope"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { Flag } from "../../flag/flag"
import { EOL } from "os"
import path from "path"
import { ScopeContext } from "../../scope/context"
import { SessionRecovery } from "../../session/recovery"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = Bun.which("less")
  if (lessOnPath) {
    if (Bun.file(lessOnPath).size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.SYNERGY_GIT_BASH_PATH) {
    const less = path.join(Flag.SYNERGY_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  const git = Bun.which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Bun.file(less).size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionInspectCommand)
      .command(SessionDeleteCommand)
      .command(SessionRenameCommand)
      .command(SessionRepairCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
      .option("with-health", {
        describe: "include recovery-safe health data",
        type: "boolean",
        default: false,
      })
  },
  handler: async (args) => {
    await withScopeContext(process.cwd(), async () => {
      if (args.withHealth) {
        const scopeID = ScopeContext.current.scope.id
        const health = await SessionRecovery.listHealth(scopeID)
        if (args.format === "json") console.log(JSON.stringify(health, null, 2))
        else console.log(formatHealthTable(health))
        return
      }

      const sessions = []
      for await (const session of Session.listAll()) {
        if (!session.parentID) {
          sessions.push(session)
        }
      }

      sessions.sort((a, b) => b.time.updated - a.time.updated)

      const limitedSessions = args.maxCount ? sessions.slice(0, args.maxCount) : sessions

      if (limitedSessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(limitedSessions)
      } else {
        output = formatSessionTable(limitedSessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Bun.spawn({
          cmd: pagerCmd(),
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

export const SessionInspectCommand = cmd({
  command: "inspect <sessionID>",
  describe: "inspect a session without hydrating its messages",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", { type: "string", demandOption: true })
      .option("scope", { type: "string", describe: "scope id when the session index is missing" })
      .option("json", { type: "boolean", default: false }),
  handler: async (args) => {
    const result = await SessionRecovery.inspect({
      sessionID: args.sessionID as string,
      scopeID: args.scope as string | undefined,
    })
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(formatHealthTable([result]))
  },
})

export const SessionDeleteCommand = cmd({
  command: "delete <sessionID>",
  describe: "delete a session using recovery-safe filesystem/index cleanup",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", { type: "string", demandOption: true })
      .option("scope", { type: "string", describe: "scope id when the session index is missing" })
      .option("yes", { type: "boolean", default: false, describe: "confirm deletion" })
      .option("json", { type: "boolean", default: false }),
  handler: async (args) => {
    if (!args.yes) throw new Error("Refusing to delete without --yes.")
    const result = await SessionRecovery.remove({
      sessionID: args.sessionID as string,
      scopeID: args.scope as string | undefined,
    })
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(formatDeleteReport(result))
  },
})

export const SessionRenameCommand = cmd({
  command: "rename <sessionID> <title>",
  describe: "rename a session",
  builder: (yargs: Argv) => {
    return yargs
      .positional("sessionID", {
        describe: "session id to rename",
        type: "string",
        demandOption: true,
      })
      .positional("title", {
        describe: "new title for the session",
        type: "string",
        demandOption: true,
      })
  },
  handler: async (args) => {
    await withScopeContext(process.cwd(), async () => {
      try {
        await Session.update(args.sessionID as string, (draft) => {
          draft.title = args.title as string
        })
        console.log(`Renamed session ${args.sessionID} to "${args.title}"`)
      } catch (error) {
        console.error(`Failed to rename session: ${error instanceof Error ? error.message : error}`)
        process.exit(1)
      }
    })
  },
})

export const SessionRepairCommand = cmd({
  command: "repair",
  describe: "repair broken session indexes without deleting readable message data",
  builder: (yargs: Argv) =>
    yargs
      .option("dry-run", { type: "boolean", default: true, describe: "show planned repairs without applying them" })
      .option("apply", { type: "boolean", default: false, describe: "apply repairs" })
      .option("json", { type: "boolean", default: false }),
  handler: async (args) => {
    const result = await SessionRecovery.repair({ apply: !!args.apply })
    if (args.json) console.log(JSON.stringify(result, null, 2))
    else console.log(formatRepairReport(result, !!args.apply))
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => {
    const scope = session.scope as import("@/scope").Scope
    return {
      id: session.id,
      title: session.title,
      updated: session.time.updated,
      created: session.time.created,
      scopeID: scope.id,
      directory: scope.directory,
    }
  })
  return JSON.stringify(jsonData, null, 2)
}

function formatHealthTable(items: SessionRecovery.Health[]): string {
  if (items.length === 0) return ""
  const lines = ["Session ID                      Scope       Info  Messages  Parts  JSON bytes  Corrupt"]
  for (const item of items) {
    lines.push(
      [
        item.sessionID.padEnd(30),
        item.scopeID.padEnd(10),
        (item.infoReadable ? "ok" : "bad").padEnd(5),
        String(item.messageCount).padStart(8),
        String(item.partCount).padStart(6),
        String(item.totalBytes).padStart(10),
        String(item.corruptJsonCount).padStart(7),
      ].join("  "),
    )
  }
  return lines.join(EOL)
}

function formatDeleteReport(report: SessionRecovery.DeleteReport): string {
  return [
    `Deleted sessions: ${report.sessionIDs.join(", ")}`,
    `Removed targets: ${report.removed.length}`,
    report.errors.length ? `Errors:\n${report.errors.map((e) => `  ${e.target}: ${e.message}`).join(EOL)}` : undefined,
  ]
    .filter(Boolean)
    .join(EOL)
}

function formatRepairReport(report: SessionRecovery.RepairReport, applied: boolean): string {
  const lines = [
    `Scanned sessions: ${report.scanned}`,
    `${applied ? "Repaired" : "Repair candidates"}: ${report.entries.length}`,
  ]
  for (const entry of report.entries) lines.push(`  ${entry.scopeID}/${entry.sessionID}: ${entry.action}`)
  return lines.join(EOL)
}
