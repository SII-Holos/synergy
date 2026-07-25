#!/usr/bin/env bun
import process from "node:process"
import { log } from "@clack/prompts"
import { SynergyLinkCLIBackend, type SynergyLinkTrustSubject } from "./cli-backend"
import type { SynergyLinkApprovalMode } from "./state/store"
import { SynergyLinkRuntime } from "./runtime"
import { SynergyLinkService } from "./service"
import { SynergyLinkHolosLogin } from "./holos/login"
import { SynergyLinkCLIFormat } from "./cli/format"

interface CLIContext {
  json: boolean
  printLogs: boolean
  invocationEntry?: string
  launcherPath: string
}

interface GlobalFlags {
  help: boolean
  json: boolean
  printLogs: boolean
}

interface SynergyLinkLoginOptions {
  agentID?: string
  agentSecret?: string
}

interface CommandSuccess {
  ok: true
  message?: string
  data?: unknown
  output?: string
}

interface CommandFailure {
  ok: false
  message: string
  data?: unknown
  usage?: string
  exitCode?: number
}

type CommandResult = CommandSuccess | CommandFailure

async function main() {
  const parsed = parseArgv(process.argv.slice(2))
  if (!parsed.ok) {
    renderFailure(parsed.error, {
      json: false,
      printLogs: false,
      invocationEntry: process.argv[1],
      launcherPath: process.execPath,
    })

    process.exit(parsed.error.exitCode ?? 1)
  }

  const context: CLIContext = {
    json: parsed.flags.json,
    printLogs: parsed.flags.printLogs,
    invocationEntry: process.argv[1],
    launcherPath: process.execPath,
  }

  if (parsed.flags.help || parsed.command.length === 0) {
    printUsage(parsed.command)
    return
  }

  try {
    const result = await dispatch(parsed.command, context)
    if (result.ok) {
      renderSuccess(result, context)
      return
    }

    renderFailure(result, context)
    process.exit(result.exitCode ?? 1)
  } catch (error) {
    const failure: CommandFailure = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    }
    renderFailure(failure, context)
    process.exit(1)
  }
}

async function dispatch(command: string[], context: CLIContext): Promise<CommandResult> {
  const [head, ...rest] = command

  switch (head) {
    case "server":
      return runServer(rest, context)
    case "start":
      return startService(rest, context)
    case "stop":
      return stopService(rest)
    case "restart":
      return restartService(rest, context)
    case "status":
      return showStatus(rest)
    case "logs":
      return showLogs(rest, context)
    case "login":
      return login(rest)
    case "logout":
      return logout(rest)
    case "whoami":
      return whoami(rest)
    case "reconnect":
      return reconnect(rest)
    case "doctor":
      return doctor(rest)
    case "mode":
      return handleMode(rest)
    case "collaboration":
      return handleCollaboration(rest)
    case "requests":
      return handleRequests(rest)
    case "session":
      return handleSession(rest)
    case "approval":
      return handleApproval(rest)
    case "trust":
      return handleTrust(rest)
    case "label":
      return handleLabel(rest)
    case "enable":
      return handleCollaboration(["enable", ...rest])
    case "disable":
      return handleCollaboration(["disable", ...rest])
    case "kick":
      return handleSession(["kick", ...rest])
    case "block":
      return handleSession(["block", ...rest])
    default:
      return unknownCommand(command)
  }
}

async function runServer(args: string[], context: CLIContext): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link server [--print-logs]")
  }
  if (context.json) {
    return {
      ok: false,
      message: "`--json` is not supported for `server`.",
      usage: "Usage: synergy-link server [--print-logs]",
    }
  }
  const runtime = await SynergyLinkRuntime.create()
  await runtime.start({ printLogs: context.printLogs })
  return { ok: true }
}

async function startService(args: string[], context: CLIContext): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link start")
  }
  const service = await SynergyLinkService.start({
    launcherPath: context.launcherPath,
    invocationEntry: context.invocationEntry,
    printLogs: false,
  })
  if (!service.running) {
    return {
      ok: false,
      message: "Synergy Link service failed to start.",
      data: service,
    }
  }
  return {
    ok: true,
    message: service.alreadyRunning
      ? `Synergy Link service is already running${typeof service.pid === "number" ? ` (pid ${service.pid})` : ""}.`
      : `Synergy Link service started${typeof service.pid === "number" ? ` (pid ${service.pid})` : ""}.`,
  }
}

