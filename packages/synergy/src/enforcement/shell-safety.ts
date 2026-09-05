import {
  extractShellHeredocBodies,
  lexCompoundCommands,
  stripWrappers,
  walkShellChars,
  type ShellHeredocBody,
} from "./shell-command"

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

  // ── gh api ─────────────────────────────────────────────────
  // gh api is an authenticated HTTP client: the default method is GET, but
  // -f/-F/--raw-field/--field/--input auto-switch the request to POST and
  // -X/--method can select any verb. Only statically confirmed GET/HEAD
  // requests are read-only; GraphQL and anything else stay remote writes.
  // Both separated and attached option forms (--method=DELETE, -XDELETE,
  // -Fbody=hi, --input=file.json) are recognized, matching gh's pflag parsing.
  if (sub === "api") {
    const after = words.slice(idx + 2)
    const endpoint = after.find((word) => !word.startsWith("-"))
    const methodIndex = after.findIndex(
      (word) =>
        word === "-X" ||
        word === "--method" ||
        word.startsWith("--method=") ||
        (word.startsWith("-X") && word.length > 2),
    )
    let explicitMethod: string | undefined
    if (methodIndex >= 0) {
      const word = after[methodIndex]!
      if (word === "-X" || word === "--method") {
        explicitMethod = after[methodIndex + 1]?.toUpperCase()
      } else if (word.startsWith("--method=")) {
        explicitMethod = word.slice("--method=".length).toUpperCase()
      } else {
        explicitMethod = word.slice(2).replace(/^=/, "").toUpperCase()
      }
    }
    const hasFields = after.some(
      (word) =>
        word === "-f" ||
        word === "--raw-field" ||
        word === "-F" ||
        word === "--field" ||
        word.startsWith("--field=") ||
        word.startsWith("--raw-field=") ||
        (word.startsWith("-f") && word.length > 2) ||
        (word.startsWith("-F") && word.length > 2),
    )
    const hasInput = after.some((word) => word === "--input" || word.startsWith("--input="))
    const readOnly =
      endpoint !== "graphql" &&
      (explicitMethod === "GET" ||
        explicitMethod === "HEAD" ||
        (explicitMethod === undefined && !hasFields && !hasInput))
    return readOnly ? "shell_read" : "shell_remote_write"
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
  // Null-device sinks are not write targets. Recognize stdout/stderr and
  // combined spellings (`>`, `1>`, `2>`, `&>`, `>>`), optional whitespace
  // after the operator, and a glued closing paren/brace (`2>/dev/null)`).
  return command
    .replace(/\s+[12]?&?>>?\s*\/dev\/null(?=[\s;&|(){}]|$)/g, " ")
    .replace(/\s+2>\s*\/dev\/null/g, " ")
    .replace(/\s+2>&1/g, " ")
    .replace(/\s+1>&2/g, " ")
}

function shellWords(segment: string): string[] {
  const words: string[] = []
  let current = ""
  let started = false
  let quote: "'" | '"' | undefined
  let inBacktick = false
  let substitutionDepth = 0

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]
    if (inBacktick) {
      if (char === "`") {
        inBacktick = false
        current += char
        continue
      }
      if (char === "\\" && index + 1 < segment.length) {
        current += char + segment[index + 1]!
        index++
        continue
      }
      current += char
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      if (char === "\\" && quote === '"' && index + 1 < segment.length) {
        const next = segment[index + 1]
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          current += next
          index++
        } else {
          current += char
        }
        continue
      }
      current += char
      continue
    }
    if (/\s/.test(char) && substitutionDepth === 0) {
      if (started) words.push(current)
      current = ""
      started = false
      continue
    }
    if (char === "\\" && (segment[index + 1] === "(" || segment[index + 1] === ")")) {
      // Escaped grouping characters are literal find predicate operands,
      // not substitution delimiters.
      current += segment[index + 1]!
      index++
      started = true
      continue
    }
    if (char === "`") {
      inBacktick = true
      current += char
      started = true
      continue
    }
    if (char === "$" && segment[index + 1] === "(" && segment[index + 2] !== "(") {
      // Command substitution: keep nested text in one word so an assignment
      // prefix (`files=$(find ...)`) is not mis-split into a dynamic command
      // name. Arithmetic `$((` stays on the plain-character path.
      current += "$("
      index++
      substitutionDepth = 1
      started = true
      continue
    }
    if (char === "$" && (segment[index + 1] === "'" || segment[index + 1] === '"')) {
      quote = segment[++index] as "'" | '"'
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (substitutionDepth > 0) {
      if (char === "(") substitutionDepth++
      else if (char === ")") substitutionDepth--
      current += char
      started = true
      continue
    }
    current += char
    started = true
  }
  if (started) words.push(current)
  return words
}
function separateAttachedInputRedirects(segment: string): string {
  const insertions: number[] = []
  walkShellChars(
    segment,
    (char, index, quote, context) => {
      if (
        quote ||
        context.inBacktick ||
        context.arithmetic ||
        context.commandSubstitutionDepth > 0 ||
        char !== "<" ||
        segment[index + 1] !== "<" ||
        segment[index - 1] === "<"
      ) {
        return
      }
      const previous = segment[index - 1]
      if (!previous || /\s/.test(previous)) return

      let start = index - 1
      while (start >= 0 && !/[\s;&|()<>]/.test(segment[start] ?? "")) start--
      const prefix = segment.slice(start + 1, index)
      if (prefix && !/^\d+$/.test(prefix)) insertions.push(index)
    },
    { comments: true, backticks: true },
  )
  if (insertions.length === 0) return segment

  let result = ""
  let start = 0
  for (const index of insertions) {
    result += `${segment.slice(start, index)} `
    start = index
  }
  return result + segment.slice(start)
}

function simpleCommandParts(segment: string): { name?: string; args: string[] } {
  const words = shellWords(normalizeCommand(separateAttachedInputRedirects(segment)))
  let index = 0
  while (words[index]?.includes("=") && !words[index]?.startsWith("-")) index++
  while (words[index] === "command" || words[index] === "builtin") {
    const prefix = words[index++]
    if (prefix === "command") {
      while (index < words.length) {
        const option = words[index]
        if (option === "--path") {
          index += 2
          continue
        }
        if (option?.startsWith("--path=") || /^-[pPvV]+$/.test(option ?? "")) {
          index++
          continue
        }
        break
      }
    }
    if (words[index] === "--") index++
  }
  return { name: words[index], args: words.slice(index + 1) }
}

