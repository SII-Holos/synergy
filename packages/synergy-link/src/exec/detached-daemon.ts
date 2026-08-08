import { statSync } from "node:fs"
import path from "node:path"
import process from "node:process"

export type DetachedDaemonRisk = {
  kind:
    | "tmux_detached"
    | "screen_detached"
    | "nohup"
    | "setsid"
    | "disown"
    | "daemonize"
    | "shell_background"
    | "windows_cmd_start"
    | "windows_dynamic_command"
    | "windows_command_too_complex"
    | "powershell_start_process"
    | "powershell_encoded_command"
    | "powershell_dynamic_command"
  pattern: string
}

export type WindowsCommandResolution = {
  workdir: string
  env: Record<string, string | undefined>
  isFile?: (candidate: string) => boolean
}

export type DetachedDaemonDetectionOptions = {
  windowsResolution?: WindowsCommandResolution
}

const commandBoundary = String.raw`(?:^|(?:&&|\|\||[;|\n\r(])\s*)`
// These launchers are rejected only on Windows (killOwnedByMarkers is a no-op
// there, so a detached descendant cannot be recovered after its launcher
// exits). POSIX hosts allow every detached launcher: session cleanup reaps
// marker-inheriting descendants (nohup, setsid, disown, daemonize, shell `&`),
// while tmux/screen launches through a possibly pre-existing server are not
// marker-attributed and are owned by the caller.
const detachedLauncherChecks: Array<{ kind: DetachedDaemonRisk["kind"]; pattern: string; regex: RegExp }> = [
  {
    kind: "tmux_detached",
    pattern: "tmux new-session -d",
    regex: new RegExp(`${commandBoundary}tmux\\s+(?:new-session|new)\\b(?=[\\s\\S]*?(?:^|\\s)-d(?:\\s|$))`),
  },
  {
    kind: "screen_detached",
    pattern: "screen -dm",
    regex: new RegExp(`${commandBoundary}screen\\s+(?:-dm\\S*|-d\\s+-m)(?:\\s|$)`),
  },
  { kind: "nohup", pattern: "nohup", regex: new RegExp(`${commandBoundary}nohup(?:\\s|$)`) },
  { kind: "setsid", pattern: "setsid", regex: new RegExp(`${commandBoundary}setsid(?:\\s|$)`) },
  { kind: "disown", pattern: "disown", regex: new RegExp(`${commandBoundary}disown(?:\\s|$)`) },
  { kind: "daemonize", pattern: "daemonize", regex: new RegExp(`${commandBoundary}daemonize(?:\\s|$)`) },
]

export function detectDetachedDaemonRisk(
  command: string,
  platform = process.platform,
  options?: DetachedDaemonDetectionOptions,
): DetachedDaemonRisk | undefined {
  if (platform !== "win32") return undefined
  const unquoted = maskQuotedShellText(command)
  if (command.length > maxWindowsCommandChars) return windowsCommandTooComplexRisk()
  for (const check of detachedLauncherChecks) {
    if (check.regex.test(unquoted)) return { kind: check.kind, pattern: check.pattern }
  }
  if (hasTopLevelBackgroundOperator(unquoted)) return { kind: "shell_background", pattern: "&" }
  const windowsResolution =
    options?.windowsResolution ??
    (platform === process.platform ? { workdir: process.cwd(), env: process.env } : undefined)
  return detectWindowsDetachedDaemonRisk(command, windowsResolution)
}

export function detachedDaemonBlockMessage(risk: DetachedDaemonRisk) {
  if (risk.kind === "windows_command_too_complex") {
    return [
      `Blocked Windows command before spawn: ${risk.pattern}`,
      "Windows Synergy Link inspects at most 16 KiB per command, 64 nested shell bodies, 128 KiB cumulatively, and 256 filesystem probes.",
      "Split the work into smaller tracked bash/process operations.",
    ].join("\n")
  }

  const windowsWarning =
    risk.kind.startsWith("windows_") || risk.kind.startsWith("powershell_")
      ? ["Windows Synergy Link cannot safely recover detached descendants after their launcher exits."]
      : []
  return [
    `Blocked direct detached daemon launch pattern: ${risk.pattern}`,
    ...windowsWarning,
    "Synergy Link remote execution supports only tracked foreground or background processes.",
    "Use the bash background/yieldSeconds flow and the process tool instead.",
  ].join("\n")
}

