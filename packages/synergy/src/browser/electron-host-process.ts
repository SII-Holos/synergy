import path from "node:path"
import { BunProc } from "../util/bun.js"
import { BrowserOwner } from "./owner.js"

export namespace BrowserElectronHostProcess {
  export interface EnsureInput {
    owner: BrowserOwner.Info
    tabId: string
    serverUrl: string
    routeDirectory: string
    url?: string
    width?: number
    height?: number
  }

  export type EnsureResult = { status: "disabled" | "running" | "started"; key: string }

  const processes = new Map<string, Bun.Subprocess>()

  export function key(owner: BrowserOwner.Info, tabId: string): string {
    return `${BrowserOwner.key(owner)}:tab:${tabId}`
  }

  export function enabled(): boolean {
    return process.env.SYNERGY_BROWSER_HOST_AUTOSTART === "1" || Boolean(process.env.SYNERGY_BROWSER_HOST_COMMAND)
  }

  export function ensure(input: EnsureInput): EnsureResult {
    const processKey = key(input.owner, input.tabId)
    const existing = processes.get(processKey)
    if (existing && existing.exitCode === null) return { status: "running", key: processKey }
    if (!enabled()) return { status: "disabled", key: processKey }

    const proc = Bun.spawn(command(), {
      cwd: repoRoot(),
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        SYNERGY_DESKTOP_MODE: "browser-host",
        SYNERGY_BROWSER_HOST_SERVER_URL: input.serverUrl,
        SYNERGY_BROWSER_HOST_SESSION_ID: input.owner.sessionID ?? "",
        SYNERGY_BROWSER_HOST_TAB_ID: input.tabId,
        SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY: input.routeDirectory,
        SYNERGY_BROWSER_HOST_DIRECTORY: input.owner.directory,
        SYNERGY_BROWSER_HOST_SCOPE_ID: input.owner.scopeID ?? "",
        SYNERGY_BROWSER_HOST_URL: input.url ?? "",
        SYNERGY_BROWSER_HOST_WIDTH: String(input.width ?? 1280),
        SYNERGY_BROWSER_HOST_HEIGHT: String(input.height ?? 720),
      },
    })
    processes.set(processKey, proc)
    proc.exited.finally(() => {
      if (processes.get(processKey) === proc) processes.delete(processKey)
    })
    return { status: "started", key: processKey }
  }

  export function stop(owner: BrowserOwner.Info, tabId: string): void {
    const processKey = key(owner, tabId)
    const proc = processes.get(processKey)
    if (!proc) return
    proc.kill()
    processes.delete(processKey)
  }

  export function resetForTest(): void {
    for (const proc of processes.values()) proc.kill()
    processes.clear()
  }

  function command(): string[] {
    const configured = process.env.SYNERGY_BROWSER_HOST_COMMAND
    if (configured) {
      if (configured.trim().startsWith("[")) return JSON.parse(configured)
      return configured.split(/\s+/).filter(Boolean)
    }
    return [BunProc.which(), "run", "--cwd", desktopDir(), "dev"]
  }

  function repoRoot(): string {
    return path.resolve(import.meta.dir, "../../..")
  }

  function desktopDir(): string {
    return path.resolve(import.meta.dir, "../../../desktop")
  }
}
