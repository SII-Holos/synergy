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
const GIT_TAXONOMY: Map<string, BashRisk> = new Map([
  // ── read_only ──────────────────────────────────────────────
  ["blame", "shell_read"],
  ["bisect", "shell_read"],
  ["describe", "shell_read"],
  ["diff", "shell_read"],
  ["fetch", "shell_read"],
  ["fsck", "shell_read"],
  ["grep", "shell_read"],
  ["log", "shell_read"],
  ["ls-files", "shell_read"],
  ["ls-tree", "shell_read"],
  ["name-rev", "shell_read"],
  ["rev-list", "shell_read"],
  ["rev-parse", "shell_read"],
  ["shortlog", "shell_read"],
  ["show", "shell_read"],
  ["status", "shell_read"],
  // ── safe_write ────────────────────────────────────────────
  ["add", "shell"],
  ["clone", "shell"],
  ["config", "shell"],
  ["init", "shell"],
  ["mv", "shell"],
  ["restore", "shell"],
  ["switch", "shell"],
  // ── warn ──────────────────────────────────────────────────
  ["am", "shell"],
  ["cherry-pick", "shell"],
  ["commit", "shell"],
  ["merge", "shell"],
  ["pull", "shell"],
  ["push", "shell"],
  ["revert", "shell"],
  ["rm", "shell"],
  // ── destructive ───────────────────────────────────────────
  ["filter-branch", "shell_destructive"],
  ["update-ref", "shell_destructive"],
  // ── critical (mapped to shell_destructive) ────────────────
  ["filter-repo", "shell_destructive"],
])

/** Flag-aware git subcommand classification.
 *  Extracts subcommand + flags from tokenized words and returns a BashRisk
 *  for dangerous flag combinations, or falls through to GIT_TAXONOMY. */
function classifyGitCommand(words: string[]): BashRisk | null {
  // Skip env var assignments like FOO=bar git ...
  let idx = 0
  while (idx < words.length && words[idx]?.includes("=") && !words[idx]?.startsWith("-")) idx++
  if (words[idx] !== "git") return null

  const sub = words[idx + 1]
  if (!sub) return null

  const flags = words.filter((w) => w.startsWith("-"))
  const hasExact = (f: string) => flags.some((fl) => fl === f)

  // ── branch ─────────────────────────────────────────────────
  if (sub === "branch") {
    if (hasExact("-D")) return "shell_destructive"
    if (hasExact("-d")) return "shell"
    return "shell" // create / list → safe_write
  }

  // ── checkout ───────────────────────────────────────────────
  if (sub === "checkout") {
    if (words.includes("--")) return "shell_destructive" // checkout -- <path>
    if (hasExact("-b") || hasExact("-B")) return "shell" // create branch
    return "shell" // switch branch → warn
  }

  // ── clean ──────────────────────────────────────────────────
  if (sub === "clean") {
    if (hasExact("-n") || flags.some((f) => f.startsWith("--dry-run"))) return "shell_read"
    const shortChars = flags.filter((f) => f.startsWith("-") && !f.startsWith("--")).join("")
    if (shortChars.includes("x") && shortChars.includes("f") && shortChars.includes("d")) return "shell_destructive"
    if (shortChars.includes("f") && shortChars.includes("d")) return "shell_destructive"
    return null // unrecognized clean flags — fall through to isReadOnly
  }

  // ── commit ─────────────────────────────────────────────────
  if (sub === "commit") {
    if (hasExact("--amend") || flags.some((f) => f.startsWith("--amend"))) return "shell" // warn
    return "shell" // safe_write
  }

  // ── push ───────────────────────────────────────────────────
  if (sub === "push") {
    if (hasExact("--mirror")) return "shell_destructive" // critical
    if (hasExact("--force") || hasExact("-f")) return "shell_destructive"
    if (hasExact("--force-with-lease")) return "shell_destructive"
    if (hasExact("--delete") || hasExact("-d")) return "shell_destructive"
    return "shell" // normal push → warn
  }

  // ── reset ──────────────────────────────────────────────────
  if (sub === "reset") {
    if (hasExact("--hard")) return "shell_destructive"
    return "shell" // --soft / --mixed / default → warn
  }

  // ── stash ──────────────────────────────────────────────────
  if (sub === "stash") {
    const subsub = words.find((w, i) => i > idx + 1 && !w.startsWith("-"))
    if (subsub === "clear") return "shell_destructive"
    if (subsub === "drop") return "shell" // warn
    if (subsub === "pop") return "shell" // warn
    if (subsub === "apply" || subsub === "push" || subsub === "save" || subsub === "branch") return "shell" // safe_write
    if (subsub === "list" || subsub === "show") return "shell_read"
    return "shell" // stash without subcommand → safe_write
  }

  // ── rebase ─────────────────────────────────────────────────
  if (sub === "rebase") {
    if (hasExact("--abort")) return "shell"
    if (hasExact("--continue")) return "shell"
    if (hasExact("-i") || hasExact("--interactive")) return "shell_destructive"
    return "shell_destructive" // rebase without abort/continue → destructive
  }

  // ── reflog ─────────────────────────────────────────────────
  if (sub === "reflog") {
    const subsub = words.find((w, i) => i > idx + 1 && !w.startsWith("-"))
    if (subsub === "delete") return "shell_destructive"
    if (subsub === "expire") return "shell_destructive"
    return "shell_read" // show (default) → read_only
  }

  // ── remote ─────────────────────────────────────────────────
  if (sub === "remote") {
    const subsub = words.find((w, i) => i > idx + 1 && !w.startsWith("-"))
    if (subsub === "add" || subsub === "set-url") return "shell"
    if (subsub === "remove") return "shell" // warn
    return "shell_read" // show / -v → read_only
  }

  // ── tag ────────────────────────────────────────────────────
  if (sub === "tag") {
    if (hasExact("-d") || hasExact("--delete")) return "shell"
    if (hasExact("-l") || hasExact("--list")) return "shell_read"
    const tagArg = words.find((w, i) => i > idx + 1 && !w.startsWith("-"))
    if (tagArg && tagArg !== "tag") return "shell"
    return "shell_read"
  }

  // ── worktree ───────────────────────────────────────────────
  if (sub === "worktree") {
    const subsub = words.find((w, i) => i > idx + 1 && !w.startsWith("-"))
    if (subsub === "remove" && (hasExact("--force") || hasExact("-f"))) return "shell_destructive"
    if (subsub === "remove") return "shell" // warn
    if (subsub === "add") return "shell"
    return "shell_read" // list → read_only
  }

  // ── gc ─────────────────────────────────────────────────────
  if (sub === "gc") {
    const hasPruneNow = flags.some((f) => f.startsWith("--prune=now"))
    if (hasPruneNow && hasExact("--aggressive")) return "shell_destructive" // critical
    return "shell" // safe gc
  }

  // ── bisect sub-subcommand ──────────────────────────────────
  if (sub === "bisect") {
    const subsub = words.find((w, i) => i > idx + 1 && !w.startsWith("-"))
    if (subsub === "run") return "shell_destructive"
    return "shell_read"
  }

  // ── fall-through to taxonomy map ───────────────────────────
  return GIT_TAXONOMY.get(sub) ?? null
}

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