function maskQuotedShellText(command: string): string {
  const chars = command.split("")
  let quote: "'" | '"' | undefined
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!
    if (quote) {
      chars[index] = " "
      if (char === quote) quote = undefined
      else if (quote === '"' && char === "\\" && index + 1 < chars.length) chars[++index] = " "
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      chars[index] = " "
      continue
    }
    if (char === "\\" && index + 1 < chars.length) {
      chars[index] = " "
      chars[++index] = " "
    }
  }
  return chars.join("")
}

type WindowsShell = "cmd" | "powershell"

type WindowsToken = {
  value: string
  start: number
  end: number
}

type WindowsWorkItem = {
  command: string
  shell: WindowsShell
  depth: number
}

const maxWindowsCommandChars = 16_384
const maxWindowsNestingDepth = 64
const maxWindowsInspectionChars = 131_072
const maxWindowsResolutionProbes = 256

type CmdScriptResolution = "cmd_script" | "other" | "budget_exhausted"

type WindowsCommandResolutionContext = {
  workdir: string
  env: Map<string, string>
  pathDirectories: string[]
  extensions: string[]
  isFile: (candidate: string) => boolean
  commandCache: Map<string, CmdScriptResolution>
  fileCache: Map<string, boolean>
  probes: number
}

function detectWindowsDetachedDaemonRisk(
  command: string,
  windowsResolution?: WindowsCommandResolution,
): DetachedDaemonRisk | undefined {
  const pending: WindowsWorkItem[] = [{ command, shell: "cmd", depth: 0 }]
  const seen = new Set<string>()
  const resolutionContext = windowsResolution ? createWindowsCommandResolutionContext(windowsResolution) : undefined
  let cursor = 0
  let inspectedChars = 0
  while (cursor < pending.length) {
    const current = pending[cursor++]!
    const source = current.command.trim()
    const key = `${current.shell}\u0000${source}`
    if (!source || seen.has(key)) continue
    if (current.depth > maxWindowsNestingDepth) return windowsCommandTooComplexRisk()
    inspectedChars += source.length
    if (inspectedChars > maxWindowsInspectionChars) return windowsCommandTooComplexRisk()
    seen.add(key)

    const enqueue = (body: string, shell: WindowsShell) => {
      pending.push({ command: body, shell, depth: current.depth + 1 })
    }

    for (const segment of windowsCommandSegments(source, current.shell)) {
      const invocation = readWindowsInvocation(segment)
      if (!invocation) continue

      const dynamicRisk = dynamicWindowsInvocationRisk(invocation.executable, invocation.remainder, current.shell)
      if (dynamicRisk) return dynamicRisk
      if (current.shell === "cmd" && cmdWrapperStateRisk(segment, invocation)) {
        return { kind: "windows_dynamic_command", pattern: "opaque cmd state mutation" }
      }
      if (current.shell === "cmd") {
        if (isOpaqueCmdCall(invocation)) {
          return { kind: "windows_dynamic_command", pattern: "opaque cmd call invocation" }
        }
        const scriptResolution = resolvesToCmdScript(invocation.commandToken, resolutionContext)
        if (scriptResolution === "budget_exhausted") return windowsCommandTooComplexRisk()
        if (isCmdScript(invocation.executable) || scriptResolution === "cmd_script") {
          return { kind: "windows_dynamic_command", pattern: "opaque cmd script invocation" }
        }
      }
      if (current.shell === "powershell" && isPowerShellDynamicSegment(segment, invocation.executable)) {
        return { kind: "powershell_dynamic_command", pattern: "dynamic PowerShell process invocation" }
      }
      if (current.shell === "cmd" && (invocation.executable === "start" || invocation.executable === "start.exe")) {
        return { kind: "windows_cmd_start", pattern: "cmd start" }
      }
      if (current.shell === "powershell" && ["start-process", "start", "saps"].includes(invocation.executable)) {
        return { kind: "powershell_start_process", pattern: "PowerShell Start-Process" }
      }

      if (invocation.executable === "cmd" || invocation.executable === "cmd.exe") {
        const body = shellCommandBody(invocation.remainder, /\/(?:c|k)\b/i)
        if (body) enqueue(body, "cmd")
        continue
      }

      if (isPowerShellExecutable(invocation.executable)) {
        const powerShell = powerShellCommand(invocation.remainder)
        if (powerShell.encoded) {
          return { kind: "powershell_encoded_command", pattern: "PowerShell -EncodedCommand" }
        }
        if (powerShell.dynamic) {
          return { kind: "powershell_dynamic_command", pattern: "opaque PowerShell script invocation" }
        }
        if (powerShell.body) enqueue(powerShell.body, "powershell")
      }

      if (current.shell === "cmd") {
        for (const body of cmdWrapperBodies(invocation)) enqueue(body, "cmd")
        applyCmdResolutionMutation(invocation, resolutionContext)
      }
    }
  }
}

