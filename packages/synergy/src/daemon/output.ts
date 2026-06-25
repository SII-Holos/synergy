import { Daemon } from "./index"
import { DaemonService } from "./service"
import { StartupReporter } from "../cli/startup-reporter"

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
    StartupReporter.print({
      title: input.title,
      rows: [
        { label: "Manager", value: input.manager },
        { label: "URL", value: input.url },
        { label: "Log", value: input.logFile },
        ...(input.detail ? [{ label: "Detail", value: firstLine(input.detail) }] : []),
      ],
      notes: input.notes,
      next: input.next,
    })
  }

  export function printStatus(status: Daemon.Status) {
    StartupReporter.print({
      title: "Synergy background service",
      rows: [
        { label: "Manager", value: status.manager },
        { label: "Using", value: status.specSource === "installed" ? "installed service settings" : "current config" },
        { label: "URL", value: status.url },
        { label: "Log", value: status.logFile },
        ...(status.drifted ? [{ label: "Config URL", value: status.desiredUrl }] : []),
        ...(status.drifted && status.desiredLogFile !== status.logFile
          ? [{ label: "Config Log", value: status.desiredLogFile }]
          : []),
        ...(status.detail ? [{ label: "Detail", value: firstLine(status.detail) }] : []),
      ],
      statuses: [
        { label: "Installed", value: status.installed ? "yes" : "no", kind: status.installed ? "success" : "muted" },
        { label: "Runtime", value: formatRuntime(status.runtime), kind: runtimeKind(status.runtime) },
        { label: "Reachable", value: status.reachable ? "yes" : "no", kind: status.reachable ? "success" : "warning" },
        {
          label: "Port",
          value: status.portListening ? "listening" : "not listening",
          kind: status.portListening ? "success" : "muted",
        },
      ],
      notes: statusNotes(status),
      next: statusNext(status),
    })
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
    StartupReporter.print({
      title: input.message,
      rows: [
        { label: "Manager", value: input.manager },
        { label: "URL", value: input.url },
        { label: "Log", value: input.logFile },
        ...(input.detail ? [{ label: "Detail", value: firstLine(input.detail) }] : []),
      ],
      statuses: input.runtime
        ? [{ label: "Runtime", value: formatRuntime(input.runtime), kind: runtimeKind(input.runtime) }]
        : [],
      notes: input.notes,
      next: input.next ?? ["synergy status", "synergy logs"],
    })
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
    StartupReporter.print({
      title: input.message,
      rows: [
        { label: "URL", value: input.url },
        { label: "Log", value: input.logFile },
        ...(input.detail ? [{ label: "Detail", value: firstLine(input.detail) }] : []),
      ],
      statuses: input.runtime
        ? [{ label: "Runtime", value: formatRuntime(input.runtime), kind: runtimeKind(input.runtime) }]
        : [],
      notes: input.notes,
      next: input.next ?? ["synergy status", "synergy logs", "synergy stop"],
    })
  }

  export function printStopSuccess(input?: { portStopped?: boolean; url?: string }) {
    StartupReporter.print({
      title: "Synergy background service stopped",
      statuses: [{ label: "Runtime", value: "stopped", kind: "muted" }],
      notes:
        input?.portStopped === false && input.url
          ? [
              `The configured address is still active, which may indicate another process is listening there: ${input.url}`,
            ]
          : undefined,
      next: ["synergy start", "synergy status"],
    })
  }

  export function printNoService(input?: { activeUrl?: string }) {
    StartupReporter.print({
      title: "No managed Synergy background service is installed",
      rows: input?.activeUrl ? [{ label: "Observed", value: input.activeUrl }] : undefined,
      statuses: [{ label: "Installed", value: "no", kind: "muted" }],
      notes: input?.activeUrl
        ? ["Stop the other process using this address, or change Synergy's server port."]
        : undefined,
      next: input?.activeUrl ? ["synergy status"] : ["synergy start"],
    })
  }

  export function printLogHeader(input: { filePath: string; status: Daemon.Status }) {
    StartupReporter.print({
      title: "Synergy background service logs",
      rows: [
        { label: "File", value: input.filePath },
        { label: "URL", value: input.status.url },
        ...(input.status.drifted && input.status.desiredLogFile !== input.filePath
          ? [{ label: "Config", value: input.status.desiredLogFile }]
          : []),
      ],
      statuses: [
        { label: "Runtime", value: formatRuntime(input.status.runtime), kind: runtimeKind(input.status.runtime) },
      ],
      notes: logNotes(input.status),
    })
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
      return ["Current config differs from the installed service. Stop and start to apply the current config."]
    }
    if (status.runtime === "stopped" && status.drifted) {
      return ["Current config differs from the installed service. Stop then start to apply the current config."]
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
        next.push("synergy stop", "synergy start")
      }
      next.push("synergy web", 'synergy send "your message"')
      return next
    }
    if (status.runtime === "failed") {
      return ["synergy logs", "synergy stop", "synergy start", "synergy status"]
    }
    if (status.runtime === "unknown") {
      return ["synergy logs", "synergy stop", "synergy start"]
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

  function runtimeKind(runtime: Daemon.Status["runtime"]): "success" | "warning" | "error" | "muted" {
    if (runtime === "running") return "success"
    if (runtime === "failed") return "error"
    if (runtime === "unknown") return "warning"
    return "muted"
  }

  function firstLine(text: string) {
    return text.split("\n")[0] ?? text
  }
}
