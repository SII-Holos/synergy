const SAFE_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "true"])

const SAFE_GIT_SUBCOMMANDS = new Set([
  "blame",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "status",
  "tag",
])

const UNSAFE_SHELL_TOKENS = [
  "`",
  "$(",
  " >",
  "\t>",
  ">>",
  "1>",
  ">|",
  "<(",
  "<<<",
  "sudo ",
  "rm ",
  "mv ",
  "cp ",
  "mkdir ",
  "touch ",
  "chmod ",
  "chown ",
  "curl ",
  "wget ",
  "bun ",
  "npm ",
  "pnpm ",
  "yarn ",

  // Shell builtins — critical gap (Cursor CVE-2026-22708)
  "export ",
  "eval ",
  "exec ",
  "source ",
  "typeset ",
  "declare ",
  "alias ",
  "unalias ",
  "trap ",
  "set ",
  "shopt ",
  "ulimit ",
  "readonly ",
  "unset ",

  // Shell escape
  ". ",
  "read ",
  "printf ",

  // Redirect operators (missing)
  "&>",
  "|&",
  "<>",
  ">(",
  "<<",

  // Language interpreters (-c/-e inline execution)
  "python3 ",
  "python2 ",
  "ruby ",
  "perl ",
  "node ",
  "php ",

  // Package managers (supply-chain attack surface)
  "pip ",
  "pip3 ",
  "gem ",
  "cargo ",
  "brew ",

  // Network tools (exfiltration)
  "socat ",
  "ssh ",
  "scp ",
  "rsync ",
  "dig ",
  "nslookup ",
  "openssl ",
  "telnet ",
  "ftp ",
  "sftp ",
  "aria2c ",

  // Process & persistence
  "kill ",
  "nohup ",
  "disown",
  "screen ",
  "tmux ",
  "at ",
  "crontab ",
  "launchctl ",
  "xargs ",

  // Filesystem manipulation
  "mkfifo ",
  "mount ",
  "umount ",
  "chattr ",
  "setfacl ",
  "truncate ",
  "fallocate ",
  "ln ",
  "install ",
  "tee ",
]

function stripAllowedRedirects(command: string): string {
  return command
    .replace(/\s+2>\s*\/dev\/null/g, " ")
    .replace(/\s+2>&1/g, " ")
    .replace(/\s+1>&2/g, " ")
}

function shellWords(segment: string): string[] {
  const words = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
  return words.map((word) => word.replace(/^['"]|['"]$/g, ""))
}

function commandName(words: string[]): string | undefined {
  let index = 0
  while (words[index]?.includes("=") && !words[index]?.startsWith("-")) index++
  return words[index]
}

function gitSubcommand(words: string[]): string | undefined {
  for (const word of words.slice(1)) {
    if (!word || word.startsWith("-") || word.includes("=")) continue
    return word
  }
  return undefined
}

function isSafeSimpleCommand(segment: string): boolean {
  const words = shellWords(segment)
  if (words.length === 0) return true

  const name = commandName(words)
  if (!name || name === "cd") return true
  if (name === "git") {
    const subcommand = gitSubcommand(words)
    return !!subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand)
  }
  return SAFE_COMMANDS.has(name)
}

// Patterns for commands that can NEVER be executed regardless of profile.
const FORK_BOMB_RE = /:\(\)\s*\{?\s*:\s*\|[^}]*&\s*}?\s*;:/
const DEVICE_WRITE_RE = /(?:^|[\s;&|])(?:dd|mkfs|fdisk|parted)\s.*\/dev\/(sd|xvd|nvme|hd)/
const RECURSIVE_ROOT_RM_RE = /rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)/

const HARDLINE_PREFIXES = [
  "mkfs ",
  "fdisk ",
  "parted ",
  "lvremove ",
  "pvremove ",
  "vgremove ",
  "shutdown ",
  "reboot ",
  "halt ",
  "poweroff ",
]

const HARDLINE_EXACTS = ["init 0", "init 6", "telinit 0", "telinit 6"]

function checkHardline(command: string): boolean {
  const lower = command.toLowerCase().replace(/\s+/g, " ").trim()

  // Fork bomb
  if (FORK_BOMB_RE.test(command) || command.includes(":() {")) return true

  // Device write with dd / mkfs / fdisk / parted
  if (DEVICE_WRITE_RE.test(lower)) return true

  // Hardline prefixes
  if (HARDLINE_PREFIXES.some((p) => lower.startsWith(p))) return true

  // Hardline exact matches
  if (HARDLINE_EXACTS.some((e) => lower === e)) return true

  // Recursive root / home removal
  if (RECURSIVE_ROOT_RM_RE.test(lower)) {
    if (
      lower.includes("/ ") ||
      lower.includes("/* ") ||
      lower.includes("/\t") ||
      lower.includes("/*\t") ||
      lower.includes(" ~ ") ||
      lower.includes(" $HOME")
    ) {
      return true
    }
  }

  // dd with output to /dev/*
  if (lower.startsWith("dd ") && /of=\/dev\//.test(lower)) return true

  return false
}

export type BashRisk = "shell_read" | "shell" | "shell_destructive" | "shell_hardline"

export namespace ShellSafety {
  export function isReadOnly(command: string): boolean {
    const normalized = stripAllowedRedirects(` ${command} `)
    const lower = normalized.toLowerCase()
    if (UNSAFE_SHELL_TOKENS.some((token) => lower.includes(token))) return false

    const segments = normalized
      .trim()
      .split(/\s*(?:&&|\|\||[;|])\s*/)
      .filter(Boolean)

    if (segments.length === 0) return true
    return segments.every(isSafeSimpleCommand)
  }

  export function capability(command: string): "shell_read" | "shell" {
    return isReadOnly(command) ? "shell_read" : "shell"
  }

  export const isHardline = checkHardline

  export function classifyBashRisk(command: string): BashRisk {
    if (checkHardline(command)) return "shell_hardline"
    if (isReadOnly(command)) return "shell_read"
    return "shell"
  }
}