function windowsCommandTooComplexRisk(): DetachedDaemonRisk {
  return { kind: "windows_command_too_complex", pattern: "command exceeds the Windows inspection budget" }
}

function dynamicWindowsInvocationRisk(
  executable: string,
  remainder: string,
  shell: WindowsShell,
): DetachedDaemonRisk | undefined {
  const powerShellVariable = /^\$(?:\{[^}]+\}|[\w:]+)$/.exec(executable)?.[0]
  const isPowerShellEnvironmentVariable = powerShellVariable !== undefined && /^\$env:/i.test(powerShellVariable)
  const dynamic =
    executable.startsWith("%") ||
    executable.startsWith("!") ||
    (shell === "cmd" && executable.includes("^")) ||
    (shell === "powershell" &&
      powerShellVariable !== undefined &&
      !isPowerShellValueExpression(remainder) &&
      (!isPowerShellEnvironmentVariable || /^\$env:comspec$/i.test(powerShellVariable)))
  if (!dynamic) return
  return shell === "powershell"
    ? { kind: "powershell_dynamic_command", pattern: "dynamic PowerShell command invocation" }
    : { kind: "windows_dynamic_command", pattern: "dynamic cmd command invocation" }
}

function isPowerShellValueExpression(remainder: string): boolean {
  const operator = remainder.trimStart().split(/\s+/, 1)[0]?.toLowerCase()
  return (
    operator !== undefined &&
    [
      "=",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "??=",
      "-eq",
      "-ne",
      "-gt",
      "-ge",
      "-lt",
      "-le",
      "-like",
      "-notlike",
      "-match",
      "-notmatch",
      "-contains",
      "-notcontains",
      "-in",
      "-notin",
      "-is",
      "-isnot",
      "-as",
      "-and",
      "-or",
      "-xor",
    ].includes(operator)
  )
}

function isCmdScript(executable: string): boolean {
  return executable.endsWith(".bat") || executable.endsWith(".cmd")
}

const cmdBuiltins = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chdir",
  "cls",
  "color",
  "copy",
  "date",
  "del",
  "dir",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "for",
  "ftype",
  "goto",
  "if",
  "md",
  "mkdir",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
])