async function stopService(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link stop")
  }
  const service = await SynergyLinkService.stop()
  return {
    ok: true,
    message: service.alreadyStopped ? "Synergy Link service is not running." : "Synergy Link service stopped.",
  }
}

async function restartService(args: string[], context: CLIContext): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link restart")
  }
  const result = await SynergyLinkService.restart({
    launcherPath: context.launcherPath,
    invocationEntry: context.invocationEntry,
    printLogs: false,
  })
  if (!result.started.running) {
    return {
      ok: false,
      message: "Synergy Link service failed to restart.",
      data: result,
    }
  }
  return {
    ok: true,
    message: `Synergy Link service restarted${typeof result.started.pid === "number" ? ` (pid ${result.started.pid})` : ""}.`,
  }
}

async function showStatus(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link status")
  }
  const status = await SynergyLinkCLIBackend.status()
  return {
    ok: true,
    data: status,
  }
}

async function showLogs(args: string[], context: CLIContext): Promise<CommandResult> {
  const parsed = parseLogsArgs(args)
  if (!parsed.ok) {
    return invalidUsage(parsed.usage)
  }
  if (parsed.follow && context.json) {
    return {
      ok: false,
      message: "`--json` is not supported with `logs -f`.",
      usage: "Usage: synergy-link logs [-f] [--tail N] [--since DURATION]",
    }
  }
  const logs = await SynergyLinkService.readLogs({
    tailLines: parsed.tailLines,
    since: parsed.since,
    maxBytes: parsed.follow ? undefined : 64_000,
  })
  if (parsed.follow) {
    await SynergyLinkService.followLogs({
      tailLines: parsed.tailLines,
      since: parsed.since,
      onChunk: (chunk) => {
        if (chunk.length > 0) process.stdout.write(chunk)
      },
    })
    return { ok: true }
  }
  return {
    ok: true,
    data: logs,
    output: context.json ? undefined : logs.content,
  }
}

async function login(args: string[]): Promise<CommandResult> {
  const parsed = parseLoginArgs(args)
  if (!parsed.ok) {
    return invalidUsage(parsed.usage)
  }

  if (parsed.options.agentID || parsed.options.agentSecret) {
    if (!parsed.options.agentID || !parsed.options.agentSecret) {
      return {
        ok: false,
        message: "`--agent-id` and `--agent-secret` must be provided together.",
        usage: loginUsage(),
      }
    }

    const result = await SynergyLinkCLIBackend.login({
      agentID: parsed.options.agentID,
      agentSecret: parsed.options.agentSecret,
    })
    return {
      ok: true,
      message: `Logged in as ${result.agentID}.`,
      data: result,
    }
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const mode = await SynergyLinkHolosLogin.promptLoginMode()
    if (mode === "existing") {
      const credentials = await SynergyLinkHolosLogin.promptForExistingCredentials()
      if (!credentials) {
        return {
          ok: false,
          message: "Login cancelled.",
          exitCode: 1,
        }
      }

      const result = await SynergyLinkCLIBackend.login(credentials)
      return {
        ok: true,
        message: `Logged in as ${result.agentID}.`,
        data: result,
      }
    }
  }

  const result = await SynergyLinkCLIBackend.login()
  return {
    ok: true,
    message: `Logged in as ${result.agentID}.`,
    data: result,
  }
}

async function logout(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link logout")
  }
  const result = await SynergyLinkCLIBackend.logout()
  return {
    ok: true,
    message: "Logged out from Holos.",
    data: result,
  }
}

async function whoami(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link whoami")
  }
  const result = await SynergyLinkCLIBackend.whoami()
  return {
    ok: true,
    data: result,
  }
}

async function reconnect(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link reconnect")
  }
  const result = await SynergyLinkCLIBackend.reconnect()
  return {
    ok: true,
    message: "Reconnect requested.",
    data: result,
  }
}

async function doctor(args: string[]): Promise<CommandResult> {
  if (args.length > 0) {
    return invalidUsage("Usage: synergy-link doctor")
  }
  const result = await SynergyLinkCLIBackend.doctor()
  return {
    ok: result.ok,
    message: result.ok ? "Synergy Link checks passed." : "Synergy Link checks found issues.",
    data: result,
  }
}