function isSafeSimpleCommand(segment: string): boolean {
  const { name, args } = simpleCommandParts(segment)
  if (!name || name === "cd") return true
  if (name === "file") {
    return !args.some((word) => word === "--compile" || /^-[^-]*C/.test(word))
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
  { pattern: /\b(?:rg|ripgrep)\b.*--pre(?:-glob)?\b/, reason: "ripgrep with preprocessor execution" },
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

/**
 * Closed-world read-only utilities permitted after find/fd -exec/-execdir/-x:
 * anything else — interpreters, shells, mutators, network tools, or unknown
 * commands — keeps the command shell_destructive. awk/gawk/sed are excluded
 * because awk can system() and sed -i writes; xargs/tee can execute or write
 * derived content. Unknown tools fail closed (destructive).
 */
const READ_ONLY_EXEC_TOOLS = new Set([
  "cat",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "tr",
  "od",
  "hexdump",
  "xxd",
  "diff",
  "cmp",
  "comm",
  "basename",
  "dirname",
  "readlink",
  "stat",
  "du",
  "ls",
  "file",
  "echo",
  "printf",
  "nl",
  "paste",
  "join",
  "expand",
  "unexpand",
  "fmt",
  "fold",
  "pr",
  "column",
  "seq",
  "cksum",
  "sum",
  "shasum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "md5sum",
  "zcat",
  "bzcat",
  "xzcat",
  "pwd",
  "true",
  "false",
])

const FIND_FD_EXEC_OPTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-x", "-X", "--exec", "--exec-batch"])

/**
 * Scan quote-masked executable text for find/fd command executions whose
 * utility is not in the closed read-only whitelist (-exec/-execdir/-x/-X/
 * --exec/--exec-batch), plus -delete, -ok, and -okdir which are always
 * destructive. Operates on one executable region (substitutions and shell
 * re-parse payloads handled by the caller).
 */
function findFdExecTextUnsafe(executable: string): boolean {
  const compound = lexCompoundCommands(executable)
  const segments = compound.segments.length > 0 ? compound.segments : [executable]
  for (const segment of segments) {
    const words = shellWords(normalizeCommand(segment))
    for (let index = 0; index < words.length; index++) {
      const word = commandBasename(words[index] ?? "")
      if (word !== "find" && word !== "fd") continue
      for (let optionIndex = index + 1; optionIndex < words.length; optionIndex++) {
        const option = words[optionIndex]!
        if (!option.startsWith("-")) continue
        if (option === "-delete") return true
        if (!FIND_FD_EXEC_OPTIONS.has(option)) continue
        if (option === "-ok" || option === "-okdir") return true
        const rawUtility = words[optionIndex + 1]
        if (rawUtility === undefined || rawUtility === "{}") return true
        if (/[$`\\]/.test(rawUtility)) return true
        const utility = commandBasename(rawUtility)
        if (!READ_ONLY_EXEC_TOOLS.has(utility)) return true
      }
    }
  }
  return false
}

/**
 * Recursively inspect every executable region (top level, command and
 * process substitutions, backticks, and shell re-parse payloads) for an
 * unsafe find/fd exec target. Quoted payload text is masked at the top
 * level, so payload-bearing commands are unwrapped and rescanned like sudo
 * classification does. Budget or depth exhaustion fails closed (treated as
 * unsafe).
 */
function hasUnsafeExecTarget(command: string, state: ClassificationState, depth = 0): boolean {
  if (classificationExhausted(state, command) || depth > DIRECTORY_CHANGE_MAX_DEPTH) return true
  if (findFdExecTextUnsafe(executableShellSyntaxText(command))) return true
  const payloads = commandSubstitutionPayloads(command, state)
  if (payloads === undefined) return true
  if (payloads.some((payload) => hasUnsafeExecTarget(payload, state, depth + 1))) return true
  const compound = lexCompoundCommands(command)
  const segments = compound.segments.length > 0 ? compound.segments : [command]
  return segments.some((segment) => execPayloadTargetUnsafe(segment, state, depth))
}

/**
 * Unwrap one compound segment's re-parse payload (shell `-c`, `eval`, `trap`
 * payload, function body, multicall applet, or directory wrapper payload)
 * and rescan it for an unsafe find/fd exec target, mirroring the payload
 * traversal of sudo classification.
 */
function execPayloadTargetUnsafe(segment: string, state: ClassificationState, depth: number): boolean {
  const functionBody = functionDefinitionBody(segment)
  if (functionBody !== undefined) {
    return functionBody ? hasUnsafeExecTarget(functionBody, state, depth + 1) : false
  }
  if (commandLookupOnly(segment)) return false
  const { name, args } = simpleCommandParts(controlCommandSegment(segment))
  if (!name) return false
  if (MULTICALL_COMMANDS.has(name)) {
    const applet = multicallCommandParts(args)
    return applet.name ? hasUnsafeExecTarget([applet.name, ...applet.args].join(" "), state, depth + 1) : false
  }
  if (isShellPayloadCommand(name)) {
    const payload = shellPayload(args)
    return payload ? hasUnsafeExecTarget(payload, state, depth + 1) : false
  }
  if (name === "eval" && args.length > 0) {
    return hasUnsafeExecTarget(args.join(" "), state, depth + 1)
  }
  if (name === "trap") {
    const payload = trapPayload(args)
    return payload ? hasUnsafeExecTarget(payload, state, depth + 1) : false
  }
  if (DIRECTORY_WRAPPER_COMMANDS.has(name)) {
    const wrapped = wrapperCommandParts(name, args)
    return wrapped.name ? hasUnsafeExecTarget([wrapped.name, ...wrapped.args].join(" "), state, depth + 1) : false
  }
  return false
}

const INLINE_STRING_ESCAPE = /^(?:[xX][0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|u\{[0-9a-fA-F]{1,6}\}|[0-7]{1,3})/

function normalizeShellEscapes(command: string): string {
  let result = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? undefined : char
      result += char
      continue
    }
    if (char !== "\\" || index + 1 >= command.length) {
      result += char
      continue
    }
    if (quote === "'") {
      result += char
      continue
    }
    const next = command[index + 1]
    if (quote === '"' && (next === "$" || next === "`" || next === '"' || next === "\\")) {
      result += char + next
      index++
      continue
    }
    if (next === "\\") {
      result += "\\"
      index++
      continue
    }
    if (INLINE_STRING_ESCAPE.test(command.slice(index + 1)) || command.startsWith("N{", index + 1)) {
      result += "\\"
      continue
    }
    result += next
    index++
  }
  return result
}

function normalizeCommand(command: string): string {
  const normalized = command
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x00/g, "")
    .normalize("NFKC")
    .replace(/\\\r?\n/g, "")
  return normalizeShellEscapes(normalized)
    .replace(/""/g, "")
    .replace(/[ \t]+/g, " ")
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

export interface DirectoryChangeAnalysis {
  targets: string[]
  opaque: boolean
}

export interface DirectoryChangeOptions {
  /**
   * When true, a relative cd target that contains a slash (e.g.
   * `cd packages/synergy/src`) is statically resolved against the current
   * working directory instead of treated as CDPATH-dependent opaque — unless
   * the command text itself defines CDPATH (assignment or export), in which
   * case the target stays opaque. Bare names (`cd node_modules`) stay opaque
   * because CDPATH can redirect them even without an in-command definition
   * (the parent environment may still define CDPATH).
   */
  resolveSlashRelativeCd?: boolean
}

/**
 * Detection context threaded through recursive directory-change analysis.
 * Slash-containing relative cd targets are resolvable only when the caller
 * opted in and no enclosing command text defines CDPATH (execution
 * environments built from SANDBOX_ENV_ALLOWLIST never carry a parent CDPATH,
 * so only an in-command definition can redirect them).
 */
interface DirectoryChangeContext {
  options: DirectoryChangeOptions
  /** True when this scope or an enclosing scope defines/mutates CDPATH. */
  cdpathDefined: boolean
}

/**
 * Whether a cd/pushd positional target may be statically resolved given the
 * directory-change context. Bare names stay opaque (CDPATH can redirect them
 * even without an in-command definition) and dynamic ($ or backtick) targets
 * stay opaque because their resolved value is unknowable statically;
 * dot-prefixed and absolute targets are already resolved by the caller's own
 * branch.
 */
function slashRelativeCdResolvable(target: string | undefined, ctx: DirectoryChangeContext): boolean {
  return Boolean(
    ctx.options.resolveSlashRelativeCd &&
      target &&
      !dynamicDirectoryTarget(target) &&
      !target.startsWith("/") &&
      !target.startsWith("~") &&
      !target.startsWith(".") &&
      target.includes("/") &&
      !ctx.cdpathDefined,
  )
}

/**
 * Detect whether a command text defines or mutates CDPATH, which would make
 * even a slash-containing relative cd target dependent on that search path.
 */
function commandDefinesCdpath(command: string): boolean {
  return /\b(?:export\s+CDPATH|CDPATH=)/.test(unquotedShellText(normalizeCommand(command)))
}

const CLASSIFICATION_BUDGET_MS = 200
const CLASSIFICATION_MAX_INPUT_CHARS = 256 * 1024

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

function classificationExhausted(state: ClassificationState, input?: string): boolean {
  return Date.now() > state.deadline || (input?.length ?? 0) > CLASSIFICATION_MAX_INPUT_CHARS
}

const DIRECTORY_CHANGE_MAX_DEPTH = 4
const SHELL_PAYLOAD_COMMANDS = new Set(["fish", "nu", "rc", "es"])
const SHELL_COMMAND_EXCLUSIONS = new Set(["ssh", "mosh"])
const MULTICALL_COMMANDS = new Set(["busybox", "toybox"])
const INLINE_EVAL_COMMANDS = new Set([
  "node",
  "nodejs",
  "ruby",
  "perl",
  "bun",
  "lua",
  "luajit",
  "groovy",
  "swift",
  "r",
  "rscript",
])
const DIRECTORY_WRAPPER_COMMANDS = new Set([
  "exec",
  "nice",
  "nohup",
  "script",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "watch",
  "xargs",
])
const EXECFAIL_TRANSPARENT_WRAPPERS = new Set([
  "exec",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "time",
  "timeout",
  "watch",
  "xargs",
])
const SHELL_BUILTIN_COMMANDS = new Set([
  ".",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
])

const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
  nice: new Set(["-n", "--adjustment"]),
  sudo: new Set([
    "-U",
    "--other-user",
    "-a",
    "--auth-type",
    "-C",
    "--close-from",
    "-D",
    "--chdir",
    "-r",
    "--role",
    "-t",
    "--type",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-R",
    "--chroot",
    "-T",
    "--command-timeout",
    "-u",
    "--user",
  ]),
  script: new Set(["-c", "--command"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  watch: new Set(["-n", "--interval"]),
  xargs: new Set([
    "-a",
    "--arg-file",
    "-E",
    "--eof",
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-s",
    "--max-chars",
  ]),
}

function mergeDirectoryChangeAnalysis(
  target: DirectoryChangeAnalysis,
  source: DirectoryChangeAnalysis,
): DirectoryChangeAnalysis {
  target.targets.push(...source.targets.filter((path) => !target.targets.includes(path)))
  target.opaque ||= source.opaque
  return target
}

function dynamicDirectoryTarget(target: string | undefined): boolean {
  return !target || target === "-" || target.includes("$") || target.includes("`")
}

function cdpathDependentDirectoryTarget(target: string | undefined): boolean {
  return Boolean(target && !target.startsWith("/") && !target.startsWith("~") && !target.startsWith("."))
}
function hasEscapedAnsiCQuote(command: string): boolean {
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "\\" && quote !== "'") {
      index++
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || (char === "'" && command[index - 1] !== "$")) {
      quote = char
      continue
    }
    if (char !== "$" || command[index + 1] !== "'") continue
    for (index += 2; index < command.length; index++) {
      if (command[index] === "'") break
      if (command[index] === "\\" && index + 1 < command.length) return true
    }
  }
  return false
}

function hasReparsedEscapedAnsiCQuote(command: string): boolean {
  const compound = lexCompoundCommands(command)
  const segments = compound.segments.length > 0 ? compound.segments : [command]
  return segments.some((segment) => {
    if (!hasAnsiCEscapeSyntax(segment)) return false
    const text = unquotedShellText(segment)
    return (
      /(?:^|[^A-Za-z0-9_])(?:[^\s;&|()]+\/)?(?!(?:ssh|mosh)(?:\.exe)?\b)(?:[A-Za-z0-9_.-]*sh|fish|nu|rc|es)(?:\.exe)?\b[^;&|]*\s-[^-]*c\b/.test(
        text,
      ) ||
      /\b(?:eval|trap)\b/.test(text) ||
      /\benv\b[^;&|]*(?:\s-S\b|--split-string)/.test(text)
    )
  })
}

function hasAnsiCEscapeSyntax(command: string): boolean {
  for (let start = command.indexOf("$'"); start !== -1; start = command.indexOf("$'", start + 2)) {
    for (let index = start + 2; index < command.length; index++) {
      if (command[index] === "'") break
      if (command[index] === "\\" && index + 1 < command.length) return true
    }
  }
  return false
}

const FUNCTION_NAME_PATTERN = "[A-Za-z_][A-Za-z0-9_.:-]*"
const FUNCTION_PREFIX_PATTERN = "(?:^|[;&|(){}\\n]|\\b(?:if|then|elif|else|do|while|until)\\b\\s+)"

function functionDefinitionBody(command: string): string | undefined {
  const match = new RegExp(
    `${FUNCTION_PREFIX_PATTERN}\\s*(?:function\\s+${FUNCTION_NAME_PATTERN}(?:\\s*\\(\\s*\\))?|${FUNCTION_NAME_PATTERN}\\s*\\(\\s*\\))\\s*\\{`,
  ).exec(executableShellSyntaxText(command))
  if (!match) return
  return command.slice(match.index + match[0].length).trim()
}

function hasFunctionDefinition(command: string): boolean {
  return functionDefinitionBody(command) !== undefined
}

function commandBasename(name: string): string {
  return (name.split(/[\\/]/).pop() || name).toLowerCase().replace(/\.exe$/, "")
}

function dynamicCommandName(name: string): boolean {
  return name.includes("$") || name.includes("`")
}

function isShellPayloadCommand(name: string): boolean {
  return SHELL_PAYLOAD_COMMANDS.has(name) || (name.endsWith("sh") && !SHELL_COMMAND_EXCLUSIONS.has(name))
}
function isInlineInterpreterCommand(command: string): boolean {
  return (
    /^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(command) ||
    INLINE_EVAL_COMMANDS.has(command) ||
    command === "php" ||
    command === "deno" ||
    command === "bun" ||
    /^(?:awk|gawk|mawk|nawk)$/.test(command)
  )
}

function hasOpaqueCaseDirectorySyntax(command: string): boolean {
  const text = unquotedShellText(command)
  if (!/\bcase\b[\s\S]*\bin\b/.test(text)) return false
  return (
    /\b(?:cd|pushd|popd|eval|trap)\b/.test(text) ||
    /\benv\b[\s\S]*(?:\s-C\b|--chdir|\s-S\b|--split-string)/.test(text) ||
    /\b(?:(?!(?:ssh|mosh)\b)[A-Za-z0-9_.-]*sh|fish|nu|rc|es)\b[\s\S]*\s-[^-]*c\b/.test(text) ||
    /\b(?:busybox|toybox)\b[\s\S]*\b(?:(?!(?:ssh|mosh)\b)[A-Za-z0-9_.-]*sh|fish|nu|rc|es)\b[\s\S]*\s-[^-]*c\b/.test(
      text,
    ) ||
    /\b(?:python|pypy)(?:\d+(?:\.\d+)*)?\b[\s\S]*\s-[^-]*c\b/.test(text) ||
    /\b(?:node|nodejs|ruby|perl|bun|lua|luajit|groovy|swift|r|rscript)\b[\s\S]*(?:\s-[^-]*e\b|\s--eval\b|\s--print\b)/.test(
      text,
    ) ||
    /\bphp\b[\s\S]*(?:\s-[^-]*[rBRE]\b|\s--(?:run|process-begin|process-code|process-end)\b)/.test(text) ||
    /\b(?:pwsh|powershell)(?:\.exe)?\b[\s\S]*\s-(?:c|command|commandwithargs|e|ec|enc|encodedcommand)\b/i.test(text) ||
    /\bdeno\b[\s\S]*\beval\b/.test(text) ||
    /\b(?:awk|gawk|mawk|nawk)\b[\s\S]*\bsystem\s*\(/.test(text)
  )
}

function hasInlineInterpreterPayload(name: string, args: string[]): boolean {
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(name)) {
    return args.some((word) => /^-[^-]*c/.test(word))
  }
  if (INLINE_EVAL_COMMANDS.has(name)) {
    return args.some((word) => {
      const lower = word.toLowerCase()
      return (
        /^-[^-]*e/.test(lower) ||
        lower === "--eval" ||
        lower.startsWith("--eval=") ||
        ((name === "node" || name === "nodejs" || name === "bun") &&
          (lower === "--print" || lower.startsWith("--print=") || /^-[^-]*p/.test(lower)))
      )
    })
  }
  if (name === "php") {
    return args.some(
      (word) =>
        /^-[^-]*[rBRE]/.test(word) ||
        /^--(?:run|process-begin|process-code|process-end)(?:=|$)/.test(word.toLowerCase()),
    )
  }
  if (name === "pwsh" || name === "powershell") {
    return args.some((word) => {
      const option = word.split("=", 1)[0]?.toLowerCase()
      return ["-c", "-command", "-commandwithargs", "-e", "-ec", "-enc", "-encodedcommand"].includes(option)
    })
  }
  if (name === "deno") return args.includes("eval")
  if (/^(?:awk|gawk|mawk|nawk)$/.test(name)) return args.some((word) => /\bsystem\s*\(/.test(word))
  return false
}

function multicallCommandParts(args: string[]): { name?: string; args: string[] } {
  let index = 0
  while (args[index]?.startsWith("-")) {
    if (args[index++] === "--") break
  }
  return { name: args[index], args: args.slice(index + 1) }
}
const REMOTE_COMMAND_VALUE_OPTIONS = new Set([
  "-p",
  "-P",
  "-i",
  "-l",
  "-o",
  "-b",
  "-c",
  "-e",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-w",
  "-m",
  "-E",
  "-S",
  "-I",
])
function remoteCommandPayload(args: string[]): string | undefined {
  let index = 0
  while (index < args.length) {
    const word = args[index]
    if (!word) break
    if (REMOTE_COMMAND_VALUE_OPTIONS.has(word)) {
      index += 2
      continue
    }
    if (word.startsWith("-")) {
      index++
      continue
    }
    break
  }
  const host = args[index]
  if (!host) return
  const remote = args.slice(index + 1)
  if (remote.length === 0) return
  return remote.join(" ")
}

function xargsReplacementToken(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === "-I" || word === "--replace") return args[index + 1] ?? "{}"
    if (word.startsWith("-I") && word.length > 2) return word.slice(2)
    if (word.startsWith("--replace=")) return word.slice("--replace=".length) || "{}"
  }
}

function positionalDirectoryTarget(args: string[]): string | undefined {
  let index = 0
  while (args[index]?.startsWith("-") && args[index] !== "-") {
    if (args[index++] === "--") break
  }
  return args[index]
}

function envDirectoryChange(args: string[]): { target?: string; commandIndex: number; opaque: boolean } {
  let target: string | undefined
  let opaque = false
  let index = 0
  let options = true
  while (index < args.length) {
    const word = args[index]
    if (!word) break
    if (options && word === "--") {
      options = false
      index++
      continue
    }
    if (word.includes("=") && !word.startsWith("-")) {
      index++
      continue
    }
    if (options && (word === "-C" || word === "--chdir")) {
      target = args[index + 1]
      opaque ||= dynamicDirectoryTarget(target)
      index += 2
      continue
    }
    if (options && word.startsWith("--chdir=")) {
      target = word.slice("--chdir=".length)
      opaque ||= dynamicDirectoryTarget(target)
      index++
      continue
    }
    if (options && word.startsWith("-C") && word.length > 2) {
      target = word.slice(2)
      opaque ||= dynamicDirectoryTarget(target)
      index++
      continue
    }
    if (options && (word === "-u" || word === "--unset")) {
      index += 2
      continue
    }
    if (options && word.startsWith("-")) {
      index++
      continue
    }
    break
  }
  return { target, commandIndex: index, opaque }
}

function sudoDirectoryChange(args: string[]): { target?: string; opaque: boolean } {
  let target: string | undefined
  let opaque = false
  let index = 0
  while (index < args.length) {
    const word = args[index]
    if (!word || word === "--") break
    if (word === "-D" || word === "--chdir") {
      target = args[index + 1]
      opaque ||= dynamicDirectoryTarget(target)
      index += 2
      continue
    }
    if (word.startsWith("--chdir=")) {
      target = word.slice("--chdir=".length)
      opaque ||= dynamicDirectoryTarget(target)
      index++
      continue
    }
    if (word.startsWith("-D") && word.length > 2) {
      target = word.slice(2)
      opaque ||= dynamicDirectoryTarget(target)
      index++
      continue
    }
    if (WRAPPER_VALUE_OPTIONS.sudo.has(word)) {
      index += 2
      continue
    }
    if (word.startsWith("-")) {
      index++
      continue
    }
    break
  }
  return { target, opaque }
}

function shellPayload(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === "--command") return args[index + 1]
    if (word?.startsWith("--command=")) return word.slice("--command=".length)
    if (!word || !/^-[^-]/.test(word)) continue
    const commandIndex = word.indexOf("c", 1)
    if (commandIndex === -1) continue
    return word.slice(commandIndex + 1) || args[index + 1]
  }
}

function shellHerestringPayload(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    const match = /^(?:\d*)<<<(.*)$/.exec(word ?? "")
    if (!match) continue
    return match[1] || args[index + 1]
  }
}