function createWindowsCommandResolutionContext(resolution: WindowsCommandResolution): WindowsCommandResolutionContext {
  const env = new Map<string, string>()
  for (const [name, value] of Object.entries(resolution.env)) {
    if (value !== undefined) env.set(name.toUpperCase(), value)
  }
  return {
    workdir: resolution.workdir,
    env,
    pathDirectories: windowsPathDirectories(env),
    extensions: windowsPathExtensions(env),
    isFile: resolution.isFile ?? isRegularFile,
    commandCache: new Map(),
    fileCache: new Map(),
    probes: 0,
  }
}

function windowsPathDirectories(env: Map<string, string>): string[] {
  return uniqueWindowsValues(
    (env.get("PATH") ?? "")
      .split(";")
      .map((directory) => expandWindowsEnvVariables(stripOuterQuotes(directory.trim()), env))
      .filter(Boolean),
  )
}

function windowsPathExtensions(env: Map<string, string>): string[] {
  return uniqueWindowsValues(
    (env.get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((extension) => extension.trim())
      .filter(Boolean)
      .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`)),
  )
}

function expandWindowsEnvVariables(value: string, env: Map<string, string>): string {
  let expanded = value
  for (let pass = 0; pass < 8; pass += 1) {
    const next = expanded.replace(/%([^%]+)%/g, (match, name: string) => env.get(name.toUpperCase()) ?? match)
    if (next === expanded) return expanded
    expanded = next
  }
  return expanded
}

function resolvesToCmdScript(commandToken: string, context?: WindowsCommandResolutionContext): CmdScriptResolution {
  if (!context || isBareCmdBuiltin(commandToken)) return "other"

  const executable = commandToken.replaceAll("/", "\\").replace(/[. ]+$/, "")
  const explicitExtension = path.win32.extname(executable).toLowerCase()
  const cacheKey = executable.toLowerCase()
  const cached = context.commandCache.get(cacheKey)
  if (cached) return cached

  const hasDirectory = executable.includes("\\")
  const bases = hasDirectory
    ? [path.win32.resolve(context.workdir, executable)]
    : [
        path.win32.resolve(context.workdir, executable),
        ...context.pathDirectories.map((directory) => path.win32.resolve(context.workdir, directory, executable)),
      ]

  // cmd checks an explicit dotted file first, then searches cwd and PATH using the first PATHEXT match.
  for (const base of bases) {
    const candidates = [
      ...(explicitExtension ? [base] : []),
      ...context.extensions.map((extension) => `${base}${extension}`),
    ]
    for (const candidate of candidates) {
      const exists = probeWindowsCommandCandidate(candidate, context)
      if (exists === "budget_exhausted") {
        context.commandCache.set(cacheKey, "budget_exhausted")
        return "budget_exhausted"
      }
      if (!exists) continue
      const result = isCmdScript(path.win32.extname(candidate).toLowerCase()) ? "cmd_script" : "other"
      context.commandCache.set(cacheKey, result)
      return result
    }
  }
  context.commandCache.set(cacheKey, "other")
  return "other"
}

function probeWindowsCommandCandidate(
  candidate: string,
  context: WindowsCommandResolutionContext,
): boolean | "budget_exhausted" {
  const candidateKey = candidate.toLowerCase()
  const cached = context.fileCache.get(candidateKey)
  if (cached !== undefined) return cached
  if (context.probes >= maxWindowsResolutionProbes) return "budget_exhausted"
  context.probes += 1
  const exists = context.isFile(candidate)
  context.fileCache.set(candidateKey, exists)
  return exists
}

function isOpaqueCmdCall(invocation: WindowsInvocation): boolean {
  if (invocation.executable !== "call") return false
  const target = readWindowsInvocation(invocation.remainder.trim())
  if (!target || target.commandToken.startsWith(":")) return false
  return !isBareCmdBuiltin(target.commandToken)
}

function cmdWrapperStateRisk(segment: string, invocation: WindowsInvocation): boolean {
  if (["popd", "setlocal", "endlocal", "goto"].includes(invocation.executable)) return true
  if (invocation.executable === "call") {
    const target = readWindowsInvocation(invocation.remainder.trim())
    if (target?.commandToken.startsWith(":")) return true
  }
  if (cmdWrapperBodies(invocation).some((body) => containsCmdResolutionMutation(body))) return true
  const grouped = stripOuterCmdGroup(segment.trim())
  return grouped !== segment.trim() && containsCmdResolutionMutation(grouped)
}

function containsCmdResolutionMutation(command: string, depth = 0): boolean {
  if (depth > 8) return true
  const source = stripOuterCmdGroup(command.trim())
  for (const segment of windowsCommandSegments(source, "cmd")) {
    const grouped = stripOuterCmdGroup(segment.trim())
    const invocation = readWindowsInvocation(grouped)
    if (!invocation) continue
    if (["cd", "chdir", "pushd", "popd", "setlocal", "endlocal", "goto"].includes(invocation.executable)) return true
    if (invocation.executable === "set") {
      const assignment = stripOuterQuotes(invocation.remainder.trim()).toUpperCase()
      if (assignment.startsWith("PATH=") || assignment.startsWith("PATHEXT=")) return true
    }
    if (invocation.executable === "call") {
      const target = readWindowsInvocation(invocation.remainder.trim())
      if (target?.commandToken.startsWith(":")) return true
    }
    if (cmdWrapperBodies(invocation).some((body) => containsCmdResolutionMutation(body, depth + 1))) return true
  }
  return false
}

function applyCmdResolutionMutation(invocation: WindowsInvocation, context?: WindowsCommandResolutionContext): void {
  if (!context) return
  if (["cd", "chdir", "pushd"].includes(invocation.executable)) {
    const target = windowsTokens(invocation.remainder)
      .map((token) => stripOuterQuotes(token.value))
      .find((token) => token.toLowerCase() !== "/d")
    if (!target) return
    context.workdir = path.win32.resolve(context.workdir, expandWindowsEnvVariables(target, context.env))
    context.commandCache.clear()
    return
  }
  if (invocation.executable !== "set") return
  const assignment = stripOuterQuotes(invocation.remainder.trim())
  const equals = assignment.indexOf("=")
  if (equals <= 0) return
  const name = assignment.slice(0, equals).trim().toUpperCase()
  const value = expandWindowsEnvVariables(assignment.slice(equals + 1), context.env)
  context.env.set(name, value)
  if (name === "PATH") context.pathDirectories = windowsPathDirectories(context.env)
  if (name === "PATHEXT") context.extensions = windowsPathExtensions(context.env)
  if (name === "PATH" || name === "PATHEXT") context.commandCache.clear()
}

function uniqueWindowsValues(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isBareCmdBuiltin(commandToken: string): boolean {
  return !/[\\/]/.test(commandToken) && cmdBuiltins.has(commandToken.toLowerCase())
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function isPowerShellDynamicSegment(segment: string, executable: string): boolean {
  if (["iex", "invoke-expression"].includes(executable)) return true
  if (executable.endsWith(".ps1") || executable.endsWith(".psm1")) return true
  const unquoted = maskQuotedShellText(segment)
  return (
    /\[(?:system\.)?diagnostics\.process\]\s*::\s*start\s*\(/i.test(unquoted) ||
    /^\s*\$(?:\{[^}]+\}|[\w]+)\s*::\s*start\s*\(/i.test(unquoted)
  )
}

function windowsCommandSegments(command: string, shell: WindowsShell): string[] {
  const segments: string[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      else if ((char === "^" || char === "`") && index + 1 < command.length) index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    const isSeparator =
      char === "&" ||
      char === "|" ||
      char === "\n" ||
      char === "\r" ||
      (shell === "powershell" && (char === ";" || char === "{" || char === "}"))
    if (!isSeparator) continue

    const segment = command.slice(start, index).trim()
    if (segment) segments.push(segment)
    start = index + 1
  }
  const segment = command.slice(start).trim()
  if (segment) segments.push(segment)
  return segments
}

type WindowsInvocation = {
  executable: string
  commandToken: string
  remainder: string
}

function readWindowsInvocation(segment: string): WindowsInvocation | undefined {
  let index = 0
  while (index < segment.length && (/\s/.test(segment[index] ?? "") || segment[index] === "@")) index += 1
  if (index >= segment.length) return

  while (segment[index] === "{" || segment[index] === "}" || segment[index] === "(") {
    let next = index + 1
    while (/\s/.test(segment[next] ?? "")) next += 1
    if (segment[index] === "(" && (segment[next] === "'" || segment[next] === '"')) break
    index = next
  }

  const quote = segment[index] === "'" || segment[index] === '"' ? segment[index] : undefined
  const tokenStart = quote ? ++index : index
  if (quote) {
    while (index < segment.length && segment[index] !== quote) index += 1
  } else {
    while (index < segment.length && !/\s/.test(segment[index] ?? "")) index += 1
  }
  const rawToken = segment.slice(tokenStart, index)
  const commandToken = quote ? rawToken : rawToken.replace(/[)}]+$/, "")
  if (quote && segment[index] === quote) index += 1
  const executable = commandToken.replaceAll("/", "\\").split("\\").at(-1)?.toLowerCase()
  if (!executable) return
  return { executable, commandToken, remainder: segment.slice(index) }
}

