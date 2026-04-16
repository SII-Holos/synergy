import { cmd } from "./cmd"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonLogTail } from "../../daemon/log-tail"
import { DaemonLogRotate } from "../../daemon/log-rotate"
import { UI } from "../ui"
import fs from "fs/promises"
import path from "path"

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
      }),
  handler: async (args) => {
    if (args.tail <= 0 || !Number.isInteger(args.tail)) {
      UI.println(`error: --tail must be a positive integer, got ${args.tail}`)
      process.exit(1)
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
