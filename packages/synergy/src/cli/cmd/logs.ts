import { cmd } from "./cmd"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonLogTail } from "../../daemon/log-tail"
import { DaemonLogRotate } from "../../daemon/log-rotate"
import { UI } from "../ui"
import fs from "fs/promises"
import path from "path"
import { Log } from "../../util/log"
import { Observability } from "../../observability"

export const LogsCommand = cmd({
  command: "logs",
  describe: "show synergy background service logs",
  builder: (yargs) =>
    yargs
      .option("tail", {
        alias: "n",
        type: "number",
        default: 200,
        describe: "number of trailing lines to show",
      })
      .option("follow", {
        alias: "f",
        type: "boolean",
        default: false,
        describe: "follow the log output",
      })
      .option("level", {
        type: "string",
        describe: "filter by log level (DEBUG, INFO, WARN, ERROR)",
      })
      .option("service", {
        type: "string",
        describe: "filter by service name",
      })
      .option("grep", {
        type: "string",
        describe: "filter lines matching pattern",
      })
      .option("archive", {
        type: "number",
        describe: "read a specific archive by index (0 = most recent)",
      })
      .option("dev", {
        type: "boolean",
        default: false,
        describe: "read the local development log instead of daemon logs",
      })
      .option("trace-id", {
        type: "string",
        describe: "filter observability events by trace id",
      })
      .option("session", {
        type: "string",
        describe: "filter observability events by session id",
      })
      .option("tool-call", {
        type: "string",
        describe: "filter observability events by tool call id",
      })
      .option("since", {
        type: "string",
        describe: "filter observability events since a duration like 30m, 2h, or 7d",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "print observability events as JSON",
      }),
  handler: async (args) => {
    if (args.tail <= 0 || !Number.isInteger(args.tail)) {
      UI.println(`error: --tail must be a positive integer, got ${args.tail}`)
      process.exit(1)
    }

    const wantsTrace =
      Boolean(args.traceId) || Boolean(args.session) || Boolean(args.toolCall) || Boolean(args.since) || args.json
    if (wantsTrace) {
      const since = args.since ? parseSince(args.since) : undefined
      if (args.since && since === undefined) {
        UI.println(`error: invalid --since duration: ${args.since}`)
        process.exit(1)
      }
      const events = await Observability.query({
        traceId: args.traceId,
        sessionID: args.session,
        callID: args.toolCall,
        since,
        limit: args.tail,
      })
      if (args.json) {
        for (const event of events.reverse()) process.stdout.write(JSON.stringify(event) + "\n")
        return
      }
      if (events.length === 0) {
        UI.println("(no trace events found)")
        return
      }
      for (const event of events.reverse()) {
        const pieces = [
          event.iso,
          event.level ? event.level.toUpperCase() : "INFO",
          event.type,
          event.traceId ? `trace=${event.traceId}` : undefined,
          event.sessionID ? `session=${event.sessionID}` : undefined,
          event.callID ? `call=${event.callID}` : undefined,
          event.tool ? `tool=${event.tool}` : undefined,
        ].filter(Boolean)
        UI.println(pieces.join(" "))
        if (event.data) UI.println("  " + JSON.stringify(event.data))
      }
      return
    }

    if (args.dev) {
      await printDevLog(args)
      return
    }

    const status = await Daemon.status()
    const filePath = status.logFile

    DaemonOutput.printLogHeader({ filePath, status })

    const filter = buildFilter(args.level, args.service, args.grep)

    if (args.archive !== undefined) {
      const archives = await DaemonLogRotate.listArchives(filePath)
      if (archives.length === 0) {
        UI.println("no log archives found")
        return
      }
      if (args.archive < 0 || args.archive >= archives.length) {
        UI.println(`error: archive index must be 0-${archives.length - 1}, got ${args.archive}`)
        process.exit(1)
      }
      const archivePath = path.join(archives[args.archive].dir, archives[args.archive].name)
      const content = await DaemonLogTail.tailFile(archivePath, args.tail)
      if (!content) {
        UI.println("(archive is empty)")
      } else {
        process.stdout.write(applyFilter(content, filter) + "\n")
      }
      return
    }

    const exists = await fs.stat(filePath).catch(() => null)
    if (!exists) {
      UI.println(`log file not found: ${filePath}`)
      return
    }

    if (args.follow) {
      await DaemonLogTail.followFile(filePath, args.tail, (chunk) => {
        if (filter) {
          const filtered = applyFilter(chunk.replace(/\n$/, ""), filter)
          if (filtered) process.stdout.write(filtered + "\n")
        } else {
          process.stdout.write(chunk)
        }
      })
      return
    }

    const content = await DaemonLogTail.tailFile(filePath, args.tail)
    if (!content) {
      UI.println("(no log output yet)")
    } else {
      process.stdout.write(applyFilter(content, filter) + "\n")
    }

    const archives = await DaemonLogRotate.listArchives(filePath)
    if (archives.length > 0) {
      UI.println()
      UI.println(
        `  ${archives.length} rotated log archive(s) in ${UI.Style.TEXT_DIM}${archives[0].dir}${UI.Style.TEXT_NORMAL}`,
      )
      for (const a of archives) {
        UI.println(`    ${UI.Style.TEXT_DIM}${a.name}${UI.Style.TEXT_NORMAL}`)
      }
    }
  },
})