function shellCommandBody(remainder: string, shellFlag: RegExp): string | undefined {
  const unquoted = maskQuotedShellText(remainder)
  const match = shellFlag.exec(unquoted)
  if (!match) return
  return stripOuterQuotes(remainder.slice(match.index + match[0].length).trim())
}

function powerShellCommand(remainder: string): { body?: string; encoded?: true; dynamic?: true } {
  for (const token of windowsTokens(remainder)) {
    const value = stripOuterQuotes(token.value)
    const delimiterIndex = value.search(/[:=]/)
    const option = (delimiterIndex === -1 ? value : value.slice(0, delimiterIndex)).toLowerCase()
    if (!option.startsWith("-")) {
      if (/\.(?:ps1|psm1)$/i.test(value)) return { dynamic: true }
      continue
    }

    const name = option.slice(1)
    if (isPowerShellParameterPrefix(name, "encodedcommand")) return { encoded: true }
    if (isPowerShellParameterPrefix(name, "file")) return { dynamic: true }
    if (!isPowerShellParameterPrefix(name, "command") && !isPowerShellParameterPrefix(name, "commandwithargs")) {
      continue
    }

    const inline = delimiterIndex === -1 ? "" : value.slice(delimiterIndex + 1)
    const body = `${inline}${inline ? " " : ""}${remainder.slice(token.end)}`.trim()
    return { body: stripOuterQuotes(body) }
  }
  return {}
}

