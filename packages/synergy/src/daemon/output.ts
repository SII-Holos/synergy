import { UI } from "../cli/ui"
import { Daemon } from "./index"
import { DaemonService } from "./service"

export namespace DaemonOutput {
  export function printServiceSummary(input: {
    title: string
    manager: DaemonService.Manager
    url: string
    logFile: string
    detail?: string
    notes?: string[]
    next?: string[]
  }) {
    UI.println(input.title)
    UI.println()
    UI.println(`  Manager:   ${input.manager}`)
    UI.println(`  URL:       ${input.url}`)
    UI.println(`  Log:       ${input.logFile}`)
    if (input.detail) {
      UI.println(`  Detail:    ${firstLine(input.detail)}`)
    }
    printNotes(input.notes)
    printNext(input.next)
  }

  export function printStatus(status: Daemon.Status) {
    UI.println("Synergy background service")
    UI.println()
    UI.println(`  Manager:    ${status.manager}`)
    UI.println(`  Installed:  ${status.installed ? "yes" : "no"}`)
    UI.println(`  Runtime:    ${formatRuntime(status.runtime)}`)
    UI.println(`  Using:      ${status.specSource === "installed" ? "installed service settings" : "current config"}`)
    UI.println(`  URL:        ${status.url}`)
    UI.println(`  Reachable:  ${status.reachable ? "yes" : "no"}`)
    UI.println(`  Port:       ${status.portListening ? "listening" : "not listening"}`)
    UI.println(`  Log:        ${status.logFile}`)
    if (status.drifted) {
      UI.println(`  Config URL: ${status.desiredUrl}`)
      if (status.desiredLogFile !== status.logFile) {
        UI.println(`  Config Log: ${status.desiredLogFile}`)
      }
    }
    if (status.detail) {
      UI.println(`  Detail:     ${firstLine(status.detail)}`)
    }
    printNotes(statusNotes(status))
    printNext(statusNext(status))
  }

  export function printStartFailure(input: {
    message: string
    manager: DaemonService.Manager
    runtime?: Daemon.Status["runtime"]
    url: string
    logFile: string
    detail?: string
    notes?: string[]
    next?: string[]
  }) {
    UI.error(input.message)
    UI.println(`  Manager:   ${input.manager}`)
    if (input.runtime) {
      UI.println(`  Runtime:   ${formatRuntime(input.runtime)}`)
    }
    UI.println(`  URL:       ${input.url}`)
    UI.println(`  Log:       ${input.logFile}`)
    if (input.detail) {
      UI.println(`  Detail:    ${firstLine(input.detail)}`)
    }
    printNotes(input.notes)
    printNext(input.next ?? ["synergy status", "synergy logs", "synergy restart"])
  }

  export function printStopFailure(input: {
    message: string
    runtime?: Daemon.Status["runtime"]
    url: string
    logFile: string
    detail?: string
    notes?: string[]
    next?: string[]
  }) {
    UI.error(input.message)
    if (input.runtime) {
      UI.println(`  Runtime:   ${formatRuntime(input.runtime)}`)
    }
    UI.println(`  URL:       ${input.url}`)
    UI.println(`  Log:       ${input.logFile}`)
    if (input.detail) {
      UI.println(`  Detail:    ${firstLine(input.detail)}`)
    }
    printNotes(input.notes)
    printNext(input.next ?? ["synergy status", "synergy logs", "synergy stop"])
  }

  export function printLogHeader(input: { filePath: string; status: Daemon.Status }) {
    UI.println("Synergy background service logs")
    UI.println()
    UI.println(`  File:      ${input.filePath}`)
    UI.println(`  Runtime:   ${formatRuntime(input.status.runtime)}`)
    UI.println(`  URL:       ${input.status.url}`)
    if (input.status.drifted && input.status.desiredLogFile !== input.filePath) {
      UI.println(`  Config:    ${input.status.desiredLogFile}`)
    }
    const notes = logNotes(input.status)
    if (notes.length > 0) {
      printNotes(notes)
    }
    UI.println()
  }

  function statusNotes(status: Daemon.Status) {
    if (!status.installed) {
      if (status.runtime === "unknown") {
        return [
          "No managed Synergy service is installed, but the configured address is still active.",
          "Stop the other process using this address or change Synergy's server port before starting.",
        ]
      }
      return ["No managed Synergy service is installed."]
    }
    if (status.runtime === "failed") {
      return ["The service manager reports a running service, but the server did not pass health checks."]
    }
    if (status.runtime === "unknown") {
      return ["Observed network state does not match the service manager state."]
    }
    if (status.runtime === "running" && status.drifted) {
      return ["Current config differs from the installed service. Restart to apply the current config."]
    }
    if (status.runtime === "stopped" && status.drifted) {
      return ["Current config differs from the installed service. Start or restart to apply the current config."]
    }
    return []
  }

  function statusNext(status: Daemon.Status) {
    if (!status.installed && status.runtime === "unknown") {
      return ["synergy status", "synergy logs", "synergy start"]
    }
    if (!status.installed) {
      return ["synergy start", "synergy server"]
    }
    if (status.runtime === "running") {
      const next = ["synergy logs"]
      if (status.drifted) {
        next.push("synergy restart")
      }
      next.push("synergy web", 'synergy send "your message"')
      return next
    }
    if (status.runtime === "failed") {
      return ["synergy logs", "synergy restart", "synergy status"]
    }
    if (status.runtime === "unknown") {
      return ["synergy logs", "synergy restart", "synergy stop"]
    }
    return ["synergy start", "synergy logs"]
  }

  function logNotes(status: Daemon.Status) {
    if (!status.installed && status.runtime === "unknown") {
      return ["This log path comes from the current config because no managed service is installed."]
    }
    if (!status.installed) {
      return ["This log path comes from the current config. Start the service to create fresh output."]
    }
    if (status.drifted) {
      return ["Showing logs for the installed service. Current config path is listed separately above."]
    }
    return []
  }

  function formatRuntime(runtime: Daemon.Status["runtime"]) {
    if (runtime === "running") return "running"
    if (runtime === "stopped") return "stopped"
    if (runtime === "failed") return "failed"
    return "unknown"
  }

  function firstLine(text: string) {
    return text.split("\n")[0] ?? text
  }

  function printNotes(notes?: string[]) {
    if (!notes || notes.length === 0) return
    UI.println()
    UI.println("  Note:")
    for (const note of notes) {
      UI.println(`    ${note}`)
    }
  }

  function printNext(next?: string[]) {
    if (!next || next.length === 0) return
    UI.println()
    UI.println("  Next:")
    for (const line of next) {
      UI.println(`    ${line}`)
    }
  }
}
