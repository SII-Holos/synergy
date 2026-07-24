#!/usr/bin/env bun

import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { randomBytes } from "node:crypto"

const DEFAULT_SERVER_PORT = 4096
const DEFAULT_APP_PORT = 3000
const DEFAULT_HOSTNAME = "127.0.0.1"
const DEV_PROCESS_OWNER_ENV = "SYNERGY_DEV_PROCESS_OWNER"
const devProcessOwners = new WeakMap<object, string>()

export interface DevProcessSpec {
  label:
    | "server"
    | "app"
    | "desktop"
    | "browser-host"
    | "tui"
    | "send"
    | "build"
    | "install"
    | "generate"
    | "sandbox"
    | "build:plugin"
  command: string[]
  cwd: string
  env?: Record<string, string | undefined>
  waitUrl?: string
  waitTimeoutMs?: number | null
  interactive?: boolean
}

export interface DevPlan {
  kind: "help" | "error" | "run"
  mode?: "parallel" | "serial" | "prepare"
  command?: string
  help: string
  message?: string
  exitCode: number
  processes: DevProcessSpec[]
  openUrl?: string
  requiredPorts: { label: string; port: number; host: string }[]
  requiredServers: string[]
}

interface PlanOptions {
  repoRoot?: string
  cwd?: string
  bunPath?: string
}

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

function defaultRepoRoot() {
  return path.resolve(import.meta.dir, "..")
}

function normalizeUrl(value: string) {
  return value.replace(/\/+$/, "")
}

function displayHost(hostname: string) {
  if (hostname === "0.0.0.0") return "127.0.0.1"
  if (hostname === "::") return "::1"
  return hostname
}

function serverUrl(hostname: string, port: number) {
  return `http://${displayHost(hostname)}:${port}`
}

function appUrl(hostname: string, port: number) {
  return `http://${displayHost(hostname)}:${port}`
}