function isPowerShellParameterPrefix(value: string, parameter: string): boolean {
  return value.length > 0 && parameter.startsWith(value)
}

function isPowerShellExecutable(executable: string): boolean {
  return ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)
}

function cmdWrapperBodies(invocation: WindowsInvocation): string[] {
  if (invocation.executable === "call") {
    const body = invocation.remainder.trim()
    return body ? [body] : []
  }
  if (invocation.executable === "if") return ifCommandBodies(invocation.remainder)
  if (invocation.executable === "for") return forCommandBodies(invocation.remainder)
  return []
}

function ifCommandBodies(remainder: string): string[] {
  const tokens = windowsTokens(remainder)
  let index = 0
  while (["/i", "not"].includes(tokens[index]?.value.toLowerCase() ?? "")) index += 1
  const condition = tokens[index]?.value.toLowerCase()
  if (!condition) return []

  if (["cmdextversion", "defined", "errorlevel", "exist"].includes(condition)) {
    index += 2
  } else if (["==", "equ", "neq", "lss", "leq", "gtr", "geq"].includes(tokens[index + 1]?.value.toLowerCase() ?? "")) {
    index += 3
  } else {
    index += 1
  }

  const bodyStart = tokens[index]?.start
  if (bodyStart === undefined) return []
  return splitCmdIfBranches(remainder.slice(bodyStart).trim())
}