const ARGUMENT_INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bfind\b.*(?:-exec(?:dir)?|-ok|-delete)\b/, reason: "find with command execution or deletion" },
  { pattern: /\b(?:rg|ripgrep)\b.*--pre(?:-glob)?\b/, reason: "ripgrep with preprocessor execution" },
  { pattern: /\bfd\b.*(?:-x\b|--exec(?:-batch)?)\b/, reason: "fd with command execution" },
  { pattern: /\bgo\s+test\b.*-exec\b/, reason: "go test with custom executor" },
  { pattern: /\bgit\s+show\b.*--format=.*--output=/, reason: "git show writing to custom output file" },
  { pattern: /\bgit\s+show\b.*--output=/, reason: "git show writing to custom output file" },
  { pattern: /\bgit\s+grep\b.*--open-files-in-pager/, reason: "git grep with custom pager" },
  { pattern: /\bgit\s+config\b.*(?:--global|--system)/, reason: "git config modifying global/system settings" },
]

function normalizeCommand(command: string): string {
  return command
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "") // strip ANSI
    .replace(/\x00/g, "") // strip null bytes
    .normalize("NFKC") // Unicode normalization
    .replace(/\\(.)/g, "$1") // collapse backslash escapes
    .replace(/""/g, "") // strip empty string literals
    .replace(/[ \t]+/g, " ") // normalize whitespace
    .trim()
}