function directories(repoRoot: string) {
  return {
    app: path.join(repoRoot, "packages", "app"),
    desktop: path.join(repoRoot, "packages", "desktop"),
    plugin: path.join(repoRoot, "packages", "plugin"),
    synergy: path.join(repoRoot, "packages", "synergy"),
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith("--no-")) {
      flags[arg.slice("--no-".length)] = false
      continue
    }
    if (arg.startsWith("--")) {
      const [rawKey, inlineValue] = arg.slice(2).split("=", 2)
      if (inlineValue !== undefined) {
        flags[rawKey] = inlineValue
        continue
      }
      const next = args[index + 1]
      if (next && !next.startsWith("-")) {
        flags[rawKey] = next
        index++
      } else {
        flags[rawKey] = true
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

function numberFlag(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const value = flags[name]
  if (value === undefined || typeof value === "boolean") return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function stringFlag(flags: Record<string, string | boolean>, name: string, fallback: string): string {
  const value = flags[name]
  return typeof value === "string" && value.trim() ? value : fallback
}

function boolFlag(flags: Record<string, string | boolean>, name: string, fallback = false): boolean {
  const value = flags[name]
  return typeof value === "boolean" ? value : fallback
}

function errorPlan(message: string, help: string): DevPlan {
  return { kind: "error", message, help, exitCode: 1, processes: [], requiredPorts: [], requiredServers: [] }
}

function helpText() {
  return `Synergy source development

Usage:
  bun dev <command> [options]

Commands:
  prepare                 Install deps, generate SDK/OpenAPI, build app, prepare sandbox helper
  server                  Start the Synergy server on a fixed development port
  app                     Start the Vite web app against an existing server
  web                     Start server + Vite web app
  desktop                 Start the Electron desktop app for development
  tui                     Start the source server + interactive terminal UI
  send <message...>       Send a one-off prompt through the source CLI
  build app|desktop       Build a specific development target
  help                    Show this help

Common workflows:
  bun dev prepare
  bun dev web
  bun dev desktop
  bun dev tui
  bun dev app --attach http://localhost:4096 --open

Options:
  --port <port>           Port for bun dev server/app
  --server-port <port>    Server port for web/desktop (default: 4096)
  --app-port <port>       Vite app port for web/desktop (default: 3000)
  --hostname <host>       Server and Vite bind hostname (default: 127.0.0.1)
  --attach <url>          Reuse an existing server instead of starting one
  --directory <path>      Directory used to resolve the TUI Scope
  --scope <id>            Explicit Scope ID for the TUI
  --session <id>          Session opened initially by the TUI
  --theme <mode>          TUI theme: system, light, or dark (default: system)
  --open                  Open the browser for bun dev app
  --no-open               Do not open the browser for bun dev web
  --managed               Start desktop in managed-server mode after rebuilding the app
  --print-logs            Print server logs to stderr
`
}

function serverProcess(input: {
  repoRoot: string
  launchCwd: string
  bunPath: string
  port: number
  hostname: string
  printLogs?: boolean
  browserHostSecret?: string
}): DevProcessSpec {
  const dirs = directories(input.repoRoot)
  const command = [
    input.bunPath,
    "run",
    "--conditions=browser",
    "./src/index.ts",
    "server",
    "--port",
    String(input.port),
    "--hostname",
    input.hostname,
  ]
  if (input.printLogs) command.push("--print-logs")
  const url = serverUrl(input.hostname, input.port)
  return {
    label: "server",
    command,
    cwd: dirs.synergy,
    env: {
      SYNERGY_CWD: process.env.SYNERGY_CWD ?? input.launchCwd,
      SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: input.browserHostSecret,
    },
    waitUrl: `${url}/global/health`,
    waitTimeoutMs: null,
  }
}

function appProcess(input: {
  repoRoot: string
  bunPath: string
  appPort: number
  attachUrl: string
  hostname: string
}): DevProcessSpec {
  const dirs = directories(input.repoRoot)
  const server = normalizeUrl(input.attachUrl)
  return {
    label: "app",
    command: [input.bunPath, "run", "dev", "--host", input.hostname, "--port", String(input.appPort), "--strictPort"],
    cwd: dirs.app,
    env: {
      VITE_SYNERGY_SERVER_URL: server,
      VITE_SYNERGY_CALLBACK_URL: `${server}/holos/callback`,
    },
    waitUrl: appUrl(input.hostname, input.appPort),
  }
}

function tuiProcess(input: {
  repoRoot: string
  launchCwd: string
  bunPath: string
  attachUrl: string
  directory?: string
  scopeID?: string
  sessionID?: string
  theme: string
}): DevProcessSpec {
  const command = [input.bunPath, "run", "--conditions=browser", "./src/index.ts", "tui", "--attach", input.attachUrl]
  if (input.scopeID) command.push("--scope", input.scopeID)
  else command.push("--directory", input.directory ?? input.launchCwd)
  if (input.sessionID) command.push("--session", input.sessionID)
  command.push("--theme", input.theme)
  return {
    label: "tui",
    command,
    cwd: directories(input.repoRoot).synergy,
    interactive: true,
  }
}

function desktopProcess(input: {
  repoRoot: string
  bunPath: string
  mode: "external" | "managed"
  appPort?: number
  appHostname?: string
  browserServerUrl?: string
  browserHostSecret?: string
}): DevProcessSpec {
  const dirs = directories(input.repoRoot)
  const env: Record<string, string | undefined> = {
    BUN_BIN: input.bunPath,
    SYNERGY_DESKTOP_CHANNEL: "dev",
    SYNERGY_DESKTOP_SERVER_MODE: input.mode,
    SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: input.browserHostSecret,
    SYNERGY_BROWSER_BROKER_SERVER_URL: input.browserServerUrl,
  }
  if (input.mode === "external")
    env.SYNERGY_DESKTOP_APP_URL = appUrl(input.appHostname ?? DEFAULT_HOSTNAME, input.appPort ?? DEFAULT_APP_PORT)
  return {
    label: "desktop",
    command: [input.bunPath, "run", "dev"],
    cwd: dirs.desktop,
    env,
  }
}

function browserHostProcess(input: {
  repoRoot: string
  bunPath: string
  serverUrl: string
  secret: string
}): DevProcessSpec {
  return {
    label: "browser-host",
    command: [input.bunPath, "run", "browser-host:dev"],
    cwd: directories(input.repoRoot).desktop,
    env: {
      SYNERGY_BROWSER_HOST_SERVER_URL: input.serverUrl,
      SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: input.secret,
    },
  }
}

export function createDevPlan(args: string[], options: PlanOptions = {}): DevPlan {
  const repoRoot = options.repoRoot ?? defaultRepoRoot()
  const launchCwd = options.cwd ?? process.cwd()
  const bunPath = options.bunPath ?? process.env.BUN_BIN ?? process.execPath
  const help = helpText()
  const [rawCommand, ...rest] = args
  const command = rawCommand ?? "help"
  if (
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    rest.includes("--help") ||
    rest.includes("-h")
  ) {
    return { kind: "help", help, exitCode: 0, processes: [], requiredPorts: [], requiredServers: [] }
  }

  const parsed = parseArgs(rest)
  const dirs = directories(repoRoot)
  const browserHostSecret = randomBytes(32).toString("hex")

  if (command === "prepare") {
    return {
      kind: "run",
      mode: "prepare",
      command,
      help,
      exitCode: 0,
      processes: [],
      requiredPorts: [],
      requiredServers: [],
    }
  }

  if (command === "server") {
    const port = numberFlag(parsed.flags, "port", DEFAULT_SERVER_PORT)
    const hostname = stringFlag(parsed.flags, "hostname", DEFAULT_HOSTNAME)
    return {
      kind: "run",
      mode: "parallel",
      command,
      help,
      exitCode: 0,
      processes: [
        serverProcess({
          repoRoot,
          launchCwd,
          bunPath,
          port,
          hostname,
          printLogs: boolFlag(parsed.flags, "print-logs"),
          browserHostSecret,
        }),
      ],
      requiredPorts: [{ label: "server", port, host: displayHost(hostname) }],
      requiredServers: [],
    }
  }

  if (command === "app") {
    const appPort = numberFlag(parsed.flags, "port", DEFAULT_APP_PORT)
    const hostname = stringFlag(parsed.flags, "hostname", DEFAULT_HOSTNAME)
    const attachUrl = normalizeUrl(stringFlag(parsed.flags, "attach", serverUrl(DEFAULT_HOSTNAME, DEFAULT_SERVER_PORT)))
    return {
      kind: "run",
      mode: "parallel",
      command,
      help,
      exitCode: 0,
      processes: [appProcess({ repoRoot, bunPath, appPort, attachUrl, hostname })],
      openUrl: boolFlag(parsed.flags, "open") ? appUrl(hostname, appPort) : undefined,
      requiredPorts: [{ label: "app", port: appPort, host: displayHost(hostname) }],
      requiredServers: [attachUrl],
    }
  }

  if (command === "web") {
    const serverPort = numberFlag(parsed.flags, "server-port", DEFAULT_SERVER_PORT)
    const appPort = numberFlag(parsed.flags, "app-port", DEFAULT_APP_PORT)
    const hostname = stringFlag(parsed.flags, "hostname", DEFAULT_HOSTNAME)
    const attach = typeof parsed.flags.attach === "string" ? normalizeUrl(parsed.flags.attach) : undefined
    const attachUrl = attach ?? serverUrl(hostname, serverPort)
    const processes = [
      ...(attach
        ? []
        : [
            serverProcess({
              repoRoot,
              launchCwd,
              bunPath,
              port: serverPort,
              hostname,
              printLogs: boolFlag(parsed.flags, "print-logs"),
              browserHostSecret,
            }),
          ]),
      appProcess({ repoRoot, bunPath, appPort, attachUrl, hostname }),
      ...(attach ? [] : [browserHostProcess({ repoRoot, bunPath, serverUrl: attachUrl, secret: browserHostSecret })]),
    ]
    return {
      kind: "run",
      mode: "parallel",
      command,
      help,
      exitCode: 0,
      processes,
      openUrl: boolFlag(parsed.flags, "open", true) ? appUrl(hostname, appPort) : undefined,
      requiredPorts: [
        ...(attach ? [] : [{ label: "server", port: serverPort, host: displayHost(hostname) }]),
        { label: "app", port: appPort, host: displayHost(hostname) },
      ],
      requiredServers: attach ? [attachUrl] : [],
    }
  }

  if (command === "tui") {
    const serverPort = numberFlag(parsed.flags, "server-port", DEFAULT_SERVER_PORT)
    const hostname = stringFlag(parsed.flags, "hostname", DEFAULT_HOSTNAME)
    const attach = typeof parsed.flags.attach === "string" ? normalizeUrl(parsed.flags.attach) : undefined
    const attachUrl = attach ?? serverUrl(hostname, serverPort)
    const scopeID = typeof parsed.flags.scope === "string" ? parsed.flags.scope : undefined
    const directory = typeof parsed.flags.directory === "string" ? parsed.flags.directory : undefined
    const sessionID = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined
    const theme = stringFlag(parsed.flags, "theme", "system")
    const processes = [
      ...(attach
        ? []
        : [
            serverProcess({
              repoRoot,
              launchCwd,
              bunPath,
              port: serverPort,
              hostname,
              printLogs: boolFlag(parsed.flags, "print-logs"),
              browserHostSecret,
            }),
          ]),
      tuiProcess({ repoRoot, launchCwd, bunPath, attachUrl, directory, scopeID, sessionID, theme }),
    ]
    return {
      kind: "run",
      mode: "parallel",
      command,
      help,
      exitCode: 0,
      processes,
      requiredPorts: attach ? [] : [{ label: "server", port: serverPort, host: displayHost(hostname) }],
      requiredServers: attach ? [attachUrl] : [],
    }
  }

  if (command === "desktop") {
    const managed = boolFlag(parsed.flags, "managed")
    if (managed) {
      const dependenciesInstalled = fs.existsSync(path.join(repoRoot, "node_modules"))
      const processes: DevProcessSpec[] = [
        ...(dependenciesInstalled ? [] : [{ label: "install" as const, command: [bunPath, "install"], cwd: repoRoot }]),
        { label: "build:plugin", command: [bunPath, "run", "build"], cwd: dirs.plugin },
        { label: "build", command: [bunPath, "run", "build"], cwd: dirs.app },
        desktopProcess({ repoRoot, bunPath, mode: "managed", browserHostSecret }),
      ]
      return {
        kind: "run",
        mode: "serial",
        command,
        help,
        exitCode: 0,
        processes,
        requiredPorts: [],
        requiredServers: [],
      }
    }

    const serverPort = numberFlag(parsed.flags, "server-port", DEFAULT_SERVER_PORT)
    const appPort = numberFlag(parsed.flags, "app-port", DEFAULT_APP_PORT)
    const hostname = stringFlag(parsed.flags, "hostname", DEFAULT_HOSTNAME)
    const attach = typeof parsed.flags.attach === "string" ? normalizeUrl(parsed.flags.attach) : undefined
    const attachUrl = attach ?? serverUrl(hostname, serverPort)
    const processes = [
      ...(attach
        ? []
        : [
            serverProcess({
              repoRoot,
              launchCwd,
              bunPath,
              port: serverPort,
              hostname,
              printLogs: boolFlag(parsed.flags, "print-logs"),
              browserHostSecret,
            }),
          ]),
      appProcess({ repoRoot, bunPath, appPort, attachUrl, hostname }),
      desktopProcess({
        repoRoot,
        bunPath,
        mode: "external",
        appPort,
        appHostname: hostname,
        browserServerUrl: attach ? undefined : attachUrl,
        browserHostSecret: attach ? undefined : browserHostSecret,
      }),
    ]
    return {
      kind: "run",
      mode: "parallel",
      command,
      help,
      exitCode: 0,
      processes,
      requiredPorts: [
        ...(attach ? [] : [{ label: "server", port: serverPort, host: displayHost(hostname) }]),
        { label: "app", port: appPort, host: displayHost(hostname) },
      ],
      requiredServers: attach ? [attachUrl] : [],
    }
  }

  if (command === "send") {
    if (parsed.positionals.length === 0) return errorPlan("Usage: bun dev send <message...>", help)
    return {
      kind: "run",
      mode: "serial",
      command,
      help,
      exitCode: 0,
      processes: [
        {
          label: "send",
          command: [bunPath, "run", "--conditions=browser", "./src/index.ts", "send", ...parsed.positionals],
          cwd: dirs.synergy,
          env: { SYNERGY_CWD: process.env.SYNERGY_CWD ?? launchCwd },
        },
      ],
      requiredPorts: [],
      requiredServers: [],
    }
  }

  if (command === "build") {
    const target = parsed.positionals[0]
    if (target !== "app" && target !== "desktop") {
      return errorPlan("Usage: bun dev build app|desktop", help)
    }
    return {
      kind: "run",
      mode: "serial",
      command,
      help,
      exitCode: 0,
      processes: [
        target === "app"
          ? { label: "build", command: [bunPath, "run", "build"], cwd: dirs.app }
          : { label: "build", command: [bunPath, "run", "desktop:build"], cwd: dirs.desktop },
      ],
      requiredPorts: [],
      requiredServers: [],
    }
  }

  return errorPlan(`Unknown dev command: ${command}`, help)
}

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

async function waitForUrl(
  url: string,
  options: {
    timeoutMs?: number | null
    child?: ReturnType<typeof spawnDevProcess>
    label?: string
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs
  const start = Date.now()
  let lastError = ""
  while (timeoutMs === null || Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    const child = options.child
    if (child && child.exitCode !== null) {
      throw new Error(
        `${options.label ?? "process"} exited with code ${child.exitCode} before ${url} became ready${lastError ? ` (${lastError})` : ""}`,
      )
    }
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ""}`)
}

async function assertPreflight(plan: DevPlan): Promise<void> {
  for (const item of plan.requiredPorts) {
    if (!(await isPortAvailable(item.port, item.host))) {
      throw new Error(
        `${item.label} port ${item.port} is already in use. Stop the existing process or choose a different port.`,
      )
    }
  }
  for (const url of plan.requiredServers) {
    await waitForUrl(`${normalizeUrl(url)}/global/health`, { timeoutMs: 5_000 })
  }
}

function prefixedStream(
  stream: ReadableStream<Uint8Array> | null,
  label: string,
  write: (chunk: string) => void,
): void {
  if (!stream) return
  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) write(`[${label}] ${line}\n`)
    }
    const tail = buffer + decoder.decode()
    if (tail) write(`[${label}] ${tail}\n`)
    reader.releaseLock()
  })()
}

export function spawnDevProcess(spec: DevProcessSpec) {
  const owner = randomBytes(16).toString("hex")
  const proc = spec.interactive
    ? Bun.spawn(spec.command, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}), [DEV_PROCESS_OWNER_ENV]: owner },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: process.platform !== "win32",
      })
    : Bun.spawn(spec.command, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}), [DEV_PROCESS_OWNER_ENV]: owner },
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      })
  devProcessOwners.set(proc, owner)
  if (proc.stdout instanceof ReadableStream)
    prefixedStream(proc.stdout, spec.label, (chunk) => process.stdout.write(chunk))
  if (proc.stderr instanceof ReadableStream)
    prefixedStream(proc.stderr, spec.label, (chunk) => process.stderr.write(chunk))
  return proc
}

type DevProcess = ReturnType<typeof spawnDevProcess>

async function taskkill(pid: number): Promise<void> {
  const command = ["taskkill", "/pid", String(pid), "/t", "/f"]
  const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
  await proc.exited
}

function signalProcessGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-processGroupId, signal)
  } catch {}
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(25)
  }
  return true
}

function descendantProcessGroups(children: DevProcess[]): number[] {
  const activeRoots = children.flatMap((child) => (child.exitCode === null && child.pid ? [child.pid] : []))
  const ownerMarkers = children.flatMap((child) => {
    const owner = devProcessOwners.get(child)
    return owner ? [`${DEV_PROCESS_OWNER_ENV}=${owner}`] : []
  })
  const groups = new Set(activeRoots)
  const result = (() => {
    try {
      const includeNoTty = process.platform === "darwin" ? "-x" : "x"
      return Bun.spawnSync(["ps", "eww", includeNoTty, "-o", "pid=,ppid=,pgid=,command="], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      })
    } catch {
      return undefined
    }
  })()
  if (!result || result.exitCode !== 0) return [...groups]

  const processes = new Map<number, { parentPid: number; processGroupId: number }>()
  const descendants = new Set(activeRoots)
  for (const line of result.stdout.toString().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    const process = { parentPid: Number(match[2]), processGroupId: Number(match[3]) }
    processes.set(pid, process)
    if (!ownerMarkers.some((marker) => match[4].includes(marker))) continue
    descendants.add(pid)
    groups.add(process.processGroupId)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [pid, process] of processes) {
      if (descendants.has(pid) || !descendants.has(process.parentPid)) continue
      descendants.add(pid)
      groups.add(process.processGroupId)
      changed = true
    }
  }
  return [...groups]
}

export async function terminateDevProcesses(children: DevProcess[]): Promise<void> {
  const active = children.filter((child) => child.exitCode === null)
  if (process.platform === "win32") {
    await Promise.all(active.flatMap((child) => (child.pid ? [taskkill(child.pid)] : [])))
    await Promise.race([Promise.allSettled(children.map((child) => child.exited)), Bun.sleep(1000)])
    return
  }

  const processGroups = descendantProcessGroups(children)
  for (const processGroupId of processGroups) signalProcessGroup(processGroupId, "SIGTERM")
  const settle = Promise.allSettled(children.map((child) => child.exited))
  await Promise.all(processGroups.map((processGroupId) => waitForProcessGroupExit(processGroupId, 3000)))
  for (const processGroupId of processGroups) {
    if (processGroupExists(processGroupId)) signalProcessGroup(processGroupId, "SIGKILL")
  }
  await Promise.all(processGroups.map((processGroupId) => waitForProcessGroupExit(processGroupId, 1000)))
  await Promise.race([settle, Bun.sleep(1000)])
}

async function runSerial(processes: DevProcessSpec[]): Promise<number> {
  const children: DevProcess[] = []
  let exiting = false
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => (cleanupPromise ??= terminateDevProcesses(children))
  const handleSignal = (exitCode: number) => async () => {
    if (exiting) return
    exiting = true
    await cleanup()
    process.exit(exitCode)
  }
  const handleSigint = handleSignal(130)
  const handleSigterm = handleSignal(143)
  process.once("SIGINT", handleSigint)
  process.once("SIGTERM", handleSigterm)
  try {
    for (const spec of processes) {
      const proc = spawnDevProcess(spec)
      children.push(proc)
      const exitCode = await proc.exited
      if (exitCode !== 0) return exitCode
    }
    return 0
  } finally {
    process.off("SIGINT", handleSigint)
    process.off("SIGTERM", handleSigterm)
    await cleanup()
  }
}

async function runParallel(plan: DevPlan): Promise<number> {
  await assertPreflight(plan)
  const children: DevProcess[] = []
  let exiting = false
  const cleanup = () => terminateDevProcesses(children)
  process.once("SIGINT", async () => {
    if (exiting) return
    exiting = true
    await cleanup()
    process.exit(130)
  })
  process.once("SIGTERM", async () => {
    if (exiting) return
    exiting = true
    await cleanup()
    process.exit(143)
  })
  try {
    for (const spec of plan.processes) {
      const child = spawnDevProcess(spec)
      children.push(child)
      if (spec.waitUrl) await waitForUrl(spec.waitUrl, { timeoutMs: spec.waitTimeoutMs, child, label: spec.label })
    }
    if (plan.openUrl) openExternal(plan.openUrl)
    if (children.length === 0) return 0
    const firstExit = await Promise.race(children.map((child) => child.exited))
    await cleanup()
    return firstExit
  } catch (error) {
    await cleanup()
    throw error
  }
}

function openExternal(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
}

async function commandExists(command: string): Promise<boolean> {
  const check = process.platform === "win32" ? ["where", command] : ["which", command]
  const proc = Bun.spawn(check, { stdout: "ignore", stderr: "ignore" })
  return (await proc.exited) === 0
}

async function runPrepare(repoRoot: string, bunPath: string): Promise<number> {
  const dirs = directories(repoRoot)
  const initial = await runSerial([
    { label: "install", command: [bunPath, "install"], cwd: repoRoot },
    { label: "generate", command: [bunPath, "./script/generate.ts"], cwd: repoRoot },
    // Build plugin (and its util dependency) before app so Vite can resolve
    // @ericsanchezok/synergy-plugin from its `dist/` exports map.
    { label: "build:plugin", command: [bunPath, "run", "build"], cwd: dirs.plugin },
    { label: "build", command: [bunPath, "run", "build"], cwd: dirs.app },
  ])
  if (initial !== 0) return initial

  const platform = process.platform
  if (platform !== "linux" && platform !== "win32") return 0

  const helperDir =
    platform === "linux"
      ? path.join(dirs.synergy, "src", "sandbox", "helper-linux")
      : path.join(dirs.synergy, "src", "sandbox", "helper")
  if (!fs.existsSync(path.join(helperDir, "Cargo.toml"))) {
    process.stderr.write("[sandbox] helper source not found; sandbox helper was not compiled\n")
    return 0
  }
  if (!(await commandExists("cargo"))) {
    process.stderr.write("[sandbox] cargo not found; install Rust from https://rustup.rs and rerun bun dev prepare\n")
    return 0
  }
  const target = platform === "linux" ? "linux" : "windows"
  const sandbox = await runSerial([
    {
      label: "sandbox",
      command: [bunPath, "run", "packages/synergy/scripts/build-helper.ts", target, "--local"],
      cwd: repoRoot,
    },
  ])
  if (sandbox !== 0) return sandbox
  if (platform === "linux" && !(await commandExists("bwrap"))) {
    process.stderr.write(
      "[sandbox] bwrap not found; install bubblewrap or run packages/synergy/scripts/download-bwrap.sh\n",
    )
  }
  return 0
}

export async function runDevPlan(plan: DevPlan, options: PlanOptions = {}): Promise<number> {
  if (plan.kind === "help") {
    process.stdout.write(plan.help)
    return 0
  }
  if (plan.kind === "error") {
    process.stderr.write(`${plan.message}\n\n${plan.help}`)
    return plan.exitCode
  }
  if (plan.mode === "prepare") {
    return runPrepare(options.repoRoot ?? defaultRepoRoot(), options.bunPath ?? process.env.BUN_BIN ?? process.execPath)
  }
  if (plan.mode === "serial") return runSerial(plan.processes)
  return runParallel(plan)
}

if (import.meta.main) {
  const repoRoot = defaultRepoRoot()
  const cwd = process.cwd()
  const plan = createDevPlan(Bun.argv.slice(2), { repoRoot, cwd })
  try {
    process.exitCode = await runDevPlan(plan, { repoRoot, cwd })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
