import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import z from "zod"

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

  const SENSITIVE_KEYS = new Set([
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "set-cookie",
    "apikey",
    "api_key",
    "accesstoken",
    "refreshtoken",
    "agentsecret",
  ])

  const MAX_STRING_LENGTH = 4096
  const MAX_DEPTH = 6
  const MAX_ARRAY_LENGTH = 32
  const MAX_OBJECT_KEYS = 32

  function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""))
  }

  function sanitizeValue(value: any, depth: number, seen: Set<object>): any {
    if (value === null || value === undefined) return value
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "symbol") return value.toString()
    if (typeof value === "function") return "[Function]"

    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) {
        return value.slice(0, MAX_STRING_LENGTH) + `...(truncated ${value.length - MAX_STRING_LENGTH} chars)`
      }
      return value
    }

    if (typeof value === "number" || typeof value === "boolean") return value

    if (value instanceof Error) {
      const result: Record<string, any> = {
        name: value.name,
        message: value.message,
      }
      // Only include stack traces at DEBUG level to avoid leaking
      // internal file paths in production logs.
      if (value.stack && level === "DEBUG") result.stack = value.stack
      if ((value as any).code) result.code = (value as any).code
      if (value.cause instanceof Error && depth < MAX_DEPTH) {
        result.cause = sanitizeValue(value.cause, depth + 1, seen)
      }
      return result
    }

    if (depth >= MAX_DEPTH) return "[depth limit]"

    if (seen.has(value)) return "[circular]"
    seen.add(value)

    if (Array.isArray(value)) {
      const truncated = value.length > MAX_ARRAY_LENGTH
      const items = value.slice(0, MAX_ARRAY_LENGTH).map((v) => sanitizeValue(v, depth + 1, seen))
      if (truncated) items.push(`...(${value.length - MAX_ARRAY_LENGTH} more)`)
      return items
    }

    if (typeof value === "object") {
      const result: Record<string, any> = {}
      const entries = Object.entries(value)
      const limit = Math.min(entries.length, MAX_OBJECT_KEYS)
      for (let i = 0; i < limit; i++) {
        const [k, v] = entries[i]
        if (isSensitiveKey(k)) {
          result[k] = "[redacted]"
        } else {
          result[k] = sanitizeValue(v, depth + 1, seen)
        }
      }
      if (entries.length > MAX_OBJECT_KEYS) {
        result["..."] = `${entries.length - MAX_OBJECT_KEYS} more keys`
      }
      return result
    }

    return String(value)
  }

  function safeSerialize(value: any): string {
    try {
      const clean = sanitizeValue(value, 0, new Set())
      return JSON.stringify(clean)
    } catch {
      return "[unserializable]"
    }
  }

  function formatValue(key: string, value: any): string {
    const prefix = `${key}=`
    if (isSensitiveKey(key)) return prefix + "[redacted]"
    if (value instanceof Error) {
      const parts = [value.message]
      let cause = value.cause
      let depth = 0
      while (cause instanceof Error && depth < 10) {
        parts.push(cause.message)
        cause = cause.cause
        depth++
      }
      return prefix + parts.join(" Caused by: ")
    }
    if (typeof value === "object" && value !== null) return prefix + safeSerialize(value)
    if (typeof value === "bigint") return prefix + value.toString()
    if (typeof value === "symbol") return prefix + value.toString()
    if (typeof value === "function") return prefix + "[Function]"
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      return prefix + value.slice(0, MAX_STRING_LENGTH) + "..."
    }
    return prefix + value
  }

  function cleanMessage(msg: any): string {
    if (msg === undefined || msg === null) return ""
    const str = typeof msg === "string" ? msg : String(msg)
    return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/\n/g, "\\n")
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
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => formatValue(key, value))
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
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
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