function normalizeFileDescriptor(fd: string): string {
  return fd.replace(/^0+(?=\d)/, "")
}

interface ShellRedirect {
  fd: string
  operator: string
  target?: string
  consumesNext: boolean
}

function shellRedirect(word: string, next?: string): ShellRedirect | undefined {
  const match = /^(\d*)(&>>|&>|<<<|<<-|<<|<&|<>|<|>>|>\||>&|>)(.*)$/.exec(word)
  if (!match || ((match[2] === "<" || match[2] === ">") && match[3].startsWith("("))) return
  const input = match[2].startsWith("<")
  const consumesNext = match[3] === ""
  return {
    fd: normalizeFileDescriptor(match[1] || (input ? "0" : "1")),
    operator: match[2],
    target: consumesNext ? next : match[3],
    consumesNext,
  }
}

function shellRedirects(args: string[]): ShellRedirect[] {
  const redirects: ShellRedirect[] = []
  for (let index = 0; index < args.length; index++) {
    const redirect = shellRedirect(args[index] ?? "", args[index + 1])
    if (!redirect) continue
    redirects.push(redirect)
    if (redirect.consumesNext) index++
  }
  return redirects
}

const PYTHON_STDIN_CONFIG_VALUE_OPTIONS = new Set(["-W", "-X", "--check-hash-based-pycs"])
const BASH_STDIN_CONFIG_VALUE_OPTIONS = new Set(["-O", "+O", "-o", "+o", "--rcfile", "--init-file"])
const NODE_CODE_VALUE_OPTIONS = new Set(["-r", "--require"])
const BASH_CODE_VALUE_OPTIONS = new Set(["--rcfile", "--init-file"])
const NO_STDIN_CODE_VALUE_OPTIONS = new Set<string>()

function stdinConfigValueOptions(name: string | undefined): Set<string> {
  const command = commandBasename(name ?? "")
  if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(command)) return PYTHON_STDIN_CONFIG_VALUE_OPTIONS
  if (command === "bash") return BASH_STDIN_CONFIG_VALUE_OPTIONS
  return NO_STDIN_CODE_VALUE_OPTIONS
}

function bashOptionRegionEnd(args: string[]): number {
  return args.findIndex((word) => word === "--" || word === "-c" || word === "--command" || /^-[^-]*c/.test(word ?? ""))
}

function bashInteractiveOption(args: string[]): boolean {
  const end = bashOptionRegionEnd(args)
  return args.slice(0, end === -1 ? args.length : end + 1).some((word) => /^-[^-]*i/.test(word))
}

function codeValueOptions(name: string | undefined, args: string[]): Set<string> {
  const command = commandBasename(name ?? "")
  if (command === "node" || command === "nodejs") return NODE_CODE_VALUE_OPTIONS
  if (command === "bash" && bashInteractiveOption(args)) return BASH_CODE_VALUE_OPTIONS
  return NO_STDIN_CODE_VALUE_OPTIONS
}

interface ParsedOptionValue {
  value?: string
  consumesNext: boolean
}

function parsedOptionValue(
  word: string,
  next: string | undefined,
  options: Set<string>,
): ParsedOptionValue | undefined {
  for (const option of options) {
    if (word === option) return { value: next, consumesNext: true }
    if (option.startsWith("--") && word.startsWith(`${option}=`)) {
      return { value: word.slice(option.length + 1), consumesNext: false }
    }
    if ((option.startsWith("-") || option.startsWith("+")) && word.startsWith(option) && word.length > option.length) {
      return { value: word.slice(option.length), consumesNext: false }
    }
  }
}

interface StdinCodeArguments {
  positionals: string[]
  codeOptionTargets: string[]
  stdinRedirected: boolean
  stdinTarget?: string
}

function stdinCodeArguments(name: string | undefined, args: string[]): StdinCodeArguments {
  const configOptions = stdinConfigValueOptions(name)
  const codeOptions = codeValueOptions(name, args)
  const positionals: string[] = []
  const codeOptionTargets: string[] = []
  let stdinRedirected = false
  let stdinTarget: string | undefined
  let options = true
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (!word) continue
    const redirect = shellRedirect(word, args[index + 1])
    if (redirect) {
      if (redirect.fd === "0" && redirect.operator.startsWith("<")) {
        stdinRedirected = true
        stdinTarget = redirect.operator === "<" || redirect.operator === "<>" ? redirect.target : undefined
      }
      if (redirect.consumesNext) index++
      continue
    }
    if (word === "-" || word === "/dev/stdin") continue
    if (options && word === "--") {
      options = false
      continue
    }
    if (options) {
      const codeOption = parsedOptionValue(word, args[index + 1], codeOptions)
      if (codeOption) {
        if (codeOption.value !== undefined) codeOptionTargets.push(codeOption.value)
        if (codeOption.consumesNext) index++
        continue
      }
      const configOption = parsedOptionValue(word, args[index + 1], configOptions)
      if (configOption) {
        if (configOption.consumesNext) index++
        continue
      }
      if (word.startsWith("-") || word.startsWith("+")) continue
      options = false
    }
    positionals.push(word)
  }
  return { positionals, codeOptionTargets, stdinRedirected, stdinTarget }
}

function stdinCodePositionals(name: string | undefined, args: string[]): string[] {
  return stdinCodeArguments(name, args).positionals
}
function stdinCodeConsumesTarget(name: string | undefined, args: string[], target: string): boolean {
  const command = commandBasename(name ?? "")
  if (hasInlineInterpreterPayload(command, args)) return false
  const input = stdinCodeArguments(name, args)
  if (input.codeOptionTargets.includes(target)) return true
  if (input.stdinTarget === target) return args.includes("-") || input.positionals.length === 0
  return !args.includes("-") && input.positionals[0] === target
}

function shellConsumesCodeFile(name: string | undefined, args: string[], target: string): boolean {
  if (shellPayload(args)) return false
  const input = stdinCodeArguments(name, args)
  if (input.codeOptionTargets.includes(target)) return true
  if (args.includes("-s")) return input.stdinTarget === target
  return (input.positionals[0] ?? input.stdinTarget) === target
}

function executesStdinAsCode(name: string | undefined, args: string[]): boolean {
  const command = commandBasename(name ?? "")
  if ((command === "source" || command === ".") && args[0] === "/dev/stdin") return true

  const input = stdinCodeArguments(name, args)
  if (isShellPayloadCommand(command)) {
    return !shellPayload(args) && (args.includes("-s") || input.positionals.length === 0)
  }
  if (!/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(command) && !INLINE_EVAL_COMMANDS.has(command) && command !== "php") {
    return false
  }
  if (hasInlineInterpreterPayload(command, args)) return false
  return args.includes("-") || input.positionals.length === 0
}

