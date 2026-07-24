import { lexCompoundCommands } from "./shell-command"

const SAFE_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "jq", "true"])

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
  ["switch", "shell_branch_mutation"],
  // ── warn ──────────────────────────────────────────────────
  ["am", "shell"],
  ["cherry-pick", "shell"],
  ["commit", "shell"],
  ["merge", "shell"],
  ["pull", "shell"],
  ["push", "shell_remote_publish"],
  ["tag", "shell"],
  ["revert", "shell_destructive"],
  ["rm", "shell_destructive"],
  // ── destructive ───────────────────────────────────────────
  ["filter-branch", "shell_destructive"],
  ["update-ref", "shell_destructive"],
  // ── critical (mapped to shell_destructive) ────────────────
  ["filter-repo", "shell_destructive"],
])

export const PROTECTED_PUSH_TARGETS = new Set(["main", "master", "dev", "develop", "trunk"])

function pushTargetBranchName(target: string): string | null {
  if (target.startsWith("refs/heads/")) return target.slice("refs/heads/".length) || null
  if (target.startsWith("refs/")) return null
  return target || null
}

function analyzePushTargets(
  words: string[],
  subIndex: number,
): { destructive: boolean; protected: boolean; explicitPublish: boolean } {
  const positionals = words.slice(subIndex + 1).filter((word) => word && !word.startsWith("-") && !word.includes("="))
  // Bare push or push with only remote (no refspec) — equivalent to
  // explicit feature-branch push via push.default (typically "simple").
  if (positionals.length <= 1) return { destructive: false, protected: false, explicitPublish: true }
  return positionals.slice(1).reduce<{ destructive: boolean; protected: boolean; explicitPublish: boolean }>(
    (result, refspec) => {
      const force = refspec.startsWith("+")
      const target = refspec.replace(/^\+/, "").split(":").pop() ?? refspec
      const deletesRef = target.length === 0 || refspec.startsWith(":")
      const branchName = pushTargetBranchName(target)
      const protectedTarget = branchName !== null && PROTECTED_PUSH_TARGETS.has(branchName)
      const publishableBranch = !force && !deletesRef && branchName !== null && !protectedTarget
      return {
        destructive: result.destructive || force || deletesRef,
        protected: result.protected || protectedTarget,
        explicitPublish: result.explicitPublish || publishableBranch,
      }
    },
    { destructive: false, protected: false, explicitPublish: false },
  )
}

function isGitRepoSelectorAssignment(word: string | undefined): boolean {
  return (
    word?.startsWith("GIT_DIR=") || word?.startsWith("GIT_WORK_TREE=") || word?.startsWith("GIT_NAMESPACE=") || false
  )
}

function isAttachedGitRepoSelector(word: string | undefined): boolean {
  return (
    word?.startsWith("-C") ||
    word?.startsWith("-c") ||
    word?.startsWith("--git-dir=") ||
    word?.startsWith("--work-tree=") ||
    word?.startsWith("--namespace=") ||
    word?.startsWith("--exec-path=") ||
    false
  )
}

function expandEnvSplitString(words: string[], idx: number): string[] | null {
  if (words[idx] !== "env") return null

  const splitIndex = words.findIndex(
    (word, wordIndex) =>
      wordIndex > idx &&
      (word === "-S" || word === "--split-string" || word.startsWith("-S") || word.startsWith("--split-string=")),
  )
  if (splitIndex === -1) return null

  const splitWord = words[splitIndex]
  let payload: string | undefined
  let afterPayloadIndex = splitIndex + 1
  if (splitWord === "-S" || splitWord === "--split-string") {
    payload = words[splitIndex + 1]
    afterPayloadIndex = splitIndex + 2
  } else if (splitWord.startsWith("-S")) {
    payload = splitWord.slice(2)
  } else if (splitWord.startsWith("--split-string=")) {
    payload = splitWord.slice("--split-string=".length)
  }

  if (!payload) return null
  return [...words.slice(0, idx), ...shellWords(payload), ...words.slice(afterPayloadIndex)]
}

