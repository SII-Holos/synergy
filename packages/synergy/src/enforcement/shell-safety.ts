const SAFE_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "true"])

const SAFE_GIT_SUBCOMMANDS = new Set(["branch", "diff", "grep", "log", "ls-files", "rev-parse", "show", "status"])

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
}