async function handleMode(args: string[]): Promise<CommandResult> {
  const [action, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link mode <status|managed|standalone>")
  }
  if (rest.length > 0) {
    return invalidUsage("Usage: synergy-link mode <status|managed|standalone>")
  }
  if (action === "status") {
    return {
      ok: true,
      data: await SynergyLinkCLIBackend.mode(),
    }
  }
  if (action === "managed") {
    return {
      ok: true,
      message: "Managed mode enabled.",
      data: await SynergyLinkCLIBackend.enterManagedMode(),
    }
  }
  if (action === "standalone") {
    return {
      ok: true,
      message: "Standalone mode enabled.",
      data: await SynergyLinkCLIBackend.enterStandaloneMode(),
    }
  }
  return invalidUsage("Usage: synergy-link mode <status|managed|standalone>")
}

async function handleCollaboration(args: string[]): Promise<CommandResult> {
  const [action, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link collaboration <enable|disable|status>")
  }
  if (rest.length > 0) {
    return invalidUsage("Usage: synergy-link collaboration <enable|disable|status>")
  }
  if (action === "enable") {
    const result = await SynergyLinkCLIBackend.setCollaborationEnabled(true)
    return {
      ok: true,
      message: "Collaboration enabled.",
      data: result,
    }
  }
  if (action === "disable") {
    const result = await SynergyLinkCLIBackend.setCollaborationEnabled(false)
    return {
      ok: true,
      message: "Collaboration disabled.",
      data: result,
    }
  }
  if (action === "status") {
    const result = await SynergyLinkCLIBackend.collaborationStatus()
    return {
      ok: true,
      data: result,
    }
  }
  return invalidUsage("Usage: synergy-link collaboration <enable|disable|status>")
}

async function handleRequests(args: string[]): Promise<CommandResult> {
  const [action, requestID, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link requests <list|show|approve|deny> [request-id]")
  }
  if (action === "list" && !requestID && rest.length === 0) {
    return fromAvailability(await SynergyLinkCLIBackend.listRequests(), "requests list")
  }
  if ((action === "show" || action === "approve" || action === "deny") && requestID && rest.length === 0) {
    const result =
      action === "show"
        ? await SynergyLinkCLIBackend.showRequest(requestID)
        : action === "approve"
          ? await SynergyLinkCLIBackend.approveRequest(requestID)
          : await SynergyLinkCLIBackend.denyRequest(requestID)
    return fromAvailability(result, `requests ${action}`)
  }
  return invalidUsage("Usage: synergy-link requests <list|show|approve|deny> [request-id]")
}

async function handleSession(args: string[]): Promise<CommandResult> {
  const [action, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link session <status|kick|block>")
  }
  if (rest.length > 0) {
    return invalidUsage("Usage: synergy-link session <status|kick|block>")
  }
  if (action === "status") {
    const result = await SynergyLinkCLIBackend.sessionStatus()
    return {
      ok: true,
      data: result,
    }
  }
  if (action === "kick" || action === "block") {
    const result = await SynergyLinkCLIBackend.kickSession(action === "block")
    return {
      ok: true,
      message: result.requested
        ? action === "block"
          ? "Requested current collaboration session to close and block the collaborator."
          : "Requested current collaboration session to close."
        : "No active collaboration session.",
      data: result,
    }
  }
  return invalidUsage("Usage: synergy-link session <status|kick|block>")
}

async function handleApproval(args: string[]): Promise<CommandResult> {
  const [action, value, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link approval <get|set <auto|manual|trusted-only>>")
  }
  if (action === "get" && !value && rest.length === 0) {
    return fromAvailability(await SynergyLinkCLIBackend.getApproval(), "approval get")
  }
  if (action === "set" && isApprovalMode(value) && rest.length === 0) {
    return fromAvailability(await SynergyLinkCLIBackend.setApproval(value), "approval set")
  }
  return invalidUsage("Usage: synergy-link approval <get|set <auto|manual|trusted-only>>")
}

async function handleTrust(args: string[]): Promise<CommandResult> {
  const [action, subject, value, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link trust <list|add|remove> [agent|user] [value]")
  }
  if (action === "list" && !subject && !value && rest.length === 0) {
    return fromAvailability(await SynergyLinkCLIBackend.listTrust(), "trust list")
  }
  if ((action === "add" || action === "remove") && isTrustSubject(subject) && value && rest.length === 0) {
    const result =
      action === "add"
        ? await SynergyLinkCLIBackend.addTrust(subject, value)
        : await SynergyLinkCLIBackend.removeTrust(subject, value)
    return fromAvailability(result, `trust ${action}`)
  }
  return invalidUsage("Usage: synergy-link trust <list|add|remove> [agent|user] [value]")
}

