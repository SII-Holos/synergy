import process from "node:process"

export type DetachedDaemonRisk = {
  kind:
    | "tmux_detached"
    | "nohup"
    | "setsid"
    | "disown"
    | "daemonize"
    | "screen_detached"
    | "shell_background"
    | "windows_cmd_start"
    | "windows_dynamic_command"
    | "windows_command_too_complex"
    | "powershell_start_process"
    | "powershell_encoded_command"
    | "powershell_dynamic_command"
  pattern: string
}

const commandBoundary = String.raw`(?:^|(?:&&|\|\||[;|\n\r(])\s*)`
const checks: Array<{ kind: DetachedDaemonRisk["kind"]; pattern: string; regex: RegExp }> = [
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
  {
    kind: "nohup",
    pattern: "nohup",
    regex: new RegExp(`${commandBoundary}nohup(?:\\s|$)`),
  },
  {
    kind: "setsid",
    pattern: "setsid",
    regex: new RegExp(`${commandBoundary}setsid(?:\\s|$)`),
  },
  {
    kind: "disown",
    pattern: "disown",
    regex: new RegExp(`${commandBoundary}disown(?:\\s|$)`),
  },
  {
    kind: "daemonize",
    pattern: "daemonize",
    regex: new RegExp(`${commandBoundary}daemonize(?:\\s|$)`),
  },
]

export function detectDetachedDaemonRisk(command: string, platform = process.platform): DetachedDaemonRisk | undefined {
  if (platform === "win32" && command.length > maxWindowsCommandChars) return windowsCommandTooComplexRisk()
  const unquoted = maskQuotedShellText(command)
  for (const check of checks) {
    if (check.regex.test(unquoted)) return { kind: check.kind, pattern: check.pattern }
  }
  if (platform === "win32") {
    const windowsRisk = detectWindowsDetachedDaemonRisk(command)
    if (windowsRisk) return windowsRisk
  }
  if (hasTopLevelBackgroundOperator(unquoted)) return { kind: "shell_background", pattern: "&" }
}

export function detachedDaemonBlockMessage(risk: DetachedDaemonRisk) {
  if (risk.kind === "windows_command_too_complex") {
    return [
      `Blocked Windows command before spawn: ${risk.pattern}`,
      "Windows Synergy Link inspects at most 16 KiB per command, 64 nested shell bodies, and 128 KiB cumulatively.",
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

function detectWindowsDetachedDaemonRisk(command: string): DetachedDaemonRisk | undefined {
  const pending: WindowsWorkItem[] = [{ command, shell: "cmd", depth: 0 }]
  const seen = new Set<string>()
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
      if (current.shell === "cmd" && isCmdScript(invocation.executable)) {
        return { kind: "windows_dynamic_command", pattern: "opaque cmd script invocation" }
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

function readWindowsInvocation(segment: string): { executable: string; remainder: string } | undefined {
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
  const token = quote ? rawToken : rawToken.replace(/[)}]+$/, "")
  if (quote && segment[index] === quote) index += 1
  const executable = token.replaceAll("/", "\\").split("\\").at(-1)?.toLowerCase()
  if (!executable) return
  return { executable, remainder: segment.slice(index) }
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

function cmdWrapperBodies(invocation: { executable: string; remainder: string }): string[] {
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