function commandExecutesStdinAsCode(name: string | undefined, args: string[], depth = 0): boolean {
  if (depth > DIRECTORY_CHANGE_MAX_DEPTH) return true
  if (executesStdinAsCode(name, args)) return true

  const command = commandBasename(name ?? "")
  if (command === "env") {
    const expanded = expandEnvSplitString([command, ...args], 0)
    if (expanded) return commandExecutesStdinAsCode(expanded[0], expanded.slice(1), depth + 1)
    const commandIndex = envDirectoryChange(args).commandIndex
    return commandExecutesStdinAsCode(args[commandIndex], args.slice(commandIndex + 1), depth + 1)
  }
  if (MULTICALL_COMMANDS.has(command)) {
    const applet = multicallCommandParts(args)
    return commandExecutesStdinAsCode(applet.name, applet.args, depth + 1)
  }
  if (!DIRECTORY_WRAPPER_COMMANDS.has(command)) return false
  const wrapped = wrapperCommandParts(command, args)
  return commandExecutesStdinAsCode(wrapped.name, wrapped.args, depth + 1)
}

function heredocHeaderExecutesStdin(header: string): boolean {
  const compound = lexCompoundCommands(header)
  const segments = compound.segments.length > 0 ? compound.segments : [header]
  return segments.some((segment) => {
    const parsed = simpleCommandParts(controlCommandSegment(segment))
    return commandExecutesStdinAsCode(parsed.name, parsed.args)
  })
}

function stdinHeredocMayInvokeSudo(command: string, state: ClassificationState, depth: number): boolean {
  for (const heredoc of extractShellHeredocBodies(command)) {
    if (
      !heredoc.effective ||
      normalizeFileDescriptor(heredoc.fd) !== "0" ||
      !heredocHeaderExecutesStdin(heredoc.header)
    )
      continue
    if (
      hasInlineSudoExecution(heredoc.body, state, depth) ||
      hasSudoInvocationRecursive(heredoc.body, state, depth + 1)
    ) {
      return true
    }
  }
  return false
}
function payloadMayInvokeSudo(payload: string, state: ClassificationState, depth: number): boolean {
  return hasInlineSudoExecution(payload, state, depth) || hasSudoInvocationRecursive(payload, state, depth + 1)
}

function processSubstitutionPayloads(
  command: string,
  state: ClassificationState,
): Array<{ payload: string; start: number; end: number }> | undefined {
  const payloads: Array<{ payload: string; start: number; end: number }> = []
  let exhausted = false
  walkShellChars(
    command,
    (char, index, quote, context) => {
      if (classificationExhausted(state)) {
        exhausted = true
        return false
      }
      if (
        quote ||
        context.inBacktick ||
        context.commandSubstitutionDepth > 0 ||
        (char !== "<" && char !== ">") ||
        command[index + 1] !== "("
      ) {
        return
      }
      const extracted = parenthesizedShellPayload(command, index + 2, state)
      if (!extracted) return
      payloads.push({ payload: extracted.payload, start: index, end: extracted.end })
      return extracted.end
    },
    { comments: true, backticks: true },
  )
  return exhausted ? undefined : payloads
}

const PROCESS_SUBSTITUTION_SENTINEL = "__synergy_process_substitution__"

function maskProcessSubstitutions(command: string, state: ClassificationState): string | undefined {
  const substitutions = processSubstitutionPayloads(command, state)
  if (!substitutions) return

  let masked = ""
  let start = 0
  for (const substitution of substitutions) {
    masked += command.slice(start, substitution.start) + PROCESS_SUBSTITUTION_SENTINEL
    start = substitution.end + 1
  }
  return masked + command.slice(start)
}

function shellConsumesProcessSubstitution(
  name: string | undefined,
  args: string[],
  target: string,
  depth = 0,
): boolean {
  if (depth > DIRECTORY_CHANGE_MAX_DEPTH) return true
  const command = commandBasename(name ?? "")
  if (isShellPayloadCommand(command)) return shellConsumesCodeFile(name, args, target)
  if (command === "source" || command === ".") {
    return stdinCodePositionals(name, args)[0] === target
  }
  if (isInlineInterpreterCommand(command)) {
    return stdinCodeConsumesTarget(name, args, target)
  }
  if (command === "env") {
    const expanded = expandEnvSplitString([command, ...args], 0)
    if (expanded) return shellConsumesProcessSubstitution(expanded[0], expanded.slice(1), target, depth + 1)
    const commandIndex = envDirectoryChange(args).commandIndex
    return shellConsumesProcessSubstitution(args[commandIndex], args.slice(commandIndex + 1), target, depth + 1)
  }
  if (MULTICALL_COMMANDS.has(command)) {
    const applet = multicallCommandParts(args)
    return shellConsumesProcessSubstitution(applet.name, applet.args, target, depth + 1)
  }
  if (!DIRECTORY_WRAPPER_COMMANDS.has(command)) return false
  const wrapped = wrapperCommandParts(command, args)
  return shellConsumesProcessSubstitution(wrapped.name, wrapped.args, target, depth + 1)
}

function processOutputMayInvokeSudo(payload: string, state: ClassificationState, depth: number): boolean {
  for (const heredoc of extractShellHeredocBodies(payload)) {
    if (
      heredoc.effective &&
      normalizeFileDescriptor(heredoc.fd) === "0" &&
      payloadMayInvokeSudo(heredoc.body, state, depth)
    )
      return true
  }

  const compound = lexCompoundCommands(payload)
  const segments = compound.segments.length > 0 ? compound.segments : [payload]
  return segments.some((segment) => {
    const parsed = simpleCommandParts(controlCommandSegment(segment))
    const command = commandBasename(parsed.name ?? "")
    if (command === "echo") return payloadMayInvokeSudo(parsed.args.join(" "), state, depth)
    if (command !== "printf") return false
    return parsed.args.some((argument) => payloadMayInvokeSudo(argument, state, depth))
  })
}

function processSubstitutionMayFeedExecutable(command: string, state: ClassificationState, depth: number): boolean {
  const substitutions = processSubstitutionPayloads(command, state)
  if (!substitutions) return true
  for (const substitution of substitutions) {
    if (classificationExhausted(state)) return true
    const prefix = `${command.slice(0, substitution.start)}${PROCESS_SUBSTITUTION_SENTINEL}`
    const compound = lexCompoundCommands(prefix)
    const segment = compound.segments[compound.segments.length - 1] ?? prefix
    const parsed = simpleCommandParts(controlCommandSegment(segment))
    if (!shellConsumesProcessSubstitution(parsed.name, parsed.args, PROCESS_SUBSTITUTION_SENTINEL)) continue
    if (processOutputMayInvokeSudo(substitution.payload, state, depth + 1)) return true
  }
  return false
}

function heredocFdTarget(heredoc: ShellHeredocBody): string | undefined {
  const parsed = simpleCommandParts(controlCommandSegment(heredoc.header))
  if (commandBasename(parsed.name ?? "") !== "exec" || !heredoc.explicitFd || !heredoc.effective) return
  return normalizeFileDescriptor(heredoc.fd)
}

function heredocWriteTarget(heredoc: ShellHeredocBody): string | undefined {
  if (normalizeFileDescriptor(heredoc.fd) !== "0" || !heredoc.effective) return
  const words = shellWords(normalizeCommand(separateAttachedInputRedirects(heredoc.header)))
  if (words[0] === "tee") {
    const heredocIndex = words.findIndex((word) => word.startsWith("<<"))
    const candidates = heredocIndex === -1 ? words.slice(1) : words.slice(1, heredocIndex)
    return candidates.find(
      (word) => word !== "-" && !word.startsWith("-") && !word.startsWith("<") && !word.startsWith(">"),
    )
  }
  let target: string | undefined
  for (let index = 0; index < words.length; index++) {
    const redirect = words[index]?.match(/^(?:1)?(>>?)(.*)$/)
    if (!redirect) continue
    if (redirect[2].startsWith("&")) continue
    target = redirect[2] || words[++index]
  }
  return target
}

function fdRedirectSource(redirect: ShellRedirect): { fd: string; move: boolean } | undefined {
  if (redirect.operator !== "<&") return
  const match = /^(\d+)(-?)$/.exec(redirect.target ?? "")
  return match ? { fd: normalizeFileDescriptor(match[1]), move: match[2] === "-" } : undefined
}

function fdAliasesAfterRedirects(aliases: Set<string>, args: string[]): Set<string> {
  const result = new Set(aliases)
  for (const redirect of shellRedirects(args)) {
    const source = fdRedirectSource(redirect)
    if (!source || !result.has(source.fd)) continue
    result.add(redirect.fd)
    if (source.move) result.delete(source.fd)
  }
  return result
}

function shellPayloadConsumesFdAsCode(payload: string, fd: string, depth: number): boolean {
  const compound = lexCompoundCommands(payload)
  const segments = compound.segments.length > 0 ? compound.segments : [payload]
  return segments.some((segment) => {
    const parsed = simpleCommandParts(controlCommandSegment(segment))
    return commandConsumesFdAsCode(parsed.name, parsed.args, fd, depth + 1)
  })
}

function commandConsumesFdAsCode(name: string | undefined, args: string[], fd: string, depth = 0): boolean {
  if (depth > DIRECTORY_CHANGE_MAX_DEPTH) return true
  const aliases = fdAliasesAfterRedirects(new Set([fd]), args)
  if (aliases.has("0") && executesStdinAsCode(name, args)) return true
  const command = commandBasename(name ?? "")
  if (isShellPayloadCommand(command)) {
    const payload = shellPayload(args)
    if (payload && [...aliases].some((alias) => shellPayloadConsumesFdAsCode(payload, alias, depth))) return true
  }
  if (command === "env") {
    const expanded = expandEnvSplitString([command, ...args], 0)
    if (expanded)
      return [...aliases].some((alias) => commandConsumesFdAsCode(expanded[0], expanded.slice(1), alias, depth + 1))
    const commandIndex = envDirectoryChange(args).commandIndex
    return [...aliases].some((alias) =>
      commandConsumesFdAsCode(args[commandIndex], args.slice(commandIndex + 1), alias, depth + 1),
    )
  }
  if (MULTICALL_COMMANDS.has(command)) {
    const applet = multicallCommandParts(args)
    return [...aliases].some((alias) => commandConsumesFdAsCode(applet.name, applet.args, alias, depth + 1))
  }
  if (!DIRECTORY_WRAPPER_COMMANDS.has(command)) return false
  const wrapped = wrapperCommandParts(command, args)
  return [...aliases].some((alias) => commandConsumesFdAsCode(wrapped.name, wrapped.args, alias, depth + 1))
}

function commandExecutesFileAsCode(name: string | undefined, args: string[], target: string, depth = 0): boolean {
  if (depth > DIRECTORY_CHANGE_MAX_DEPTH) return true
  const command = commandBasename(name ?? "")
  if (isShellPayloadCommand(command)) return shellConsumesCodeFile(name, args, target)
  if (isInlineInterpreterCommand(command)) {
    return stdinCodeConsumesTarget(name, args, target)
  }
  if (command === "env") {
    const expanded = expandEnvSplitString([command, ...args], 0)
    if (expanded) return commandExecutesFileAsCode(expanded[0], expanded.slice(1), target, depth + 1)
    const commandIndex = envDirectoryChange(args).commandIndex
    return commandExecutesFileAsCode(args[commandIndex], args.slice(commandIndex + 1), target, depth + 1)
  }
  if (MULTICALL_COMMANDS.has(command)) {
    const applet = multicallCommandParts(args)
    return commandExecutesFileAsCode(applet.name, applet.args, target, depth + 1)
  }
  if (!DIRECTORY_WRAPPER_COMMANDS.has(command)) return false
  const wrapped = wrapperCommandParts(command, args)
  return commandExecutesFileAsCode(wrapped.name, wrapped.args, target, depth + 1)
}