async function handleLabel(args: string[]): Promise<CommandResult> {
  const [action, ...rest] = args
  if (!action || action === "help") {
    return invalidUsage("Usage: synergy-link label <get|set <label>|clear>")
  }
  if (action === "get" && rest.length === 0) {
    return {
      ok: true,
      data: await SynergyLinkCLIBackend.getLabel(),
    }
  }
  if (action === "clear" && rest.length === 0) {
    return {
      ok: true,
      message: "Label cleared.",
      data: await SynergyLinkCLIBackend.setLabel(null),
    }
  }
  if (action === "set" && rest.length > 0) {
    const label = rest.join(" ").trim()
    if (!label) {
      return invalidUsage("Usage: synergy-link label set <label>")
    }
    return {
      ok: true,
      message: `Label set to ${label}.`,
      data: await SynergyLinkCLIBackend.setLabel(label),
    }
  }
  return invalidUsage("Usage: synergy-link label <get|set <label>|clear>")
}

function fromAvailability(
  result: { available: false; reason: string } | { available: true; value: unknown },
  command: string,
): CommandResult {
  if (!result.available) {
    return {
      ok: false,
      message: `${command} is not available in this build: ${result.reason}`,
      data: result,
    }
  }
  return {
    ok: true,
    data: result.value,
  }
}

function invalidUsage(usage: string): CommandFailure {
  return {
    ok: false,
    message: usage,
    usage,
    exitCode: 1,
  }
}

function unknownCommand(command: string[]): CommandFailure {
  return {
    ok: false,
    message: `Unknown command: ${command.join(" ")}`,
    usage: rootUsage(),
    exitCode: 1,
  }
}

function parseArgv(
  argv: string[],
):
  | { ok: true; command: string[]; flags: { help: boolean; json: boolean; printLogs: boolean } }
  | { ok: false; error: CommandFailure } {
  const command: string[] = []
  let help = false
  let json = false
  let printLogs = false

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      help = true
      continue
    }
    if (token === "--json") {
      json = true
      continue
    }
    if (token === "--print-logs") {
      printLogs = true
      continue
    }
    if (token.startsWith("-")) {
      if (command[0] === "logs" || command[0] === "login") {
        command.push(token)
        continue
      }
      return {
        ok: false,
        error: {
          ok: false,
          message: `Unknown option: ${token}`,
          usage: rootUsage(),
          exitCode: 1,
        },
      }
    }
    command.push(token)
  }

  return {
    ok: true,
    command,
    flags: { help, json, printLogs },
  }
}

function renderSuccess(result: CommandSuccess, context: CLIContext) {
  if (context.json) {
    console.log(JSON.stringify({ ok: true, ...(result.data === undefined ? {} : { data: result.data }) }, null, 2))
    return
  }

  if (result.output !== undefined) {
    if (result.output.length > 0) {
      process.stdout.write(result.output)
      if (!result.output.endsWith("\n")) process.stdout.write("\n")
    }
    return
  }

  const text = result.data === undefined ? "" : SynergyLinkCLIFormat.human(result.data)
  if (result.message) {
    log.success(result.message)
  }

  if (text && text !== result.message) {
    console.log(text)
  }
}

function renderFailure(result: CommandFailure, context: CLIContext) {
  if (context.json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: {
            message: result.message,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.data === undefined ? {} : { details: result.data }),
          },
        },
        null,
        2,
      ),
    )
    return
  }

  const text = result.data === undefined ? "" : SynergyLinkCLIFormat.human(result.data)
  if (text) {
    console.log(text)
  }
  if (!text || text !== result.message) {
    log.error(result.message)
  }
  if (result.usage && result.usage !== result.message) {
    console.error(result.usage)
  }
}

function printUsage(command: string[]) {
  if (command.length === 0) {
    console.log(rootUsage())
    return
  }

  const key = command.join(" ")
  const usage = usageMap()[key] ?? usageMap()[command[0]]
  console.log(usage ?? rootUsage())
}