function splitCmdIfBranches(body: string): string[] {
  if (!body.startsWith("(")) return [body]
  const closeIndex = matchingCmdParen(body, 0)
  if (closeIndex === undefined) return [body]

  const thenBody = body.slice(1, closeIndex).trim()
  const remainder = body.slice(closeIndex + 1).trim()
  const elseMatch = /^else\b/i.exec(remainder)
  if (!elseMatch) return thenBody ? [thenBody] : []

  const elseBody = stripOuterCmdGroup(remainder.slice(elseMatch[0].length).trim())
  return [thenBody, elseBody].filter(Boolean)
}

function forCommandBodies(remainder: string): string[] {
  const tokens = windowsTokens(remainder)
  const inIndex = tokens.findIndex((token) => token.value.toLowerCase() === "in")
  const doIndex = tokens.findIndex((token, index) => index > inIndex && token.value.toLowerCase() === "do")
  if (doIndex === -1) return []

  const body = remainder.slice(tokens[doIndex]!.end).trim()
  const bodies = body ? [body] : []
  const isCommandSubstitution = tokens.slice(0, inIndex).some((token) => token.value.toLowerCase() === "/f")
  if (!isCommandSubstitution || inIndex === -1) return bodies

  const useBackQuotes = tokens
    .slice(0, inIndex)
    .flatMap((token) => stripOuterQuotes(token.value).toLowerCase().split(/\s+/))
    .includes("usebackq")
  const expression = remainder.slice(tokens[inIndex]!.end, tokens[doIndex]!.start).trim()
  const inner = stripOuterCmdGroup(expression).trim()
  const delimiter = inner[0]
  const commandDelimiter = useBackQuotes ? "`" : "'"
  if (delimiter === commandDelimiter && inner.at(-1) === delimiter) {
    const command = inner.slice(1, -1).trim()
    if (command) bodies.unshift(command)
  }
  return bodies
}

function stripOuterCmdGroup(value: string): string {
  if (!value.startsWith("(")) return value
  const closeIndex = matchingCmdParen(value, 0)
  if (closeIndex === undefined || value.slice(closeIndex + 1).trim()) return value
  return value.slice(1, closeIndex).trim()
}

function matchingCmdParen(value: string, openIndex: number): number | undefined {
  let depth = 0
  let quote: "'" | '"' | undefined
  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === quote) quote = undefined
      else if (char === "^" && index + 1 < value.length) index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "^") {
      index += 1
      continue
    }
    if (char === "(") depth += 1
    if (char !== ")") continue
    depth -= 1
    if (depth === 0) return index
  }
}

function windowsTokens(value: string): WindowsToken[] {
  const tokens: WindowsToken[] = []
  let index = 0
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index += 1
    if (index >= value.length) break
    const start = index
    let quote: "'" | '"' | undefined
    while (index < value.length) {
      const char = value[index]
      if (quote) {
        if (char === quote) quote = undefined
        else if ((char === "^" || char === "`") && index + 1 < value.length) index += 1
      } else if (char === "'" || char === '"') {
        quote = char
      } else if (/\s/.test(char ?? "")) {
        break
      }
      index += 1
    }
    tokens.push({ value: value.slice(start, index), start, end: index })
  }
  return tokens
}

function stripOuterQuotes(value: string): string {
  const quote = value[0]
  if ((quote === "'" || quote === '"') && value.at(-1) === quote) return value.slice(1, -1)
  return value
}

function hasTopLevelBackgroundOperator(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== "&") continue
    const previous = command[index - 1]
    const next = command[index + 1]
    if (
      previous === "&" ||
      previous === ">" ||
      previous === "|" ||
      next === "&" ||
      next === ">" ||
      /\d/.test(next ?? "")
    ) {
      continue
    }
    return true
  }
  return false
}
