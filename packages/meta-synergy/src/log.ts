import { appendFile } from "node:fs/promises"
import { MetaSynergyStore } from "./state/store"

let printToConsole = true

export namespace MetaSynergyLog {
  export function configure(input?: { printToConsole?: boolean }) {
    if (typeof input?.printToConsole === "boolean") {
      printToConsole = input.printToConsole
    }
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
    const line =
      !details || Object.keys(details).length === 0
        ? `[meta-synergy] ${time} ${level} ${event}`
        : `[meta-synergy] ${time} ${level} ${event} ${safeStringify(details)}`
    if (printToConsole) {
      console.log(line)
    }
    void MetaSynergyStore.ensureRoot()
      .then(() => appendFile(MetaSynergyStore.logsPath(), `${line}\n`))
      .catch(() => undefined)
  }
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
