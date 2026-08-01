export type DetachedDaemonRisk = {
  kind: "tmux_detached" | "nohup" | "setsid" | "disown" | "daemonize" | "screen_detached" | "shell_background"
  pattern: string
}

const checks: Array<{ kind: DetachedDaemonRisk["kind"]; pattern: string; regex: RegExp }> = [
  {
    kind: "tmux_detached",
    pattern: "tmux new-session -d",
    regex: /\btmux\s+(?:new-session|new)\b(?=[\s\S]*?(?:^|\s)-d(?:\s|$))/,
  },
  {
    kind: "screen_detached",
    pattern: "screen -dm",
    regex: /\bscreen\s+-dm(?:\w|$)/,
  },
  {
    kind: "nohup",
    pattern: "nohup",
    regex: /(?:^|[;&|]\s*)nohup(?:\s|$)/,
  },
  {
    kind: "setsid",
    pattern: "setsid",
    regex: /(?:^|[;&|]\s*)setsid(?:\s|$)/,
  },
  {
    kind: "disown",
    pattern: "disown",
    regex: /(?:^|[;&|]\s*)disown(?:\s|$)/,
  },
  {
    kind: "daemonize",
    pattern: "daemonize",
    regex: /(?:^|[;&|]\s*)daemonize(?:\s|$)/,
  },
  {
    kind: "shell_background",
    pattern: "&",
    regex: /\s&\s*(?:$|[;\n\r)]|\s+\w)/,
  },
]

export function detectDetachedDaemonRisk(command: string): DetachedDaemonRisk | undefined {
  for (const check of checks) {
    if (check.regex.test(command)) return { kind: check.kind, pattern: check.pattern }
  }
}

export function detachedDaemonBlockMessage(risk: DetachedDaemonRisk) {
  return [
    `Blocked detached daemon launch pattern: ${risk.pattern}`,
    "Synergy Link remote execution supports only tracked foreground or background processes.",
    "Use the bash background/yieldSeconds flow and the process tool instead.",
  ].join("\n")
}
