import { cmd } from "./cmd"
import { UI } from "../ui"
import { withNetworkOptions } from "../network"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonService } from "../../daemon/service"

export const StartCommand = cmd({
  command: "start",
  describe: "start synergy background service",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("non-interactive", {
      type: "boolean",
      default: false,
      describe: "skip Holos login prompts before starting the background service",
    }),
  handler: async (args) => {
    const status = await Daemon.status()
    if (status.runtime === "running") {
      DaemonOutput.printServiceSummary({
        title: status.drifted
          ? "Synergy background service is running with installed settings"
          : "Synergy background service is already running",
        manager: status.manager,
        url: status.url,
        logFile: status.logFile,
        detail: status.detail,
        notes: status.drifted
          ? ["Current config differs from the installed service. Restart to apply the current config."]
          : undefined,
        next: status.drifted
          ? ["synergy restart", "synergy status", "synergy logs"]
          : ["synergy web", 'synergy send "your message"'],
      })
      return
    }

    if (status.runtime === "unknown") {
      UI.error("Another Synergy process is already active on the configured address")
      UI.println(`  URL:       ${status.url}`)
      if (status.detail) UI.println(`  Detail:    ${status.detail}`)
      UI.println()
      UI.println("  Next:")
      UI.println("    Stop the other Synergy instance before starting the background service")
      UI.println("    synergy status")
      UI.println("    synergy stop")
      process.exit(1)
    }

    const interactive = !args.nonInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY)

    // TODO: redesign CLI Holos login flow so it does not duplicate the Web UI Holos onboarding.
    // For now we intentionally skip the CLI entrypoint and let users connect from Web UI or `synergy holos login`.
    // try {
    //   await HolosStartup.resolveIdentity(interactive)
    // } catch {
    //   UI.println(
    //     UI.Style.TEXT_DIM +
    //       "Holos setup skipped — starting background service in standalone mode" +
    //       UI.Style.TEXT_NORMAL,
    //   )
    // }
    if (interactive) {
      UI.println(
        UI.Style.TEXT_DIM +
          "Holos login is skipped in CLI startup for now — use the Web UI or `synergy holos login` if you want to connect Holos." +
          UI.Style.TEXT_NORMAL,
      )
    }

    let service: Awaited<ReturnType<typeof Daemon.start>>["service"]
    try {
      const started = await Daemon.start()
      service = started.service
    } catch (error) {
      const [spec, resolvedService] = await Promise.all([
        Daemon.buildSpec().catch(() => undefined),
        DaemonService.resolve().catch(() => undefined),
      ])
      DaemonOutput.printStartFailure({
        message: `Failed to install or start the background service: ${error instanceof Error ? error.message : String(error)}`,
        manager: resolvedService?.manager ?? "schtasks",
        url: spec?.url ?? "unknown",
        logFile: spec?.logFile ?? "unknown",
        notes: [
          process.platform === "win32"
            ? "If the error mentions access or permissions, try running in an elevated terminal."
            : "Check that the service manager is available and your user has permissions.",
          "If background service startup is unavailable in this environment, try `synergy server` to run the server in the current terminal.",
        ],
        next: ["synergy status", "synergy logs", "synergy restart", "synergy server"],
      })
      process.exit(1)
    }
    const result = await Daemon.waitForRunning()
    if (!result.ok) {
      DaemonOutput.printStartFailure({
        message: "Synergy background service did not become ready in time",
        manager: service.manager,
        runtime: result.state.runtime,
        url: result.state.url,
        logFile: result.state.logFile,
        detail: result.state.detail,
        notes:
          result.state.runtime === "failed"
            ? ["The service started under the manager, but the server did not pass health checks."]
            : result.state.runtime === "unknown"
              ? ["The service manager and observed network state do not agree yet."]
              : undefined,
      })
      process.exit(1)
    }

    DaemonOutput.printServiceSummary({
      title: "Synergy background service started",
      manager: service.manager,
      url: result.state.url,
      logFile: result.state.logFile,
      detail: result.state.detail,
      notes: await modelReadinessNotes(result.state.url),
      next: ["synergy status", "synergy web", 'synergy send "your message"'],
    })
  },
})

async function modelReadinessNotes(url: string): Promise<string[] | undefined> {
  try {
    const base = url.replace(/\/+$/, "")
    const res = await fetch(`${base}/global/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return undefined
    const payload = await res.json()
    if (payload?.modelReady === false) {
      return ['No AI model configured — run "synergy config ui" to set up a provider.']
    }
  } catch {}
  return undefined
}