function execCommandParts(args: string[]): { name?: string; args: string[] } {
  const operands: string[] = []
  const redirections: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? ""
    const redirect = shellRedirect(word, args[index + 1])
    const combinedOutput = /^&>>?(.*)$/.exec(word)
    if (!redirect && !combinedOutput) {
      operands.push(word)
      continue
    }

    redirections.push(word)
    if (redirect?.consumesNext || (combinedOutput && !combinedOutput[1])) {
      const operand = args[++index]
      if (operand !== undefined) redirections.push(operand)
    }
  }

  let options = true
  for (let index = 0; index < operands.length; index++) {
    const word = operands[index] ?? ""
    if (options && word === "--") {
      options = false
      continue
    }
    if (options && word === "-a") {
      index++
      continue
    }
    if (options && (/^-[acl]+$/.test(word) || /^-a.+$/.test(word) || word.startsWith("-"))) continue
    if (word.includes("$") || word.includes("`")) continue
    return {
      name: word,
      args: [...redirections, ...operands.slice(index + 1)],
    }
  }
  return { args: redirections }
}

function fdReplayConsumed(segments: string[], sourceIndex: number, fd: string): boolean {
  const source = simpleCommandParts(controlCommandSegment(segments[sourceIndex] ?? ""))
  let aliases = fdAliasesAfterRedirects(new Set([fd]), source.args)
  return segments.slice(sourceIndex + 1).some((segment) => {
    const parsed = simpleCommandParts(controlCommandSegment(segment))
    const input = stdinCodeArguments(parsed.name, parsed.args)
    if (aliases.has("0") && !input.stdinRedirected && commandExecutesStdinAsCode(parsed.name, parsed.args)) return true
    if ([...aliases].some((alias) => commandConsumesFdAsCode(parsed.name, parsed.args, alias))) return true
    if (commandBasename(parsed.name ?? "") !== "exec") return false
    aliases = fdAliasesAfterRedirects(aliases, parsed.args)
    return false
  })
}

type ExecfailMutation = "enable" | "disable" | "unknown" | undefined

function shoptExecfailMutation(args: string[]): ExecfailMutation {
  const mode = args[0]
  const optionNames = args.slice(1)
  if (
    (mode === "-s" || mode === "-u") &&
    optionNames.length > 0 &&
    optionNames.every((word) => !word.startsWith("-") && !word.includes("$") && !word.includes("`"))
  ) {
    if (!optionNames.includes("execfail")) return
    return mode === "-s" ? "enable" : "disable"
  }

  const mayChange = args.some((word) => /^-[^-]*[su]/.test(word))
  const mayNameExecfail = args.some(
    (word) => word === "execfail" || word.includes("$") || word.includes("`") || word.includes("*"),
  )
  return mayChange && mayNameExecfail ? "unknown" : undefined
}

function segmentExecfailMutation(segment: string, name: string, args: string[]): ExecfailMutation {
  if (name === "shopt") return shoptExecfailMutation(args)
  if (name === "eval") {
    const reparsed = simpleCommandParts(args.join(" "))
    if (commandBasename(reparsed.name ?? "") === "shopt") return shoptExecfailMutation(reparsed.args) ?? "unknown"
    return args.some((word) => word.includes("execfail") || word.includes("$") || word.includes("`"))
      ? "unknown"
      : undefined
  }
  if (name === "source" || name === ".") return "unknown"
  if (name === "trap" && trapPayload(args)?.includes("execfail")) return "unknown"
  if (functionDefinitionBody(segment)?.includes("execfail")) return "unknown"
}

function execfailDisableDefinitelyRuns(segments: string[], operators: string[], index: number, name: string): boolean {
  if (name !== "shopt") return false
  const segment = segments[index]?.trim() ?? ""
  const nextOperator = operators[index]
  if (nextOperator === "|" || nextOperator === "|&" || nextOperator === "&") return false

  if (/^shopt(?:\s|$)/.test(segment)) return index === 0 || operators[index - 1] === ";"
  if (!/^then\s+shopt(?:\s|$)/.test(segment)) return false

  const conditionIndex = index - 1
  const condition = segments[conditionIndex]?.trim() ?? ""
  if (!/^if\s+(?:true|:)(?:\s|$)/.test(condition)) return false
  return conditionIndex === 0 || operators[conditionIndex - 1] === ";"
}

function execfailMayBeEnabledBefore(segments: string[], operators: string[], sourceIndex: number): boolean {
  let mayBeEnabled = false
  for (let index = 0; index < sourceIndex; index++) {
    const segment = segments[index]?.trim() ?? ""
    const parsed = simpleCommandParts(controlCommandSegment(segment))
    const name = commandBasename(parsed.name ?? "")
    const mutation = segmentExecfailMutation(segment, name, parsed.args)
    if (mutation === "enable" || mutation === "unknown") {
      mayBeEnabled = true
      continue
    }
    if (mutation !== "disable") continue

    if (execfailDisableDefinitelyRuns(segments, operators, index, name)) mayBeEnabled = false
  }
  return mayBeEnabled
}

function fdReplayMayInvokeSudo(command: string, state: ClassificationState, depth: number): boolean {
  const maskedCommand = maskProcessSubstitutions(command, state)
  if (maskedCommand === undefined) return true
  const compound = lexCompoundCommands(maskedCommand)
  const segments = compound.segments.length > 0 ? compound.segments : [maskedCommand]
  const replayConsumed = (sourceIndex: number, fd: string): boolean => fdReplayConsumed(segments, sourceIndex, fd)
  const execHerestrings = (segment: string): Array<{ fd: string; payload: string }> => {
    const herestrings: Array<{ fd: string; payload: string }> = []
    walkShellChars(
      segment,
      (char, index, quote, context) => {
        if (
          quote ||
          context.inBacktick ||
          context.arithmetic ||
          context.commandSubstitutionDepth > 0 ||
          char !== "<" ||
          !segment.startsWith("<<<", index) ||
          segment[index - 1] === "<"
        ) {
          return
        }

        let fdStart = index
        while (fdStart > 0 && /\d/.test(segment[fdStart - 1] ?? "")) fdStart--
        const fdCandidate = segment.slice(fdStart, index)
        const explicitFd = fdCandidate.length > 0 && (fdStart === 0 || /[\s;&|()<>]/.test(segment[fdStart - 1] ?? ""))
        let payloadStart = index + 3
        while (segment[payloadStart] === " " || segment[payloadStart] === "\t") payloadStart++
        const payload = shellWords(segment.slice(payloadStart))[0]
        if (payload !== undefined) {
          herestrings.push({ fd: explicitFd ? normalizeFileDescriptor(fdCandidate) : "0", payload })
        }
        return index + 2
      },
      { comments: true, backticks: true },
    )
    return herestrings
  }

  {
    const sourceIndexes = new Map<number, number>()
    let searchFrom = 0
    for (const heredoc of extractShellHeredocBodies(command)) {
      const fd = heredocFdTarget(heredoc)
      if (!fd) continue
      let sourceIndex = sourceIndexes.get(heredoc.headerLine)
      if (sourceIndex === undefined) {
        const maskedHeader = maskProcessSubstitutions(heredoc.header, state)
        if (maskedHeader === undefined) return true
        sourceIndex = segments.findIndex(
          (segment, segmentIndex) => segmentIndex >= searchFrom && segment.includes(maskedHeader),
        )
        if (sourceIndex === -1) continue
        sourceIndexes.set(heredoc.headerLine, sourceIndex)
        searchFrom = sourceIndex + 1
      }
      if (replayConsumed(sourceIndex, fd) && payloadMayInvokeSudo(heredoc.body, state, depth)) return true
    }
  }

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = controlCommandSegment(segments[segmentIndex])
    const parsed = simpleCommandParts(segment)
    if (commandBasename(parsed.name ?? "") !== "exec") continue
    const herestrings = execHerestrings(segment)
    const execCommand = execCommandParts(parsed.args)
    for (const { fd, payload } of herestrings) {
      if (!payloadMayInvokeSudo(payload, state, depth)) continue
      const consumedInSource =
        fd === "0"
          ? commandExecutesStdinAsCode(execCommand.name, execCommand.args)
          : commandConsumesFdAsCode(execCommand.name, execCommand.args, fd)
      if (consumedInSource) return true
      if (execCommand.name && !execfailMayBeEnabledBefore(segments, compound.operators, segmentIndex)) continue
      if (replayConsumed(segmentIndex, fd)) return true
    }
  }
  return false
}

function heredocDataFlowMayInvokeSudo(command: string, state: ClassificationState, depth: number): boolean {
  if (fdReplayMayInvokeSudo(command, state, depth)) return true
  const maskedCommand = maskProcessSubstitutions(command, state)
  if (maskedCommand === undefined) return true
  const compound = lexCompoundCommands(maskedCommand)
  const segments = compound.segments.length > 0 ? compound.segments : [maskedCommand]
  const sourceIndexes = new Map<number, number>()
  let searchFrom = 0
  for (const heredoc of extractShellHeredocBodies(command)) {
    const target = heredocWriteTarget(heredoc)
    if (!target) continue
    let sourceIndex = sourceIndexes.get(heredoc.headerLine)
    if (sourceIndex === undefined) {
      sourceIndex = segments.findIndex((segment, index) => index >= searchFrom && segment.includes(heredoc.header))
      if (sourceIndex === -1) continue
      sourceIndexes.set(heredoc.headerLine, sourceIndex)
      searchFrom = sourceIndex + 1
    }
    const consumed = segments.slice(sourceIndex + 1).some((segment, offset) => {
      const segmentIndex = sourceIndex + offset + 1
      const parsed = simpleCommandParts(controlCommandSegment(segment))
      if (commandExecutesFileAsCode(parsed.name, parsed.args, target)) return true
      if (commandBasename(parsed.name ?? "") !== "exec") return false

      const execCommand = execCommandParts(parsed.args)
      return shellRedirects(parsed.args).some((redirect) => {
        if ((redirect.operator !== "<" && redirect.operator !== "<>") || redirect.target !== target) return false
        const consumedInSource =
          redirect.fd === "0"
            ? commandExecutesStdinAsCode(execCommand.name, execCommand.args)
            : commandConsumesFdAsCode(execCommand.name, execCommand.args, redirect.fd)
        if (consumedInSource) return true
        if (execCommand.name && !execfailMayBeEnabledBefore(segments, compound.operators, segmentIndex)) return false
        return fdReplayConsumed(segments, segmentIndex, redirect.fd)
      })
    })
    if (consumed && payloadMayInvokeSudo(heredoc.body, state, depth)) return true
  }
  return false
}

function wrapperCommandArgs(name: string, args: string[]): { commandIndex: number; name?: string } {
  const valueOptions = WRAPPER_VALUE_OPTIONS[name] ?? new Set<string>()
  let index = 0
  while (index < args.length) {
    const word = args[index]
    if (!word) break
    if (word === "--") {
      index++
      break
    }
    if (valueOptions.has(word)) {
      index += 2
      continue
    }
    const redirect = shellRedirect(word, args[index + 1])
    // Heredoc (`<<`, `<<-`) bodies are data, never the wrapped command, so
    // stop at them; herestrings and file redirects can precede the command.
    if (redirect && redirect.operator !== "<<" && redirect.operator !== "<<-") {
      index += redirect.consumesNext ? 2 : 1
      continue
    }
    if (word.startsWith("-")) {
      index++
      continue
    }
    break
  }
  if (name === "timeout" && index < args.length) index++
  return { commandIndex: index, name: args[index] }
}

