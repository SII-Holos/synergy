export type DetachedDaemonRisk = {
  kind: "tmux_detached" | "nohup" | "setsid" | "disown" | "daemonize" | "screen_detached" | "shell_background"
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

export function detectDetachedDaemonRisk(command: string): DetachedDaemonRisk | undefined {
  const unquoted = maskQuotedShellText(command)
  for (const check of checks) {
    if (check.regex.test(unquoted)) return { kind: check.kind, pattern: check.pattern }
  }
  if (hasTopLevelBackgroundOperator(unquoted)) return { kind: "shell_background", pattern: "&" }
}

export function detachedDaemonBlockMessage(risk: DetachedDaemonRisk) {
  return [
    `Blocked direct detached daemon launch pattern: ${risk.pattern}`,
    "Synergy Link remote execution supports only tracked foreground or background processes.",
    "Use the bash background/yieldSeconds flow and the process tool instead.",
  ].join("\n")
}

function maskQuotedShellText(command: string): string {
  const chars = [...command]
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
