import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"
import { ObservabilityEvents } from "@/observability/events"
import { ObservabilityRedaction } from "@/observability/redaction"
import { ObservabilitySchema } from "@/observability/schema"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(extra?: Record<string, any>): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export function create(tags?: Record<string, any>) {
    return createLogger(tags || {}, true)
  }

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
  }

  let logpath = ""
  export function file() {
    return logpath
  }

  export function devFile() {
    return path.join(Global.Path.log, "dev.log")
  }

  export async function listDevArchives() {
    return (await listArchives(Global.Path.log, /^dev\.\d{8}-\d{6}(?:\.\d+)?\.log$/)).map((item) => item.path)
  }

  let initialized = false
  const buffered: string[] = []
  let write = (msg: string) => {
    if (!initialized) {
      buffered.push(msg)
      return
    }
    process.stderr.write(msg)
  }

  let currentWriter: { writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>; path: string } | undefined

  export async function init(options: Options) {
    if (options.level) level = options.level
    cleanup(Global.Path.log).catch(() => {})
    if (options.print) {
      write = (msg: string) => {
        process.stderr.write(msg)
      }
      initialized = true
      flushBuffered()
      return
    }
    logpath = path.join(
      Global.Path.log,
      options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    if (options.dev) {
      await archiveDevLog(logpath)
    }
    await openWriter(logpath)
    initialized = true
    flushBuffered()
  }

  function flushBuffered() {
    if (buffered.length === 0) return
    const pending = buffered.splice(0)
    for (const msg of pending) write(msg)
  }

  async function openWriter(filePath: string) {
    if (currentWriter) {
      try {
        currentWriter.writer.end()
      } catch {}
    }
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.truncate(filePath).catch(() => {})
      const logfile = Bun.file(filePath)
      const writer = logfile.writer()
      currentWriter = { writer, path: filePath }
      write = (msg: string) => {
        try {
          writer.write(msg)
          writer.flush()
        } catch {}
      }
    } catch {
      write = (msg: string) => {
        process.stderr.write(msg)
      }
    }
  }

  async function archiveDevLog(filePath: string) {
    const stat = await fs.stat(filePath).catch(() => undefined)
    if (!stat || stat.size === 0) return
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
    const archivePath = path.join(path.dirname(filePath), `dev.${timestamp}.log`)
    await fs.rename(filePath, archivePath).catch(async () => {
      const fallback = path.join(path.dirname(filePath), `dev.${timestamp}.${process.pid}.log`)
      await fs.rename(filePath, fallback).catch(() => {})
    })
    await cleanupDevArchives(path.dirname(filePath))
  }

  async function listArchives(dir: string, pattern: RegExp) {
    const entries = await fs.readdir(dir).catch((): string[] => [])
    const archives = await Promise.all(
      entries
        .filter((name) => pattern.test(name))
        .map(async (name) => ({
          name,
          path: path.join(dir, name),
          stat: await fs.stat(path.join(dir, name)).catch(() => undefined),
        })),
    )
    return archives
      .filter((item): item is { name: string; path: string; stat: NonNullable<(typeof item)["stat"]> } => !!item.stat)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  }

  async function cleanupDevArchives(dir: string) {
    const archives = await listArchives(dir, /^dev\.\d{8}-\d{6}(?:\.\d+)?\.log$/)
    let total = 0
    for (let i = 0; i < archives.length; i++) {
      total += archives[i].stat.size
      if (i >= 10 || total > 200 * 1024 * 1024) {
        await fs.rm(archives[i].path, { force: true }).catch(() => {})
      }
    }
  }

  export async function reopenWriter() {
    if (!logpath) return
    await openWriter(logpath)
  }

  export function flush() {
    if (currentWriter) {
      try {
        currentWriter.writer.flush()
      } catch {}
    }
  }

  async function cleanup(dir: string) {
    const glob = new Bun.Glob("????-??-??T??????.log")
    const files = await Array.fromAsync(
      glob.scan({
        cwd: dir,
        absolute: true,
      }),
    )
    if (files.length <= 5) return

    const filesToDelete = files.slice(0, -10)
    await Promise.all(filesToDelete.map((file) => fs.unlink(file).catch(() => {})))
  }

  function safeSerialize(value: any): string {
    try {
      const clean = ObservabilityRedaction.value(value).value
      return JSON.stringify(clean)
    } catch {
      return "[unserializable]"
    }
  }

  function formatValue(key: string, value: any): string {
    if (key === "mirror") return ""
    const prefix = `${key}=`
    if (ObservabilityRedaction.isSensitiveKey(key)) return prefix + "[redacted]"
    if (value instanceof Error) {
      const parts = [value.message]
      let cause = value.cause
      let depth = 0
      while (cause instanceof Error && depth < 10) {
        parts.push(cause.message)
        cause = cause.cause
        depth++
      }
      return prefix + ObservabilityRedaction.text(parts.join(" Caused by: "))
    }
    if (typeof value === "object" && value !== null) return prefix + safeSerialize(value)
    if (typeof value === "bigint") return prefix + value.toString()
    if (typeof value === "symbol") return prefix + value.toString()
    if (typeof value === "function") return prefix + "[Function]"
    if (typeof value === "string") return prefix + ObservabilityRedaction.text(value)
    return prefix + value
  }

  function cleanMessage(msg: any): string {
    if (msg === undefined || msg === null) return ""
    const str = typeof msg === "string" ? msg : String(msg)
    return ObservabilityRedaction.text(str)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/\n/g, "\\n")
  }

  let mirroring = false

  function moduleForService(service: unknown): ObservabilitySchema.Module {
    if (typeof service !== "string") return "observability"
    const root = service.split(".")[0]
    const parsed = ObservabilitySchema.Module.safeParse(root)
    if (parsed.success) return parsed.data
    if (root === "client") return "frontend"
    if (root === "config" || root === "file" || root === "patch" || root === "format" || root === "ripgrep")
      return "storage"
    if (root === "question" || root === "cortex" || root === "skill") return "session"
    return "observability"
  }

  function mirror(level: Level, tags: Record<string, any>, message: any, extra?: Record<string, any>) {
    if (mirroring || tags["mirror"] === false || extra?.["mirror"] === false) return
    mirroring = true
    try {
      const data: Record<string, unknown> = { ...tags, ...(extra ?? {}) }
      delete data["mirror"]
      data.message = message instanceof Error ? ObservabilityRedaction.errorInfo(message) : message
      void ObservabilityEvents.emit("log.record", {
        level: level.toLowerCase() as "debug" | "info" | "warn" | "error",
        module: moduleForService(data.service),
        data,
      }).catch(() => {})
    } catch {
    } finally {
      mirroring = false
    }
  }

  let last = Date.now()
  function createLogger(tags: Record<string, any>, cache: boolean): Logger {
    const frozen = { ...tags }

    const service = frozen["service"]
    if (cache && service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      const prefix = Object.entries({
        ...frozen,
        ...extra,
      })
        .filter(([key, value]) => key !== "mirror" && value !== undefined && value !== null)
        .map(([key, value]) => formatValue(key, value))
        .filter(Boolean)
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return (
        [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, cleanMessage(message)].filter(Boolean).join(" ") +
        "\n"
      )
    }

    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          write("DEBUG " + build(message, extra))
          mirror("DEBUG", frozen, message, extra)
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
          mirror("INFO", frozen, message, extra)
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
          mirror("ERROR", frozen, message, extra)
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
          mirror("WARN", frozen, message, extra)
        }
      },
      tag(key: string, value: string) {
        return createLogger({ ...frozen, [key]: value }, false)
      },
      clone() {
        return createLogger({ ...frozen }, false)
      },
      time(message: string, extra?: Record<string, any>) {
        const start = Date.now()
        let stopped = false
        function stop(stopExtra?: Record<string, any>) {
          if (stopped) return
          stopped = true
          result.info(message, {
            duration: Date.now() - start,
            ...extra,
            ...stopExtra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (cache && service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