async function printDevLog(args: {
  tail: number
  follow?: boolean
  level?: string
  service?: string
  grep?: string
  archive?: number
}) {
  const filePath = Log.devFile()
  UI.println(`Dev log: ${UI.Style.TEXT_DIM}${filePath}${UI.Style.TEXT_NORMAL}`)
  const filter = buildFilter(args.level, args.service, args.grep)

  if (args.archive !== undefined) {
    const archives = await Log.listDevArchives()
    if (archives.length === 0) {
      UI.println("no dev log archives found")
      return
    }
    if (args.archive < 0 || args.archive >= archives.length) {
      UI.println(`error: archive index must be 0-${archives.length - 1}, got ${args.archive}`)
      process.exit(1)
    }
    const content = await DaemonLogTail.tailFile(archives[args.archive], args.tail)
    if (!content) UI.println("(archive is empty)")
    else process.stdout.write(applyFilter(content, filter) + "\n")
    return
  }

  const exists = await fs.stat(filePath).catch(() => null)
  if (!exists) {
    UI.println(`log file not found: ${filePath}`)
    return
  }

  if (args.follow) {
    await DaemonLogTail.followFile(filePath, args.tail, (chunk) => {
      if (filter) {
        const filtered = applyFilter(chunk.replace(/\n$/, ""), filter)
        if (filtered) process.stdout.write(filtered + "\n")
      } else {
        process.stdout.write(chunk)
      }
    })
    return
  }

  const content = await DaemonLogTail.tailFile(filePath, args.tail)
  if (!content) UI.println("(no log output yet)")
  else process.stdout.write(applyFilter(content, filter) + "\n")

  const archives = await Log.listDevArchives()
  if (archives.length > 0) {
    UI.println()
    UI.println(
      `  ${archives.length} dev log archive(s) in ${UI.Style.TEXT_DIM}${path.dirname(archives[0])}${UI.Style.TEXT_NORMAL}`,
    )
    for (const archive of archives)
      UI.println(`    ${UI.Style.TEXT_DIM}${path.basename(archive)}${UI.Style.TEXT_NORMAL}`)
  }
}

function buildFilter(level?: string, service?: string, grep?: string): ((line: string) => boolean) | null {
  const filters: ((line: string) => boolean)[] = []
  if (level) {
    const upper = level.toUpperCase()
    filters.push((line) => line.startsWith(upper + " ") || line.startsWith(upper + "  "))
  }
  if (service) {
    const pattern = `service=${service} `
    filters.push((line) => line.includes(pattern))
  }
  if (grep) {
    const re = new RegExp(grep, "i")
    filters.push((line) => re.test(line))
  }
  if (filters.length === 0) return null
  return (line) => filters.every((f) => f(line))
}

function applyFilter(content: string, filter: ((line: string) => boolean) | null): string {
  if (!filter) return content
  return content.split("\n").filter(filter).join("\n")
}

function parseSince(input: string) {
  const match = input.trim().match(/^(\d+)(ms|s|m|h|d)?$/)
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2] ?? "ms"
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return Date.now() - value * scale
}
