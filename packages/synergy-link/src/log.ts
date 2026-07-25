import { appendFile, chmod } from "node:fs/promises"
import path from "node:path"
import { SynergyLinkStore } from "./state/store"

let printToConsole = true
let writeQueue: Promise<void> = Promise.resolve()

export namespace SynergyLinkLog {
  export function configure(input?: { printToConsole?: boolean }) {
    if (typeof input?.printToConsole === "boolean") {
      printToConsole = input.printToConsole
    }
  }

  export async function flush() {
    await writeQueue
  }

  export function info(event: string, details?: Record<string, unknown>) {
    write("INFO", event, details)
  }

  export function warn(event: string, details?: Record<string, unknown>) {
    write("WARN", event, details)
  }

  export function error(event: string, details?: Record<string, unknown>) {
    write("ERROR", event, details)
  }

  function write(level: "INFO" | "WARN" | "ERROR", event: string, details?: Record<string, unknown>) {
    const time = new Date().toISOString()
    const sanitized = sanitizeDetails(details)
    const rootPath = SynergyLinkStore.root()
    const logPath = path.join(rootPath, "logs", "runtime.log")
    const line =
      !sanitized || Object.keys(sanitized).length === 0
        ? `[synergy-link] ${time} ${level} ${event}`
        : `[synergy-link] ${time} ${level} ${event} ${safeStringify(sanitized)}`
    if (printToConsole) console.log(line)
    const write = writeQueue.then(async () => {
      await SynergyLinkStore.ensureRoot(rootPath)
      await appendFile(logPath, `${line}\n`, { mode: 0o600 })
      await chmod(logPath, 0o600)
    })
    writeQueue = write.catch((error) => {
      console.error(`[synergy-link] ${time} ERROR log.write.failed ${String(error)}`)
    })
  }
}

const PRIVATE_DETAIL_KEYS = new Set([
  "command",
  "data",
  "error",
  "filePath",
  "keys",
  "label",
  "output",
  "payload",
  "result",
  "socketPath",
])

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return
  return sanitizeRecord(details)
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_DETAIL_KEYS.has(key) && !/(authorization|secret|token)/i.test(key))
      .map(([key, item]) => [key, sanitizeValue(item)]),
  )
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value && typeof value === "object") return sanitizeRecord(value as Record<string, unknown>)
  return value
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