function skipEnvWrapper(
  words: string[],
  idx: number,
): { idx: number; hasEnvWrapper: boolean; hasRepoSelector: boolean } {
  if (words[idx] !== "env") return { idx, hasEnvWrapper: false, hasRepoSelector: false }

  let hasRepoSelector = false
  idx++
  while (idx < words.length) {
    const word = words[idx]
    if (!word) break
    if (word === "--") {
      idx++
      break
    }
    if (word.includes("=") && !word.startsWith("-")) {
      if (isGitRepoSelectorAssignment(word)) hasRepoSelector = true
      idx++
      continue
    }
    if (word === "-u" || word === "--unset" || word === "-C" || word === "--chdir") {
      idx += 2
      continue
    }
    if (word.startsWith("--unset=") || word.startsWith("--chdir=") || word.startsWith("-u") || word.startsWith("-C")) {
      idx++
      continue
    }
    if (word.startsWith("-")) {
      idx++
      continue
    }
    break
  }

  return { idx, hasEnvWrapper: true, hasRepoSelector }
}

/** Flag-aware git subcommand classification.
 *  Extracts subcommand + flags from tokenized words and returns a BashRisk
 *  for dangerous flag combinations, or falls through to GIT_TAXONOMY. */
function classifyGitCommand(words: string[]): BashRisk | null {
  const expandedEnv = expandEnvSplitString(words, 0)
  if (expandedEnv) return classifyGitCommand(expandedEnv)

  let idx = 0
  while (words[idx] === "command") {
    idx++
    if (words[idx] === "--") idx++
  }

  const expandedWrappedEnv = expandEnvSplitString(words, idx)
  if (expandedWrappedEnv) return classifyGitCommand(expandedWrappedEnv)

  // Skip env var assignments like FOO=bar git ...
  let hasRepoSelector = false
  while (idx < words.length && words[idx]?.includes("=") && !words[idx]?.startsWith("-")) {
    const assignment = words[idx]
    if (isGitRepoSelectorAssignment(assignment)) {
      hasRepoSelector = true
    }
    idx++
  }

  const envWrapper = skipEnvWrapper(words, idx)
  idx = envWrapper.idx
  hasRepoSelector = hasRepoSelector || envWrapper.hasRepoSelector

  if (words[idx] !== "git") return null

  let subIndex = idx + 1
  while (subIndex < words.length && words[subIndex]?.startsWith("-")) {
    const word = words[subIndex]
    if (
      word === "-C" ||
      word === "-c" ||
      word === "--git-dir" ||
      word === "--work-tree" ||
      word === "--namespace" ||
      word === "--exec-path"
    ) {
      hasRepoSelector = true
      subIndex += 2
      continue
    }
    if (isAttachedGitRepoSelector(word)) {
      hasRepoSelector = true
    }
    subIndex++
  }

  const sub = words[subIndex]
  if (!sub) return null

  const flags = words.slice(subIndex + 1).filter((w) => w.startsWith("-"))
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
    return "shell_branch_mutation" // switch branch
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
    if (hasExact("--amend") || flags.some((f) => f.startsWith("--amend"))) return "shell_destructive"
    return "shell" // safe_write
  }

  // ── pull ──────────────────────────────────────────────────
  if (sub === "pull") {
    if (flags.some((f) => f.startsWith("--rebase") || f === "-r")) return "shell_destructive"
    return "shell" // plain pull → warn
  }

  // ── push ───────────────────────────────────────────────────
  if (sub === "push") {
    const hasForce =
      hasExact("--force") ||
      hasExact("-f") ||
      hasExact("--mirror") ||
      flags.some((f) => f.startsWith("--force-with-lease"))
    const hasDelete = hasExact("--delete") || hasExact("-d")
    const targetRisk = analyzePushTargets(words, subIndex)
    if (hasForce || hasDelete || targetRisk.destructive) return "shell_destructive"
    if (
      hasRepoSelector ||
      hasExact("--all") ||
      hasExact("--tags") ||
      targetRisk.protected ||
      !targetRisk.explicitPublish
    )
      return "shell_remote_write"
    // Bare push (no refspec, explicitPublish: true from analyzePushTargets) or
    // explicit non-protected feature-branch push — safe for automation.
    return "shell_remote_publish"
  }

  // ── reset ──────────────────────────────────────────────────
  if (sub === "reset") {
    return "shell_destructive" // all forms → destructive
  }

  // ── restore ────────────────────────────────────────────────
  if (sub === "restore") {
    const shortChars = flags.filter((f) => f.startsWith("-") && !f.startsWith("--")).join("")
    const hasStaged = flags.some((f) => f.startsWith("--staged")) || shortChars.includes("S")
    const hasWorktree = flags.some((f) => f.startsWith("--worktree")) || shortChars.includes("W")
    const hasSource = flags.some((f) => f.startsWith("--source")) || shortChars.includes("s")
    if (hasStaged && !hasWorktree && !hasSource) return "shell" // safe local stage reversion
    return "shell_destructive" // worktree overwrite → destructive
  }

  // ── stash ──────────────────────────────────────────────────
  if (sub === "stash") {
    const subsub = words.find((w, i) => i > subIndex && !w.startsWith("-"))
    if (subsub === "clear") return "shell_destructive"
    if (subsub === "drop") return "shell_destructive"
    if (subsub === "pop") return "shell_destructive"
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
    const subsub = words.find((w, i) => i > subIndex && !w.startsWith("-"))
    if (subsub === "delete") return "shell_destructive"
    if (subsub === "expire") return "shell_destructive"
    return "shell_read" // show (default) → read_only
  }

  // ── remote ─────────────────────────────────────────────────
  if (sub === "remote") {
    const subsub = words.find((w, i) => i > subIndex && !w.startsWith("-"))
    if (subsub === "add" || subsub === "set-url") return "shell"
    if (subsub === "remove") return "shell" // warn
    return "shell_read" // show / -v → read_only
  }

  // ── tag ────────────────────────────────────────────────────
  if (sub === "tag") {
    if (hasExact("-d") || hasExact("--delete")) return "shell"
    if (hasExact("-l") || hasExact("--list")) return "shell_read"
    const tagArg = words.find((w, i) => i > subIndex && !w.startsWith("-"))
    if (tagArg && tagArg !== "tag") return "shell"
    return "shell_read"
  }

  // ── worktree ───────────────────────────────────────────────
  if (sub === "worktree") {
    const subsub = words.find((w, i) => i > subIndex && !w.startsWith("-"))
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
    const subsub = words.find((w, i) => i > subIndex && !w.startsWith("-"))
    if (subsub === "run") return "shell_destructive"
    return "shell_read"
  }

  // ── fall-through to taxonomy map ───────────────────────────
  return GIT_TAXONOMY.get(sub) ?? null
}