function wrapperCommandParts(name: string, args: string[]): { name?: string; args: string[] } {
  const { commandIndex, name: wrappedName } = wrapperCommandArgs(name, args)
  return { name: wrappedName, args: args.slice(commandIndex + 1) }
}

function trapPayload(args: string[]): string | undefined {
  const payloadArgs = args[0] === "--" ? args.slice(1) : args
  if (payloadArgs.length < 2 || payloadArgs[0]?.startsWith("-")) return undefined
  return payloadArgs[0]
}

function controlCommandSegment(segment: string): string {
  let current = segment.trim()
  current = current.replace(/^case\b[\s\S]*?\bin\b\s*[^()]*\)\s*/, "")
  current = current.replace(/^[^(){};&|]+\)\s*/, "")
  current = current.replace(/^[({]+\s*/, "")
  while (/^(?:if|then|elif|else|do|while|until|!)\b/.test(current)) {
    current = current.replace(/^(?:if|then|elif|else|do|while|until|!)\b\s*/, "")
  }
  return current.replace(/(?:\)+|\s+}+)$/, "").trim()
}

function executableShellSyntaxText(command: string): string {
  const result = Array<string>(command.length).fill(" ")
  for (let index = 0; index < command.length; index++) {
    if (command[index] === "\n") result[index] = "\n"
  }
  walkShellChars(
    command,
    (char, index, quote, context) => {
      if (!quote && !context.inBacktick && context.commandSubstitutionDepth === 0) result[index] = char
    },
    { comments: true, backticks: true },
  )
  return result.join("")
}

function unquotedShellText(command: string): string {
  let result = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "\\" && quote !== "'") {
      result += quote ? "  " : command.slice(index, index + 2)
      index++
      continue
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? undefined : char
      result += " "
      continue
    }
    result += quote ? " " : char
  }
  return result
}

function hasLastArgumentReference(command: string): boolean {
  let found = false
  walkShellChars(
    command,
    (char, index, quote) => {
      if (quote === "'" || char !== "$") return
      if (command.startsWith("${_", index)) {
        const following = command[index + 3]
        if (!following || following === "}" || !/[A-Za-z0-9_]/.test(following)) {
          found = true
          return false
        }
      }
      if (command[index + 1] !== "_") return
      const following = command[index + 2]
      if (following && /[A-Za-z0-9_]/.test(following)) return
      found = true
      return false
    },
    { comments: true },
  )
  return found
}

function parenthesizedShellPayload(
  command: string,
  start: number,
  state: ClassificationState,
): { payload: string; end: number } | undefined {
  let depth = 1
  let end: number | undefined
  walkShellChars(
    command.slice(start),
    (char, offset, quote, context) => {
      if (classificationExhausted(state)) return false
      if (quote || context.inBacktick) return
      if (char === "(") depth++
      if (char === ")" && --depth === 0) {
        end = start + offset
        return false
      }
    },
    { comments: true, backticks: true },
  )
  return end === undefined ? undefined : { payload: command.slice(start, end), end }
}
function commandSubstitutionPayloads(command: string, state: ClassificationState): string[] | undefined {
  const payloads: string[] = []
  let exhausted = false
  walkShellChars(
    command,
    (char, index, quote) => {
      if (classificationExhausted(state)) {
        exhausted = true
        return false
      }
      if (quote !== "'" && char === "`") {
        const start = index + 1
        let end: number | undefined
        walkShellChars(
          command.slice(start),
          (inner, offset, innerQuote) => {
            if (classificationExhausted(state)) {
              exhausted = true
              return false
            }
            if (!innerQuote && inner === "`") {
              end = start + offset
              return false
            }
          },
          { comments: true },
        )
        if (exhausted) return false
        if (end === undefined) return
        payloads.push(command.slice(start, end))
        return end
      }
      let start: number | undefined
      if (quote !== "'" && char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
        start = index + 2
      } else if (!quote && (char === ">" || char === "<") && command[index + 1] === "(") {
        start = index + 2
      }
      if (start === undefined) return

      const extracted = parenthesizedShellPayload(command, start, state)
      if (classificationExhausted(state)) {
        exhausted = true
        return false
      }
      if (!extracted) return
      payloads.push(extracted.payload)
      return extracted.end
    },
    { comments: true },
  )
  if (exhausted) return
  return payloads
}

const DISPLAY_ONLY_LAST_ARGUMENT_COMMANDS = new Set(["echo", "printf"])

function hasReparsedLastArgumentReference(command: string, state: ClassificationState, depth: number): boolean {
  if (classificationExhausted(state, command) || depth > DIRECTORY_CHANGE_MAX_DEPTH) return true

  const normalized = normalizeCommand(command)
  if (state.activeInputs.has(normalized)) return true
  state.activeInputs.add(normalized)
  try {
    const substitutions = commandSubstitutionPayloads(normalized, state)
    if (!substitutions) return true
    if (substitutions.some((payload) => hasReparsedLastArgumentReference(payload, state, depth + 1))) return true

    const compound = lexCompoundCommands(normalized)
    const segments = compound.segments.length > 0 ? compound.segments : [normalized]
    return segments.some((segment) => {
      const parsed = simpleCommandParts(controlCommandSegment(segment))
      const name = commandBasename(parsed.name ?? "")
      const payload = name === "eval" ? parsed.args.join(" ") : name === "trap" ? trapPayload(parsed.args) : undefined
      if (payload && hasReparsedLastArgumentReference(payload, state, depth + 1)) return true
      return hasLastArgumentReference(segment) && !DISPLAY_ONLY_LAST_ARGUMENT_COMMANDS.has(name)
    })
  } finally {
    state.activeInputs.delete(normalized)
  }
}

function analyzeDirectoryCommandParts(
  name: string | undefined,
  args: string[],
  state: ClassificationState,
  depth: number,
  ctx: DirectoryChangeContext,
): DirectoryChangeAnalysis {
  const result: DirectoryChangeAnalysis = { targets: [], opaque: false }
  if (classificationExhausted(state)) return { targets: [], opaque: true }
  if (!name) return result
  if (dynamicCommandName(name)) return { targets: [], opaque: true }

  const command = commandBasename(name)
  if (depth > DIRECTORY_CHANGE_MAX_DEPTH) {
    return {
      targets: [],
      opaque:
        command === "cd" ||
        command === "pushd" ||
        command === "popd" ||
        command === "env" ||
        command === "eval" ||
        command === "trap" ||
        isShellPayloadCommand(command) ||
        hasInlineInterpreterPayload(command, args) ||
        MULTICALL_COMMANDS.has(command) ||
        DIRECTORY_WRAPPER_COMMANDS.has(command),
    }
  }
  if (command === "cd" || command === "pushd") {
    const target = positionalDirectoryTarget(args)
    if (slashRelativeCdResolvable(target, ctx)) {
      result.targets.push(target!)
    } else if (
      dynamicDirectoryTarget(target) ||
      cdpathDependentDirectoryTarget(target) ||
      (command === "pushd" && /^[+-]\d+$/.test(target ?? ""))
    ) {
      result.opaque = true
    } else {
      result.targets.push(target!)
    }
    return result
  }
  if (command === "popd") {
    result.opaque = true
    return result
  }
  if (command === "env") {
    const env = envDirectoryChange(args)
    if (env.target && !dynamicDirectoryTarget(env.target)) result.targets.push(env.target)
    result.opaque ||= env.opaque
    const expanded = expandEnvSplitString([command, ...args], 0)
    if (expanded) {
      mergeDirectoryChangeAnalysis(
        result,
        analyzeDirectoryCommandParts(expanded[0], expanded.slice(1), state, depth + 1, ctx),
      )
    } else if (env.commandIndex < args.length) {
      mergeDirectoryChangeAnalysis(
        result,
        analyzeDirectoryCommandParts(args[env.commandIndex], args.slice(env.commandIndex + 1), state, depth + 1, ctx),
      )
    }
    return result
  }
  if (MULTICALL_COMMANDS.has(command)) {
    const applet = multicallCommandParts(args)
    mergeDirectoryChangeAnalysis(result, analyzeDirectoryCommandParts(applet.name, applet.args, state, depth + 1, ctx))
    return result
  }
  if (hasInlineInterpreterPayload(command, args)) return { targets: [], opaque: true }
  if (isShellPayloadCommand(command)) {
    const payload = shellPayload(args)
    if (payload) mergeDirectoryChangeAnalysis(result, analyzeDirectoryChangesRecursive(payload, state, depth + 1, ctx))
    return result
  }
  if (command === "eval" && args.length > 0) {
    mergeDirectoryChangeAnalysis(result, analyzeDirectoryChangesRecursive(args.join(" "), state, depth + 1, ctx))
  }
  if (command === "trap") {
    const payload = trapPayload(args)
    if (payload) mergeDirectoryChangeAnalysis(result, analyzeDirectoryChangesRecursive(payload, state, depth + 1, ctx))
    return result
  }
  if (DIRECTORY_WRAPPER_COMMANDS.has(command)) {
    if (command === "sudo") {
      const directoryChange = sudoDirectoryChange(args)
      if (directoryChange.target && !dynamicDirectoryTarget(directoryChange.target)) {
        result.targets.push(directoryChange.target)
      }
      result.opaque ||= directoryChange.opaque
    }
    const replacement = command === "xargs" ? xargsReplacementToken(args) : undefined
    const wrapped = wrapperCommandParts(command, args)
    const wrappedAnalysis = analyzeDirectoryCommandParts(wrapped.name, wrapped.args, state, depth + 1, ctx)
    if (replacement && wrappedAnalysis.targets.some((target) => target.includes(replacement))) {
      wrappedAnalysis.opaque = true
    }
    mergeDirectoryChangeAnalysis(result, wrappedAnalysis)
    return result
  }
  return result
}