function checkHardline(command: string): boolean {
  const lower = normalizeCommand(command).toLowerCase()

  if (FORK_BOMB_RE.test(lower) || lower.includes(":() {")) return true
  if (DEVICE_WRITE_RE.test(lower)) return true
  if (HARDLINE_PREFIXES.some((p) => lower.startsWith(p))) return true
  if (HARDLINE_EXACTS.some((e) => lower === e)) return true

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

  if (lower.startsWith("dd ") && /of=\/dev\//.test(lower)) return true

  return false
}

export type BashRisk = "shell_read" | "shell" | "shell_destructive" | "shell_hardline"

export namespace ShellSafety {
  export function isReadOnly(command: string): boolean {
    const padded = " " + normalizeCommand(command).toLowerCase() + " "
    const normalized = stripAllowedRedirects(padded)
    if (UNSAFE_SHELL_TOKENS.some((token) => normalized.includes(token))) return false

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

  // ── compound command recursion ───────────────────────────────────────
  const RISK_ORDER: Record<BashRisk, number> = {
    shell_read: 0,
    shell: 1,
    shell_destructive: 2,
    shell_hardline: 3,
  }

  function maxRisk(a: BashRisk, b: BashRisk): BashRisk {
    return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
  }

  const COMPOUND_SPLIT_RE = /\s*(?:&&|\|\||;(?!;)|(?<![>&])\|(?!&))\s*/

  function hasCompoundOperators(command: string): boolean {
    return /&&|\|\||;|\|/.test(command)
  }

  function splitCompound(command: string): string[] {
    return command
      .split(COMPOUND_SPLIT_RE)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  const MAX_COMPOUND_DEPTH = 5

  export function classifyCompoundRisk(command: string): BashRisk {
    const start = Date.now()
    const visited = new Set<string>()

    function recurse(cmd: string, depth: number): BashRisk {
      if (Date.now() - start > 200) return "shell"
      if (depth >= MAX_COMPOUND_DEPTH) return ShellSafety.classifyBashRisk(cmd)
      if (visited.has(cmd)) return ShellSafety.classifyBashRisk(cmd)
      visited.add(cmd)

      if (ShellSafety.hasPipeToShell(cmd)) return "shell_destructive"
      if (ShellSafety.hasArgumentInjection(cmd)) return "shell_destructive"

      if (!hasCompoundOperators(cmd)) {
        return ShellSafety.classifyBashRisk(cmd)
      }

      const segments = splitCompound(cmd)
      if (segments.length <= 1) {
        return ShellSafety.classifyBashRisk(cmd)
      }

      let highest: BashRisk = "shell_read"
      for (const seg of segments) {
        const risk = recurse(seg, depth + 1)
        highest = maxRisk(highest, risk)
        if (highest === "shell_hardline") break
      }
      return highest
    }

    return recurse(command, 0)
  }

  // ── heredoc scanning ─────────────────────────────────────────────────

  const HEREDOC_DATA_TOOLS = new Set(["cat", "tee", "grep", "sed", "awk", "jq", "head", "tail"])

  function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function scanHeredocBody(command: string): BashRisk | null {
    const HEREDOC_RE = /(python3?|python2|ruby|perl|node|bash|sh|zsh|ksh|dash)\s+<<\s*(\w+)\b/gi

    let match: RegExpExecArray | null
    while ((match = HEREDOC_RE.exec(command)) !== null) {
      const interpreter = match[1].toLowerCase()
      const delim = match[2]

      if (HEREDOC_DATA_TOOLS.has(interpreter)) continue

      const bodyStart = match.index + match[0].length
      const remaining = command.slice(bodyStart)
      const bodyEndRe = new RegExp(`\\n${escapeRegExp(delim)}\\b`)
      const bodyEndMatch = bodyEndRe.exec(remaining)

      if (!bodyEndMatch) continue

      const body = remaining.slice(0, bodyEndMatch.index)
      const normalizedBody = normalizeCommand(body)
      const bodyRisk = ShellSafety.classifyBashRisk(normalizedBody)

      if (bodyRisk !== "shell_read") {
        return bodyRisk === "shell_hardline" ? "shell_hardline" : "shell_destructive"
      }
    }
    return null
  }

  export function hasHeredocBody(command: string, _maxCheck?: number): { hasShellPayload: boolean } {
    const risk = scanHeredocBody(command)
    return { hasShellPayload: risk !== null }
  }

  export function classifyBashRisk(command: string): BashRisk {
    const normalized = normalizeCommand(command)

    if (checkHardline(normalized)) return "shell_hardline"

    if (hasPipeToShell(normalized)) return "shell_destructive"
    if (hasArgumentInjection(normalized)) return "shell_destructive"

    if (hasCompoundOperators(normalized)) {
      return classifyCompoundRisk(normalized)
    }

    const heredocRisk = scanHeredocBody(command)
    if (heredocRisk !== null) return heredocRisk

    const words = shellWords(normalized)
    const gitRisk = classifyGitCommand(words)
    if (gitRisk !== null) return gitRisk

    if (isReadOnly(command)) return "shell_read"
    return "shell"
  }

  const PIPE_TO_SHELL_PATTERNS: RegExp[] = [
    /\|\s*(?:bash|sh|zsh|dash)\s*$/,
    /\|\s*(?:bash|sh|zsh|dash)\s+/,
    /\<\s*\(\s*curl\b/,
    /\b(?:curl|wget)\b[^|;]+\|\s*(?:bash|sh|zsh|dash)/,
    /\b(?:curl|wget)\b[^;]*(?:-o\s+\S+|>\s*\S+)[^;]*;\s*(?:bash|sh|zsh|dash)/,
  ]

  export function hasPipeToShell(command: string): boolean {
    return PIPE_TO_SHELL_PATTERNS.some((p) => p.test(command))
  }

  export function hasArgumentInjection(normalized: string): boolean {
    return ARGUMENT_INJECTION_PATTERNS.some(({ pattern }) => pattern.test(normalized))
  }
}