function rootUsage() {
  const sections = [
    "Service:",
    "  server [--print-logs]          Run the service in the foreground",
    "  start | stop | restart         Manage the background service",
    "  status                         Show host, auth, and session status",
    "  logs [-f] [--tail N] [--since DURATION]",
    "",
    "Identity:",
    "  login [--agent-id ID --agent-secret SECRET]",
    "  logout | whoami | reconnect | doctor",
    "",
    "Collaboration:",
    "  mode <status|managed|standalone>",
    "  collaboration <enable|disable|status>",
    "  requests <list|show|approve|deny> [request-id]",
    "  session <status|kick|block>",
    "  approval <get|set <auto|manual|trusted-only>>",
    "  trust <list|add|remove> [agent|user] [value]",
    "  label <get|set <label>|clear>",
    "",
    "Options:",
    "  --json        Emit machine-readable output where supported",
    "  --help, -h    Show help",
  ]
  const headings = new Set(["Service:", "Identity:", "Collaboration:", "Options:"])
  const body = sections.map((line) => (headings.has(line) ? SynergyLinkCLIFormat.heading(line) : line)).join("\n")
  return `Usage: synergy-link <command> [options]\n\n${body}`
}

function usageMap(): Record<string, string> {
  return {
    server: "Usage: synergy-link server [--print-logs]",
    start: "Usage: synergy-link start",
    stop: "Usage: synergy-link stop",
    restart: "Usage: synergy-link restart",
    status: "Usage: synergy-link status",
    logs: "Usage: synergy-link logs [-f] [--tail N] [--since DURATION]",
    login: loginUsage(),
    logout: "Usage: synergy-link logout",
    whoami: "Usage: synergy-link whoami",
    reconnect: "Usage: synergy-link reconnect",
    doctor: "Usage: synergy-link doctor",
    mode: "Usage: synergy-link mode <status|managed|standalone>",
    collaboration: "Usage: synergy-link collaboration <enable|disable|status>",
    requests: "Usage: synergy-link requests <list|show|approve|deny> [request-id]",
    session: "Usage: synergy-link session <status|kick|block>",
    approval: "Usage: synergy-link approval <get|set <auto|manual|trusted-only>>",
    trust: "Usage: synergy-link trust <list|add|remove> [agent|user] [value]",
    label: "Usage: synergy-link label <get|set <label>|clear>",
  }
}

function isApprovalMode(value: string | undefined): value is SynergyLinkApprovalMode {
  return value === "auto" || value === "manual" || value === "trusted-only"
}

function isTrustSubject(value: string | undefined): value is SynergyLinkTrustSubject {
  return value === "agent" || value === "user"
}

function loginUsage() {
  return [
    "Usage: synergy-link login [--agent-id ID --agent-secret SECRET]",
    "",
    "Without flags, interactive TTY sessions let you choose browser login or importing existing credentials.",
  ].join("\n")
}

function parseLoginArgs(args: string[]): { ok: true; options: SynergyLinkLoginOptions } | { ok: false; usage: string } {
  const options: SynergyLinkLoginOptions = {}

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === "--agent-id") {
      const next = args[index + 1]
      if (!next || next.startsWith("-")) {
        return { ok: false, usage: loginUsage() }
      }
      options.agentID = next
      index += 1
      continue
    }
    if (token === "--agent-secret") {
      const next = args[index + 1]
      if (!next || next.startsWith("-")) {
        return { ok: false, usage: loginUsage() }
      }
      options.agentSecret = next
      index += 1
      continue
    }
    return { ok: false, usage: loginUsage() }
  }

  return { ok: true, options }
}

function parseLogsArgs(
  args: string[],
): { ok: true; follow: boolean; tailLines?: number; since?: string } | { ok: false; usage: string } {
  let follow = false
  let tailLines: number | undefined
  let since: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === "-f") {
      follow = true
      continue
    }
    if (token === "--tail") {
      const next = args[index + 1]
      const value = Number(next)
      if (!next || !Number.isInteger(value) || value <= 0) {
        return { ok: false, usage: "Usage: synergy-link logs [-f] [--tail N] [--since DURATION]" }
      }
      tailLines = value
      index += 1
      continue
    }
    if (token === "--since") {
      const next = args[index + 1]
      if (!next) {
        return { ok: false, usage: "Usage: synergy-link logs [-f] [--tail N] [--since DURATION]" }
      }
      since = next
      index += 1
      continue
    }
    return { ok: false, usage: "Usage: synergy-link logs [-f] [--tail N] [--since DURATION]" }
  }

  return { ok: true, follow, tailLines, since }
}

await main()