function analyzeDirectoryChangesRecursive(
  command: string,
  state: ClassificationState,
  depth: number,
  ctx: DirectoryChangeContext,
): DirectoryChangeAnalysis {
  const childCtx: DirectoryChangeContext = {
    options: ctx.options,
    cdpathDefined: ctx.cdpathDefined || commandDefinesCdpath(normalizeCommand(command)),
  }
  if (classificationExhausted(state, command)) return { targets: [], opaque: true }

  const normalized = normalizeCommand(command)
  if (state.activeInputs.has(normalized)) return { targets: [], opaque: true }
  state.activeInputs.add(normalized)

  try {
    const result: DirectoryChangeAnalysis = { targets: [], opaque: false }
    if (hasEscapedAnsiCQuote(command) || hasReparsedEscapedAnsiCQuote(command)) result.opaque = true

    const potentialChange = /\b(?:cd|pushd|popd)\b|\benv\b[^\n]*(?:\s-C\b|--chdir)/.test(unquotedShellText(normalized))
    if (depth > DIRECTORY_CHANGE_MAX_DEPTH) return { targets: [], opaque: potentialChange || result.opaque }
    if (normalized.includes("\n") && potentialChange) result.opaque = true
    if (hasFunctionDefinition(normalized) || hasOpaqueCaseDirectorySyntax(normalized)) result.opaque = true

    const payloads = commandSubstitutionPayloads(normalized, state)
    if (!payloads) return { targets: result.targets, opaque: true }
    for (const payload of payloads) {
      if (classificationExhausted(state)) return { targets: result.targets, opaque: true }
      mergeDirectoryChangeAnalysis(result, analyzeDirectoryChangesRecursive(payload, state, depth + 1, childCtx))
    }

    const compound = lexCompoundCommands(normalized)
    const segments = compound.segments.length > 0 ? compound.segments : [normalized]
    for (const segment of segments) {
      if (classificationExhausted(state)) return { targets: result.targets, opaque: true }
      if (commandLookupOnly(segment)) continue
      const controlled = controlCommandSegment(segment)
      const parsed = simpleCommandParts(controlled)
      const direct = analyzeDirectoryCommandParts(parsed.name, parsed.args, state, depth, childCtx)
      mergeDirectoryChangeAnalysis(result, direct)

      if (direct.targets.length === 0 && !direct.opaque) {
        const stripped = stripWrappers(controlled)
        if (stripped !== controlled) {
          const wrapped = simpleCommandParts(stripped)
          mergeDirectoryChangeAnalysis(
            result,
            analyzeDirectoryCommandParts(wrapped.name, wrapped.args, state, depth, childCtx),
          )
        }
      }

      const hidden = unquotedShellText(segment)
      if (/(?:^|[({)]|\b(?:if|then|elif|else|do|while|until)\b)\s*(?:cd|pushd|popd)\b/.test(hidden)) {
        if (direct.targets.length === 0 && !direct.opaque) result.opaque = true
      }
    }
    return result
  } finally {
    state.activeInputs.delete(normalized)
  }
}

function commandNameWithoutEmptySubstitutions(name: string | undefined): string | undefined {
  return name?.replace(/\$\(\)/g, "")
}

const INLINE_EXECUTION_API =
  "(?:system|popen|check_(?:call|output)|get(?:status)?output|exec(?:file)?(?:sync)?|spawn(?:sync|lpe|lp|le|l|vpe|vp|ve|v)?|run|call|shell_exec|passthru|proc_open)"

function inlineCodeSyntaxText(payload: string): string {
  const result = Array<string>(payload.length).fill(" ")
  let quote: "'" | '"' | "`" | undefined
  for (let index = 0; index < payload.length; index++) {
    const char = payload[index]
    if (quote) {
      if (char === "\\" && index + 1 < payload.length) index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      continue
    }
    result[index] = char
  }
  return result.join("")
}

interface InlineStringValue {
  value: string
  opaque: boolean
}

function inlineStringSequence(payload: string, start: number): InlineStringValue | undefined {
  let index = start
  let value = ""
  let found = false
  let opaque = false
  while (index < payload.length && /\s/.test(payload[index] ?? "")) index++
  if (payload[index] === "[") {
    index++
    while (index < payload.length && /\s/.test(payload[index] ?? "")) index++
  }

  while (index < payload.length) {
    while (index < payload.length && (/\s/.test(payload[index] ?? "") || payload[index] === "+")) index++
    const prefixStart = index
    while (/[rubf]/i.test(payload[index] ?? "")) index++
    const raw = payload.slice(prefixStart, index).toLowerCase().includes("r")
    const quote = payload[index]
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      index = prefixStart
      break
    }
    found = true
    index++
    while (index < payload.length) {
      const char = payload[index++]
      if (char === "\\" && index < payload.length) {
        if (!raw && payload.startsWith("N{", index)) {
          const close = payload.indexOf("}", index + 2)
          if (close !== -1) {
            opaque = true
            index = close + 1
            continue
          }
        }
        const sequence = raw ? undefined : INLINE_STRING_ESCAPE.exec(payload.slice(index))?.[0]
        if (sequence) {
          let codePoint: number
          if (sequence[0] === "x" || sequence[0] === "X") codePoint = parseInt(sequence.slice(1), 16)
          else if (sequence.startsWith("u{")) codePoint = parseInt(sequence.slice(2, -1), 16)
          else if (sequence[0] === "u" || sequence[0] === "U") codePoint = parseInt(sequence.slice(1), 16)
          else codePoint = parseInt(sequence, 8)
          if (codePoint <= 0x10ffff) {
            value += String.fromCodePoint(codePoint)
            index += sequence.length
            continue
          }
        }
        value += `\\${payload[index]}`
        index++
        continue
      }
      if (char === quote) break
      value += char
    }
  }
  return found ? { value, opaque } : undefined
}

function inlineArgumentInvokesSudo(payload: string, start: number, state: ClassificationState, depth: number): boolean {
  const sequence = inlineStringSequence(payload, start)
  return Boolean(
    sequence && (sequence.opaque || (sequence.value && hasSudoInvocationRecursive(sequence.value, state, depth + 1))),
  )
}

function hasInlineSudoExecution(payload: string, state: ClassificationState, depth: number): boolean {
  const syntax = inlineCodeSyntaxText(payload)
  const parenthesized = new RegExp(`\\b${INLINE_EXECUTION_API}\\s*\\(`, "gi")
  for (let match = parenthesized.exec(syntax); match; match = parenthesized.exec(syntax)) {
    if (inlineArgumentInvokesSudo(payload, match.index + match[0].length, state, depth)) return true
  }

  const parenthesiless = /\b(?:system|popen|exec)\b/gi
  for (let match = parenthesiless.exec(syntax); match; match = parenthesiless.exec(syntax)) {
    let start = match.index + match[0].length
    while (/\s/.test(payload[start] ?? "")) start++
    if (payload[start] !== "(" && inlineArgumentInvokesSudo(payload, start, state, depth)) return true
  }
  return false
}

function reparsePayloadMayInvokeSudo(payload: string, state: ClassificationState, depth: number): boolean {
  return hasSudoInvocationRecursive(payload, state, depth)
}

function commandLookupOnly(segment: string): boolean {
  const words = shellWords(normalizeCommand(segment))
  let index = 0
  while (words[index]?.includes("=") && !words[index]?.startsWith("-")) index++
  if (words[index] !== "command") return false
  index++
  return words.slice(index).some((word) => /^-[pP]*[vV]/.test(word))
}

const RUNUSER_VALUE_OPTIONS = new Set(["-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell"])
const PKEXEC_VALUE_OPTIONS = new Set(["-u", "--user"])
const NSENTER_VALUE_OPTIONS = new Set([
  "-t",
  "--target",
  "-S",
  "--setuid",
  "-G",
  "--setgid",
  "-r",
  "--root",
  "-w",
  "--wd",
  "--wdns",
])
const CONTAINER_EXEC_VALUE_OPTIONS = new Set([
  "--detach-keys",
  "-e",
  "--env",
  "--env-file",
  "--preserve-fd",
  "--preserve-fds",
  "-u",
  "--user",
  "-w",
  "--workdir",
])
const CONTAINER_RUN_VALUE_OPTIONS = new Set([
  "--entrypoint",
  "--env",
  "--env-file",
  "--mount",
  "--name",
  "--network",
  "--platform",
  "--publish",
  "--user",
  "--volume",
  "--workdir",
  "-e",
  "-p",
  "-u",
  "-v",
  "-w",
])
const CONTAINER_FLAG_OPTIONS = new Set([
  "--detach",
  "--init",
  "--interactive",
  "--privileged",
  "--read-only",
  "--rm",
  "--tty",
  "-d",
  "-i",
  "-t",
])
const SCRIPT_VALUE_OPTIONS = new Set([
  "-c",
  "--command",
  "-t",
  "--log-in",
  "--log-out",
  "--log-io",
  "--log-timing",
  "--output-limit",
])

function optionConsumesValue(word: string, valueOptions: Set<string>): boolean {
  return valueOptions.has(word)
}

function attachedOptionValue(word: string, valueOptions: Set<string>): boolean {
  return [...valueOptions].some((option) => {
    if (option.startsWith("--")) return word.startsWith(`${option}=`)
    return option.startsWith("-") && word.startsWith(option) && word.length > option.length
  })
}

function commandAfterOptions(args: string[], valueOptions: Set<string>): string[] | undefined {
  let index = 0
  while (index < args.length) {
    const word = args[index]
    if (!word) return
    if (word === "--") return args.slice(index + 1)
    if (optionConsumesValue(word, valueOptions)) {
      if (!args[index + 1]) return
      index += 2
      continue
    }
    if (attachedOptionValue(word, valueOptions) || word.startsWith("-")) {
      index++
      continue
    }
    return args.slice(index)
  }
}

interface ContainerCommand {
  executable?: string[]
  entrypoint?: string
  opaque: boolean
}

function containerCommandAfterOptions(args: string[], valueOptions: Set<string>): ContainerCommand {
  let index = 0
  let entrypoint: string | undefined
  while (index < args.length) {
    const word = args[index]
    if (!word) return { opaque: true }
    if (word === "--") return { executable: args.slice(index + 1), entrypoint, opaque: false }
    if (word === "--entrypoint" && valueOptions.has("--entrypoint")) {
      if (args[index + 1] === undefined) return { opaque: true }
      entrypoint = args[index + 1] || undefined
      index += 2
      continue
    }
    if (word.startsWith("--entrypoint=") && valueOptions.has("--entrypoint")) {
      entrypoint = word.slice("--entrypoint=".length) || undefined
      index++
      continue
    }
    if (optionConsumesValue(word, valueOptions)) {
      if (args[index + 1] === undefined) return { opaque: true }
      index += 2
      continue
    }
    if (attachedOptionValue(word, valueOptions) || CONTAINER_FLAG_OPTIONS.has(word) || /^-[dit]+$/.test(word)) {
      index++
      continue
    }
    if (word.startsWith("-")) {
      if (word.startsWith("--") && word.includes("=")) {
        index++
        continue
      }
      return { opaque: true }
    }
    return { executable: args.slice(index), entrypoint, opaque: false }
  }
  return { opaque: false }
}

type IndirectExecution = { payload: string; reparsed: boolean } | { opaque: true }
function indirectExecutionPayload(command: string, args: string[]): IndirectExecution | undefined {
  if (command === "su" || command === "sg") {
    const payload = shellPayload(args)
    return payload ? { payload, reparsed: true } : undefined
  }
  if (command === "script") {
    const payload = shellPayload(args)
    if (payload) return { payload, reparsed: true }
    const positionals = commandAfterOptions(args, SCRIPT_VALUE_OPTIONS)
    const executable = positionals?.slice(1)
    return executable?.length ? { payload: executable.join(" "), reparsed: false } : undefined
  }
  if (command === "watch") {
    const executable = commandAfterOptions(args, WRAPPER_VALUE_OPTIONS.watch)
    return executable?.length ? { payload: executable.join(" "), reparsed: true } : undefined
  }
  if (command === "runuser") {
    const directMode = args.some(
      (word) => word === "-u" || word === "--user" || word.startsWith("-u") || word.startsWith("--user="),
    )
    if (!directMode) {
      const payload = shellPayload(args)
      return payload ? { payload, reparsed: true } : undefined
    }
    const executable = commandAfterOptions(args, RUNUSER_VALUE_OPTIONS)
    return executable?.length ? { payload: executable.join(" "), reparsed: false } : undefined
  }
  if (command === "pkexec") {
    const executable = commandAfterOptions(args, PKEXEC_VALUE_OPTIONS)
    return executable?.length ? { payload: executable.join(" "), reparsed: false } : undefined
  }
  if (command === "nsenter") {
    const executable = commandAfterOptions(args, NSENTER_VALUE_OPTIONS)
    return executable?.length ? { payload: executable.join(" "), reparsed: false } : undefined
  }
  if (command === "docker" || command === "podman") {
    const subcommandIndex = args.findIndex((word) => word === "exec" || word === "run" || word === "create")
    if (subcommandIndex === -1) return
    const subcommand = args[subcommandIndex]
    const valueOptions = subcommand === "exec" ? CONTAINER_EXEC_VALUE_OPTIONS : CONTAINER_RUN_VALUE_OPTIONS
    const containerArgs = args.slice(subcommandIndex + 1)
    const parsed = containerCommandAfterOptions(containerArgs, valueOptions)
    if (parsed.opaque) return { opaque: true }
    if (!parsed.executable?.length) return
    const executable = parsed.executable.slice(1)
    if (executable[0] === "--") executable.shift()
    const entrypoint = subcommand === "exec" ? undefined : parsed.entrypoint
    const payload = entrypoint ? [entrypoint, ...executable] : executable
    return payload.length ? { payload: payload.join(" "), reparsed: false } : undefined
  }
}