/** Classify GitHub CLI (gh) commands into BashRisk categories.
 *  gh pr view/list/status/checks/diff → shell_read
 *  gh pr create → shell_remote_publish
 *  gh pr edit/ready/comment/review → shell_remote_write
 *  gh issue view/list/status → shell_read
 *  gh issue create/edit/comment/close/reopen → shell_remote_write */
function classifyGitHubCommand(words: string[]): BashRisk | null {
  let idx = 0
  while (idx < words.length && words[idx]?.includes("=") && !words[idx]?.startsWith("-")) idx++
  if (words[idx] !== "gh") return null

  const sub = words[idx + 1]
  if (!sub) return null

  // ── gh pr ──────────────────────────────────────────────────
  if (sub === "pr") {
    const subsub = words[idx + 2]
    // Read-only PR operations
    if (subsub === "view" || subsub === "list" || subsub === "status" || subsub === "checks" || subsub === "diff") {
      return "shell_read"
    }
    // PR creation is the normal end of an autonomous worktree-to-PR workflow.
    if (subsub === "create") {
      return "shell_remote_publish"
    }
    // PR communication commands (comment, review) are non-destructive and part of the development workflow.
    if (subsub === "comment" || subsub === "review") {
      return "shell_remote_publish"
    }
    // PR metadata edits and status transitions remain generic remote writes.
    if (subsub === "edit" || subsub === "ready") {
      return "shell_remote_write"
    }
    // PR merge/close/reopen terminate or reopen review state and are destructive for automation.
    if (subsub === "merge" || subsub === "close" || subsub === "reopen") {
      return "shell_destructive"
    }
    // Default: gh pr <unknown> → shell_remote_write
    return "shell_remote_write"
  }

  // ── gh issue ───────────────────────────────────────────────
  if (sub === "issue") {
    const subsub = words[idx + 2]
    if (subsub === "view" || subsub === "list" || subsub === "status") {
      return "shell_read"
    }
    // Issue creation and comments are non-destructive communication.
    if (subsub === "create" || subsub === "comment") {
      return "shell_remote_publish"
    }
    // Issue metadata edits and status transitions remain remote writes.
    if (subsub === "edit" || subsub === "close" || subsub === "reopen") {
      return "shell_remote_write"
    }
    return "shell_remote_write"
  }

  // ── gh repo ────────────────────────────────────────────────
  if (sub === "repo") {
    const subsub = words[idx + 2]
    if (subsub === "view" || subsub === "list" || subsub === "browse") {
      return "shell_read"
    }
    return "shell_remote_write"
  }

  // ── gh release ─────────────────────────────────────────────
  if (sub === "release") {
    const subsub = words[idx + 2]
    if (subsub === "view" || subsub === "list" || subsub === "download") {
      return "shell_read"
    }
    return "shell_remote_write"
  }

  // ── gh auth ────────────────────────────────────────────────
  if (sub === "auth") {
    const subsub = words[idx + 2]
    if (subsub === "status" || subsub === "token") {
      return "shell_read"
    }
    return "shell_remote_write" // auth login, logout, etc
  }

  // ── gh workflow ────────────────────────────────────────────
  if (sub === "workflow") {
    const subsub = words[idx + 2]
    if (subsub === "view" || subsub === "list" || subsub === "run") {
      if (subsub === "run" && words[idx + 3] === "list") return "shell_read"
      if (subsub === "run" && words[idx + 3] === "view") return "shell_read"
      return "shell_read"
    }
    return "shell_remote_write" // workflow enable/disable/run/dispatch
  }

  // ── gh run ─────────────────────────────────────────────────
  if (sub === "run") {
    const subsub = words[idx + 2]
    if (subsub === "list" || subsub === "view" || subsub === "watch") {
      return "shell_read"
    }
    if (subsub === "rerun" || subsub === "cancel") {
      return "shell_remote_write"
    }
    return "shell_read" // default: read
  }

  // ── gh gist ────────────────────────────────────────────────
  if (sub === "gist") {
    const subsub = words[idx + 2]
    if (subsub === "view" || subsub === "list" || subsub === "clone") {
      return "shell_read"
    }
    return "shell_remote_write"
  }

  // ── gh search ──────────────────────────────────────────────
  if (sub === "search") {
    return "shell_read"
  }

  // ── gh alias ──────────────────────────────────────────────────
  if (sub === "alias") {
    const subsub = words[idx + 2]
    if (subsub === "list") return "shell_read"
    return "shell" // alias set/delete → local write
  }

  // ── gh completion / gh help / gh version ───────────────────
  if (sub === "completion" || sub === "help" || sub === "version" || sub === "codespace") {
    const codespaceSub = words[idx + 2]
    if (sub === "codespace" && codespaceSub) {
      if (codespaceSub === "list" || codespaceSub === "logs" || codespaceSub === "view" || codespaceSub === "ports") {
        return "shell_read"
      }
      return "shell_remote_write"
    }
    return "shell_read"
  }

  // Default: unknown gh command → shell_remote_write
  return "shell_remote_write"
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
  " at ",
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

function isSafeSimpleCommand(segment: string): boolean {
  const words = shellWords(segment)
  if (words.length === 0) return true
  const name = commandName(words)
  if (!name || name === "cd") return true
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
  {
    pattern: /\b(?:bash|sh|zsh|dash)\s+-c\s+(['"])[^'"]*\bgit\s+(?:[^'"]*\s)?push\b[^'"]*\1/,
    reason: "shell wrapper around git push",
  },
  {
    pattern:
      /\b(?:bash|sh|zsh|dash)\s+-c\s+(['"])[^'"]*\bgit\s+(?:[^'"]*\s)?(?:revert|rm|reset|rebase|clean)\b[^'"]*\1/,
    reason: "shell wrapper around destructive git command",
  },
  {
    pattern:
      /\b(?:python3?|python2|node|ruby|perl)\s+-(?:c|e)\b.*(?:subprocess\.|child_process|system\s*\(|exec\s*\(|spawn\s*\(|`)[\s\S]*\bgit\b[\s\S]*(?:push|revert|\brm\b|reset|rebase|clean|restore|stash[\s\S]*(?:pop|drop|clear)|commit[\s\S]*--amend|pull[\s\S]*(?:--rebase|-r))\b/,
    reason: "interpreter subprocess around destructive git command",
  },
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

export type BashRisk =
  | "shell_read"
  | "shell"
  | "shell_branch_mutation"
  | "shell_remote_publish"
  | "shell_remote_write"
  | "shell_destructive"
  | "shell_hardline"
export namespace ShellSafety {
  export function isReadOnly(command: string): boolean {
    const padded = " " + normalizeCommand(command).toLowerCase() + " "
    const normalized = stripAllowedRedirects(padded)
    if (UNSAFE_SHELL_TOKENS.some((token) => normalized.includes(token))) return false

    const segments = lexCompoundCommands(normalized.trim()).segments

    if (segments.length === 0) return true
    return segments.every(isSafeSimpleCommand)
  }

  export function capability(command: string): "shell_read" | "shell" {
    return isReadOnly(command) ? "shell_read" : "shell"
  }

  export const isHardline = checkHardline
  /** Returns true when the command is a bare git push (no refspec, no repo selector, no flags).
   *  Bare push uses push.default to determine the destination at runtime — typically it pushes
   *  the current branch to its tracked upstream. This is reclassified at the enforcement gate
   *  when the current git branch is protected. */
  export function isBarePush(command: string): boolean {
    const words = shellWords(normalizeCommand(command))
    let idx = 0
    while (words[idx]?.includes("=") && !words[idx]?.startsWith("-")) idx++
    if (words[idx] !== "git") return false
    idx++
    // Skip git options (-c, -C, etc.) — bare push is only bare if no options
    let hasGitOption = false
    while (idx < words.length && words[idx]?.startsWith("-")) {
      hasGitOption = true
      idx++
      // Skip argument for two-arg options like -C <path>
      if (
        words[idx - 1] === "-C" ||
        words[idx - 1] === "-c" ||
        words[idx - 1] === "--git-dir" ||
        words[idx - 1] === "--work-tree" ||
        words[idx - 1] === "--namespace" ||
        words[idx - 1] === "--exec-path"
      ) {
        idx++
      }
    }
    if (words[idx] !== "push") return false
    if (hasGitOption) return false
    // Check for flags
    const flags = words.slice(idx + 1).filter((w) => w.startsWith("-"))
    if (flags.length > 0) return false
    // Check for positional args (remote, refspec)
    const positionals = words.slice(idx + 1).filter((w) => w && !w.startsWith("-") && !w.includes("="))
    return positionals.length === 0
  }

  // ── compound command recursion ───────────────────────────────────────
  const RISK_ORDER: Record<BashRisk, number> = {
    shell_read: 0,
    shell: 1,
    shell_branch_mutation: 2,
    shell_remote_publish: 3,
    shell_remote_write: 4,
    shell_destructive: 5,
    shell_hardline: 6,
  }

  function maxRisk(a: BashRisk, b: BashRisk): BashRisk {
    return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
  }

  const MAX_COMPOUND_DEPTH = 5
  const CLASSIFICATION_BUDGET_MS = 200

  interface ClassificationState {
    deadline: number
    activeInputs: Set<string>
  }

  function newClassificationState(): ClassificationState {
    return {
      deadline: Date.now() + CLASSIFICATION_BUDGET_MS,
      activeInputs: new Set(),
    }
  }

  function conservativeRisk(): BashRisk {
    return "shell"
  }

  export function classifyCompoundRisk(command: string): BashRisk {
    return classifyRisk(command, newClassificationState(), 0)
  }

  // ── heredoc scanning ─────────────────────────────────────────────────

  const HEREDOC_DATA_TOOLS = new Set(["cat", "tee", "grep", "sed", "awk", "jq", "head", "tail"])

  function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  function scanHeredocBody(command: string, state: ClassificationState, depth: number): BashRisk | null {
    const HEREDOC_RE = /(python3?|python2|ruby|perl|node|bash|sh|zsh|ksh|dash)\s+<<\s*(\w+)\b/gi

    let match: RegExpExecArray | null
    while ((match = HEREDOC_RE.exec(command)) !== null) {
      if (Date.now() > state.deadline) return conservativeRisk()
      const interpreter = match[1].toLowerCase()
      const delim = match[2]

      if (HEREDOC_DATA_TOOLS.has(interpreter)) continue

      const bodyStart = match.index + match[0].length
      const remaining = command.slice(bodyStart)
      const bodyEndRe = new RegExp(`\\n${escapeRegExp(delim)}\\b`)
      const bodyEndMatch = bodyEndRe.exec(remaining)

      if (!bodyEndMatch) continue

      const body = remaining.slice(0, bodyEndMatch.index)
      const bodyRisk = depth >= MAX_COMPOUND_DEPTH ? conservativeRisk() : classifyRisk(body, state, depth + 1)

      if (bodyRisk !== "shell_read") {
        return bodyRisk === "shell_hardline" ? "shell_hardline" : "shell_destructive"
      }
    }
    return null
  }

  export function hasHeredocBody(command: string, _maxCheck?: number): { hasShellPayload: boolean } {
    const risk = scanHeredocBody(command, newClassificationState(), 0)
    return { hasShellPayload: risk !== null }
  }

  function classifyRisk(command: string, state: ClassificationState, depth: number): BashRisk {
    if (Date.now() > state.deadline) return conservativeRisk()

    const normalized = normalizeCommand(command)

    if (checkHardline(normalized)) return "shell_hardline"

    if (hasPipeToShell(normalized)) return "shell_destructive"
    if (hasArgumentInjection(normalized)) return "shell_destructive"
    if (hasDownloadExecuteChain(normalized)) return "shell_destructive"

    if (state.activeInputs.has(normalized)) return conservativeRisk()
    state.activeInputs.add(normalized)

    try {
      const compound = lexCompoundCommands(command)
      if (compound.operators.length > 0) {
        if (
          depth >= MAX_COMPOUND_DEPTH ||
          compound.segments.length <= 1 ||
          compound.segments.some((segment) => normalizeCommand(segment) === normalized)
        ) {
          return conservativeRisk()
        }

        let highest: BashRisk = "shell_read"
        for (const segment of compound.segments) {
          if (Date.now() > state.deadline) return conservativeRisk()
          highest = maxRisk(highest, classifyRisk(segment, state, depth + 1))
          if (highest === "shell_hardline") break
        }
        return highest
      }

      const heredocRisk = scanHeredocBody(command, state, depth)
      if (heredocRisk !== null) return heredocRisk

      const words = shellWords(normalized)
      const gitRisk = classifyGitCommand(words)
      if (gitRisk !== null) return gitRisk

      const ghRisk = classifyGitHubCommand(words)
      if (ghRisk !== null) return ghRisk

      if (isReadOnly(command)) return "shell_read"
      return "shell"
    } finally {
      state.activeInputs.delete(normalized)
    }
  }

  export function classifyBashRisk(command: string): BashRisk {
    return classifyRisk(command, newClassificationState(), 0)
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
  // ── download-then-execute chain detection ─────────────────────────────
  const DOWNLOAD_EXEC_CHAINS: RegExp[] = [
    // Download + chmod + execute (3-step chain with &&)
    /\b(?:curl|wget)\b[^;|]+(?:&&|[;&])[^;|&]*\bchmod\b[^;|]*\+x[^;|]*(?:&&|[;&])/,
    // Download to file + interpreter that file
    /\b(?:curl|wget)\b[^;|]+(?:-o\s+\S+|>\s*\S+)[^;|]*(?:&&|[;&])\s*(?:bash|sh|zsh|dash|python3|python|node|ruby|perl)\s+\S+/,
    // Download to file + source that file
    /\b(?:curl|wget)\b[^;|]+(?:-o\s+\S+|>\s*\S+)[^;|]*(?:&&|[;&])\s*(?:source|\.)\s+\S+/,
  ]

  export function hasDownloadExecuteChain(command: string): boolean {
    return DOWNLOAD_EXEC_CHAINS.some((p) => p.test(command))
  }
}