function indirectPayloadMayInvokeSudo(
  payload: string,
  reparsed: boolean,
  state: ClassificationState,
  depth: number,
): boolean {
  if (reparsed) return reparsePayloadMayInvokeSudo(payload, state, depth)
  const parsed = simpleCommandParts(controlCommandSegment(payload))
  if (parsed.name && dynamicCommandName(parsed.name)) return true
  return hasSudoInvocationRecursive(payload, state, depth)
}

function shellPayloadWithEnabledExecfail(segment: string): string | undefined {
  let words = shellWords(normalizeCommand(separateAttachedInputRedirects(segment)))
  let index = 0
  let enabled = false
  const inspectAssignments = (assignments: string[]): void => {
    enabled ||= assignments.some((assignment) => /^BASHOPTS=(?:[^:]*:)*execfail(?:[:]|$)/.test(assignment))
  }

  while (words[index]?.includes("=") && !words[index]?.startsWith("-")) index++
  inspectAssignments(words.slice(0, index))

  // Lookup-only `command -v` / `-V` never executes, and `builtin <name>` errors
  // for non-builtin targets, so both stay inert. Transparent wrappers (`exec`,
  // `nice`, `timeout`, ...) forward the wrapped command unchanged, so
  // `bash -O execfail` behind them still activates replay analysis.
  for (let depth = 0; depth < DIRECTORY_CHANGE_MAX_DEPTH; depth++) {
    while (words[index] === "command" || words[index] === "builtin") {
      const prefix = words[index++]
      if (prefix === "command") {
        while (index < words.length) {
          const option = words[index]
          if (option === "--path") {
            index += 2
            continue
          }
          if (option?.startsWith("--path=")) {
            index++
            continue
          }
          if (/^-[pP]+$/.test(option ?? "")) {
            index++
            continue
          }
          if (/^-[pPvV]+$/.test(option ?? "")) return undefined
          break
        }
      } else if (!SHELL_BUILTIN_COMMANDS.has(commandBasename(words[index] ?? ""))) {
        return undefined
      }
      if (words[index] === "--") index++
    }

    const name = commandBasename(words[index] ?? "")
    if (name === "env") {
      const expanded = expandEnvSplitString(words, index)
      if (expanded) {
        words = expanded
        let assignmentEnd = index
        while (words[assignmentEnd]?.includes("=") && !words[assignmentEnd]?.startsWith("-")) assignmentEnd++
        inspectAssignments(words.slice(index, assignmentEnd))
        index = assignmentEnd
        continue
      }
      const envArgs = words.slice(index + 1)
      const commandIndex = envDirectoryChange(envArgs).commandIndex
      inspectAssignments(envArgs.slice(0, commandIndex))
      index += commandIndex + 1
      continue
    }

    if (name === "script") {
      // BSD/macOS positional form: `script [options] file command ...`.
      // The first positional is the output file; the wrapped command follows.
      const after = wrapperCommandArgs(name, words.slice(index + 1))
      if (!words[index + 2 + after.commandIndex]) return undefined
      index += 2 + after.commandIndex
      continue
    }

    if (MULTICALL_COMMANDS.has(name)) {
      const rest = words.slice(index + 1)
      const applet = multicallCommandParts(rest)
      if (!applet.name) return undefined
      index += rest.length - applet.args.length
      continue
    }

    if (!EXECFAIL_TRANSPARENT_WRAPPERS.has(name)) break
    const wrapped = wrapperCommandArgs(name, words.slice(index + 1))
    if (!wrapped.name) return undefined
    index += 1 + wrapped.commandIndex
  }

  const shellName = commandBasename(words[index] ?? "")
  if (!isShellPayloadCommand(shellName)) return
  const args = words.slice(index + 1)
  const optionEnd = bashOptionRegionEnd(args)
  const optionRegion = args.slice(0, optionEnd === -1 ? args.length : optionEnd + 1)
  for (let optionIndex = 0; optionIndex < optionRegion.length; optionIndex++) {
    const word = optionRegion[optionIndex]
    // `-Oexecfail` is rejected by bash 3.2 (the `-O` value is taken from the
    // next word) but kept conservative here for version portability.
    if (word === "-Oexecfail") enabled = true
    if (word === "-O" && optionRegion[optionIndex + 1] === "execfail") enabled = true
  }
  // Interactive shells keep running after a failed `exec`, so fd replay after
  // it is executable regardless of execfail.
  if (bashInteractiveOption(args)) enabled = true
  const payload = shellPayload(args)
  return enabled ? payload : undefined
}

function hasSudoCommandParts(
  name: string | undefined,
  args: string[],
  state: ClassificationState,
  depth: number,
): boolean {
  if (classificationExhausted(state) || depth > DIRECTORY_CHANGE_MAX_DEPTH) return true
  if (!name) return false
  if (dynamicCommandName(name)) return true
  const command = commandBasename(commandNameWithoutEmptySubstitutions(name) ?? "")
  if (command === "sudo" || command === "sudoedit" || command === "doas") return true
  if (command === "env") {
    const expanded = expandEnvSplitString([command, ...args], 0)
    if (expanded) return hasSudoCommandParts(expanded[0], expanded.slice(1), state, depth + 1)
    const commandIndex = envDirectoryChange(args).commandIndex
    return hasSudoCommandParts(args[commandIndex], args.slice(commandIndex + 1), state, depth + 1)
  }
  if (MULTICALL_COMMANDS.has(command)) {
    const applet = multicallCommandParts(args)
    return hasSudoCommandParts(applet.name, applet.args, state, depth + 1)
  }
  if (command === "ssh" || command === "mosh") {
    const remote = remoteCommandPayload(args)
    return Boolean(remote && reparsePayloadMayInvokeSudo(remote, state, depth + 1))
  }
  if (isShellPayloadCommand(command)) {
    const payload = shellPayload(args)
    if (payload) return reparsePayloadMayInvokeSudo(payload, state, depth + 1)
    const stdinPayload = shellHerestringPayload(args)
    return Boolean(stdinPayload && reparsePayloadMayInvokeSudo(stdinPayload, state, depth + 1))
  }
  if (command === "eval" && args.length > 0) {
    return reparsePayloadMayInvokeSudo(args.join(" "), state, depth + 1)
  }
  if (command === "trap") {
    const payload = trapPayload(args)
    return Boolean(payload && reparsePayloadMayInvokeSudo(payload, state, depth + 1))
  }
  const stdinPayload = shellHerestringPayload(args)
  if (stdinPayload && executesStdinAsCode(command, args)) {
    return (
      hasInlineSudoExecution(stdinPayload, state, depth) || hasSudoInvocationRecursive(stdinPayload, state, depth + 1)
    )
  }
  if (hasInlineInterpreterPayload(command, args)) {
    const payload = args.join(" ")
    return hasInlineSudoExecution(payload, state, depth) || hasSudoInvocationRecursive(payload, state, depth + 1)
  }
  const indirect = indirectExecutionPayload(command, args)
  if (indirect) {
    if ("opaque" in indirect) return true
    return indirectPayloadMayInvokeSudo(indirect.payload, indirect.reparsed, state, depth + 1)
  }
  if (!DIRECTORY_WRAPPER_COMMANDS.has(command)) return false
  const wrapped = wrapperCommandParts(command, args)
  return hasSudoCommandParts(wrapped.name, wrapped.args, state, depth + 1)
}

function hasSudoInvocationRecursive(command: string, state: ClassificationState, depth: number): boolean {
  if (classificationExhausted(state, command) || depth > DIRECTORY_CHANGE_MAX_DEPTH) return true

  const normalized = normalizeCommand(command)
  if (state.activeInputs.has(normalized)) return true
  state.activeInputs.add(normalized)
  try {
    if (stdinHeredocMayInvokeSudo(command, state, depth)) return true
    if (heredocDataFlowMayInvokeSudo(command, state, depth)) return true
    if (processSubstitutionMayFeedExecutable(command, state, depth)) return true

    const substitutions = commandSubstitutionPayloads(normalized, state)
    if (!substitutions) return true
    if (substitutions.some((payload) => hasSudoInvocationRecursive(payload, state, depth + 1))) return true

    const compound = lexCompoundCommands(normalized)
    const segments = compound.segments.length > 0 ? compound.segments : [normalized]
    return segments.some((segment) => {
      const execfailPayload = shellPayloadWithEnabledExecfail(segment)
      if (execfailPayload && reparsePayloadMayInvokeSudo(`shopt -s execfail\n${execfailPayload}`, state, depth + 1)) {
        return true
      }
      const functionBody = functionDefinitionBody(segment)
      if (functionBody !== undefined) {
        return functionBody ? hasSudoInvocationRecursive(functionBody, state, depth + 1) : false
      }
      if (commandLookupOnly(segment)) return false
      const parsed = simpleCommandParts(controlCommandSegment(segment))
      return hasSudoCommandParts(parsed.name, parsed.args, state, depth)
    })
  } finally {
    state.activeInputs.delete(normalized)
  }
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
    const padded = " " + normalizeCommand(command) + " "
    const normalized = stripAllowedRedirects(padded)
    const lower = normalized.toLowerCase()
    if (UNSAFE_SHELL_TOKENS.some((token) => lower.includes(token))) return false

    const segments = lexCompoundCommands(normalized.trim()).segments

    if (segments.length === 0) return true
    return segments.every(isSafeSimpleCommand)
  }

  export function analyzeDirectoryChanges(
    command: string,
    options: DirectoryChangeOptions = {},
  ): DirectoryChangeAnalysis {
    const ctx: DirectoryChangeContext = {
      options,
      cdpathDefined: commandDefinesCdpath(command),
    }
    return analyzeDirectoryChangesRecursive(command, newClassificationState(), 0, ctx)
  }

  export function hasCompoundShellStateDependency(command: string): boolean {
    const compound = lexCompoundCommands(normalizeCommand(command))
    const state = newClassificationState()
    return compound.segments.some((segment, index) => {
      if (index > 0) return hasReparsedLastArgumentReference(segment, state, 0)
      if (compound.segments.length < 2) return false

      const parsed = simpleCommandParts(controlCommandSegment(segment))
      if (commandBasename(parsed.name ?? "") !== "trap") return false
      const payload = trapPayload(parsed.args)
      return Boolean(payload && hasReparsedLastArgumentReference(payload, state, 0))
    })
  }

  export function hasSudoInvocation(command: string): boolean {
    return hasSudoInvocationRecursive(command, newClassificationState(), 0)
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

  function conservativeRisk(): BashRisk {
    return "shell"
  }

  export function classifyCompoundRisk(command: string): BashRisk {
    return classifyRisk(command, newClassificationState(), 0)
  }

  // ── heredoc scanning ─────────────────────────────────────────────────

  function scanHeredocBody(command: string, state: ClassificationState, depth: number): BashRisk | null {
    for (const heredoc of extractShellHeredocBodies(command)) {
      if (Date.now() > state.deadline) return conservativeRisk()
      if (
        !heredoc.effective ||
        normalizeFileDescriptor(heredoc.fd) !== "0" ||
        !heredocHeaderExecutesStdin(heredoc.header)
      )
        continue

      const bodyRisk = depth >= MAX_COMPOUND_DEPTH ? conservativeRisk() : classifyRisk(heredoc.body, state, depth + 1)
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
    if (hasUnsafeExecTarget(normalized, state)) return "shell_destructive"
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
