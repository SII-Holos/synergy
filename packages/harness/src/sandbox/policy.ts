import { RuntimeContext } from "../lifecycle/context"
import { normalizeSlashes } from "../util/path"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ------------------------------------------------------------------
// Sandbox policy constants and helpers
//
// Shared by both macOS (Seatbelt) and Linux (bwrap) backends.
// ------------------------------------------------------------------

export const DEFAULT_SYSTEM_RUNTIME_READ_ROOTS = ["/usr/lib", "/System/Library", "/bin", "/usr/bin"]

/**
 * Developer-toolchain read roots for macOS sandbox profiles. Homebrew
 * (`/opt/homebrew` on Apple Silicon, `/usr/local` on Intel) hosts the git,
 * language runtimes, and package managers a developer shell actually uses;
 * `/Library/Developer/CommandLineTools` and `/private/etc` cover CLT tools and
 * TLS/ssl configuration. `/var/select` holds the /bin/sh selector symlink
 * that picks the bash variant — deny-default profiles must read it or every
 * wrapped command fails to start its interpreter. Only meaningful on darwin;
 * other platforms ignore it.
 */
export const MACOS_DEVELOPER_READ_ROOTS = [
  "/opt/homebrew",
  "/usr/local",
  "/Library/Developer/CommandLineTools",
  "/etc",
  "/private/etc",
  "/var/select",
  "/private/var/select",
]

export function macosPlatformReadRoots(): string[] {
  return [...MACOS_DEVELOPER_READ_ROOTS]
}

export function pathFlavor(root: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") ? path.win32 : path.posix
}

export function joinPathLike(root: string, ...parts: string[]): string {
  return pathFlavor(root).join(root, ...parts)
}

export const DEFAULT_USER_RUNTIME_READ_ROOTS = (homedir: string): string[] => [
  joinPathLike(homedir, ".gitconfig"),
  joinPathLike(homedir, ".config", "git"),
  joinPathLike(homedir, ".bun"),
  joinPathLike(homedir, ".synergy", "cache"),
  joinPathLike(homedir, "Library", "Caches", "bun"),
  joinPathLike(homedir, "Library", "Caches", "com.oven-sh.bun"),
]

export function defaultRuntimeReadRoots(homedir: string): string[] {
  return [...DEFAULT_SYSTEM_RUNTIME_READ_ROOTS, ...DEFAULT_USER_RUNTIME_READ_ROOTS(homedir)]
}

export function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots.filter(Boolean))]
}

export function gitProtectedSubpaths(root: string): string[] {
  return [joinPathLike(root, ".git", "hooks"), joinPathLike(root, ".git", "config")]
}

/**
 * Expand bare `<root>/.git` entries into the granular read-only subpaths
 * (hooks + config) so git index/object/ref writes keep working under a
 * writable root while the tamper/code-execution surface stays protected.
 */
export function expandGitProtectedSubpaths(paths: string[]): string[] {
  return uniqueRoots(
    paths.flatMap((p) => {
      const flavor = pathFlavor(p)
      return flavor.basename(p) === ".git" ? gitProtectedSubpaths(flavor.dirname(p)) : [p]
    }),
  )
}

/**
 * Enumerated sandbox read grants for a linked git worktree session.
 *
 * A worktree resolves its object store through the original checkout's .git
 * directory, which the trust boundary keeps external — under deny-default
 * sandbox profiles every git command would fail with "not a git repository".
 * Rather than granting the whole shared .git directory (which would expose
 * hooks and executable configuration) or the per-worktree gitdir directory
 * (which would expose that worktree's reflogs and fetch metadata), this
 * returns the enumerated files and store paths git read commands need:
 *
 * - per-worktree files: HEAD, commondir, and the gitdir backlink (required
 *   for git to recognize a linked worktree at all), plus index, ORIG_HEAD,
 *   and config.worktree when present;
 * - common store: objects and refs directories, plus config, packed-refs,
 *   info/exclude, and info/attributes when present. Config is required — git
 *   refuses to run without reading it — and carries the same risk as the
 *   already-granted ~/.gitconfig; info/exclude and info/attributes keep
 *   repository-local ignore rules authoritative so `git status` does not
 *   report locally ignored files as untracked.
 *
 * File grants are existence-filtered so backends that bind every readable
 * root (the Linux helper) never receive a missing source, which would fail
 * every command before git starts. Unread optional files simply stay denied.
 *
 * Every grant is fail-closed: the worktree .git pointer file must resolve
 * inside <originalCheckout>/.git/worktrees/, its commondir must resolve
 * exactly to <originalCheckout>/.git, and the metadata entry's gitdir
 * backlink must resolve exactly to this workspace's .git pointer — a pointer
 * aimed at a sibling worktree's metadata entry yields an empty set. Any
 * mismatch (or a directory-style .git, i.e. not actually a linked worktree)
 * returns no grants. Granted paths are read-only; common-store writes
 * (index.lock, objects, refs) stay outside the sandbox writable roots, so
 * commits fail with a lock error instead of silently corrupting the shared
 * store.
 */
export function worktreeSandboxReadGrants(workspace: string, originalCheckout?: string): string[] {
  if (!originalCheckout) return []
  const flavor = pathFlavor(workspace)
  const pointer = flavor.resolve(workspace, ".git")
  let gitdirLine: string
  try {
    if (!fs.statSync(pointer).isFile()) return []
    gitdirLine = fs.readFileSync(pointer, "utf8").trim()
  } catch {
    return []
  }
  if (!gitdirLine.startsWith("gitdir:")) return []
  const gitdir = flavor.resolve(workspace, gitdirLine.slice("gitdir:".length).trim())

  const checkout = flavor.resolve(originalCheckout)
  const metaRoot = joinPathLike(checkout, ".git", "worktrees")
  const rel = flavor.relative(metaRoot, gitdir)
  if (!rel || flavor.isAbsolute(rel) || rel.split(/[\\/]/).some((segment) => segment === "..")) return []

  const commondirPath = joinPathLike(gitdir, "commondir")
  let commonRaw: string
  try {
    commonRaw = fs.readFileSync(commondirPath, "utf8").trim()
  } catch {
    return []
  }
  const common = flavor.resolve(gitdir, commonRaw)
  if (common !== joinPathLike(checkout, ".git")) return []

  let backlinkRaw: string
  try {
    backlinkRaw = fs
      .readFileSync(joinPathLike(gitdir, "gitdir"), "utf8")
      .trim()
      .replace(/[\\/]+$/, "")
  } catch {
    return []
  }
  if (flavor.resolve(gitdir, backlinkRaw) !== pointer) return []

  const existingFile = (p: string): string[] => {
    try {
      return fs.statSync(p).isFile() ? [p] : []
    } catch {
      return []
    }
  }
  return uniqueRoots([
    ...[
      joinPathLike(gitdir, "HEAD"),
      commondirPath,
      joinPathLike(gitdir, "gitdir"),
      joinPathLike(gitdir, "index"),
      joinPathLike(gitdir, "ORIG_HEAD"),
      joinPathLike(gitdir, "config.worktree"),
    ].flatMap(existingFile),
    joinPathLike(common, "objects"),
    joinPathLike(common, "refs"),
    ...[
      joinPathLike(common, "config"),
      joinPathLike(common, "packed-refs"),
      joinPathLike(common, "info", "exclude"),
      joinPathLike(common, "info", "attributes"),
    ].flatMap(existingFile),
  ])
}

export function ancestorLiterals(root: string): string[] {
  const flavor = pathFlavor(root)
  const resolved = flavor.resolve(root)
  const result: string[] = []
  let current = resolved
  while (current && current !== flavor.dirname(current)) {
    result.push(current)
    current = flavor.dirname(current)
  }
  result.push(current || flavor.parse(resolved).root)
  return result.reverse()
}

export function traversalLiterals(roots: string[]): string[] {
  return uniqueRoots(roots.flatMap((root) => ancestorLiterals(root)))
}

/**
 * Controlled temporary write root for sandboxed autonomous execution.
 *
 * Reuses the existing controlled-tmp precedent (Linux helper binds
 * `<workspace>/.synergy/tmp` onto /tmp; the legacy macOS Seatbelt profile
 * lists it as a writable root). When a session key is supplied the root is
 * further isolated per session/process (glob-expand naming precedent
 * `synergy-glob-{pid}-{id}`), so concurrent sandboxed shells cannot peek at
 * each other's temporary files through TMPDIR.
 */
export function controlledTempRoot(workspace: string, sessionKey?: string): string {
  const base = joinPathLike(workspace, ".synergy", "tmp")
  if (!sessionKey) return base
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)
  return joinPathLike(base, `synergy-${process.pid}-${safeKey}`)
}

// ------------------------------------------------------------------
// Credential-bearing paths that must ALWAYS be protected inside any sandbox.
// Each path is read-only mounted (or denied writes on macOS) unconditionally.
//
// Lessons from real-world sandbox escapes:
//   - Cymulate 2026: Gemini CLI OAuth leak via ~/.gemini/oauth_creds.json mounted RW
//   - CBSE (Cross-Agent Sandbox Bypass Exploit): agent config cross-contamination
// ------------------------------------------------------------------
export const CREDENTIAL_PATHS = (homedir: string): string[] => [
  // ── Synergy internal auth secrets ───────────────────────────────
  joinPathLike(homedir, ".synergy", "data", "auth"),
  // Plugin OAuth/API tokens live under data/plugin/<id>/auth.json
  joinPathLike(homedir, ".synergy", "data", "plugin"),
  // ── Network & cloud credentials ─────────────────────────────────
  joinPathLike(homedir, ".netrc"),
  joinPathLike(homedir, ".git-credentials"),
  joinPathLike(homedir, ".ssh"),
  joinPathLike(homedir, ".gnupg"),
  joinPathLike(homedir, ".aws"),
  joinPathLike(homedir, ".azure"),
  joinPathLike(homedir, ".kube"),
  joinPathLike(homedir, ".config", "gcloud"),
  joinPathLike(homedir, ".docker", "config.json"),
  joinPathLike(homedir, ".npmrc"),
  // ── Shell configs (prevent command injection) ────────────────────
  joinPathLike(homedir, ".bashrc"),
  joinPathLike(homedir, ".zshrc"),
  joinPathLike(homedir, ".profile"),
  joinPathLike(homedir, ".bash_profile"),
  joinPathLike(homedir, ".zprofile"),
  // ── Other agent configs ─────────────────────────────────────────
  joinPathLike(homedir, ".cursor"),
  joinPathLike(homedir, ".claude"),
  joinPathLike(homedir, ".codex"),
  joinPathLike(homedir, ".gemini"),
]

/**
 * Credential-bearing paths deliberately kept readable under the deny-list
 * read model. kubectl and docker load their config stores at startup with
 * no credential-injection fallback (a kubeconfig embeds client certs and
 * tokens; docker reads config.json for registry auth), so denying the
 * store breaks the tool outright. Operator decision 2026-09-14: tool
 * compatibility first; write protection is unaffected because these stay
 * in CREDENTIAL_PATHS. Flip back to strict read denial by shrinking this
 * list.
 */
const READ_EXEMPT_CREDENTIAL_PATHS = (homedir: string): string[] => [
  joinPathLike(homedir, ".kube"),
  joinPathLike(homedir, ".docker", "config.json"),
]

/**
 * Paths that stay unreadable under the deny-list read model, where file reads
 * are allowed globally and only credential-bearing locations are denied.
 * Everything in CREDENTIAL_PATHS is included except the tool-compatibility
 * exemptions above, plus registry token files, browser/mail data stores, and
 * Synergy's own runtime stores that the global read allow would otherwise
 * expose (cookie jars, session stores, local mail databases, token files).
 *
 * Linux spellings are listed explicitly because Linux now reads globally too:
 * these stores were previously hidden only by the old `--tmpfs /` fallback,
 * and nothing else denies them. `~/.config/gh` is deliberately NOT denied: gh
 * hard-fails when it cannot read hosts.yml as configuration even when
 * GH_TOKEN is present, keyring mode keeps the token out of that directory,
 * and the Bash tool injects the managed credential as GH_TOKEN for gh
 * invocations.
 *
 * `~/.synergy/log`, `~/.synergy/state`, and `~/.synergy/data/library.db` are
 * denied as part of that same group: a sandboxed command is an untrusted
 * child, the directory is not a sandbox read root (only `~/.synergy/cache` is,
 * and solely so stage 2 can re-read the staged profile), and no sandboxed tool
 * consumes them — the runtime does, on the host side of the boundary.
 */
export const READ_DENY_PATHS = (homedir: string): string[] => [
  ...CREDENTIAL_PATHS(homedir).filter((p) => !READ_EXEMPT_CREDENTIAL_PATHS(homedir).includes(p)),
  joinPathLike(homedir, ".cargo", "credentials.toml"),
  joinPathLike(homedir, ".cargo", "credentials"),
  joinPathLike(homedir, ".mozilla"),
  joinPathLike(homedir, "Library", "Cookies"),
  joinPathLike(homedir, "Library", "Mail"),
  joinPathLike(homedir, "Library", "Application Support", "Firefox"),
  joinPathLike(homedir, "Library", "Application Support", "Google", "Chrome"),
  joinPathLike(homedir, "Library", "Application Support", "Microsoft Edge"),
  joinPathLike(homedir, "Library", "Application Support", "BraveSoftware"),
  // ── Linux credential and session stores ─────────────────────────
  joinPathLike(homedir, ".zsh_history"),
  joinPathLike(homedir, ".bash_history"),
  joinPathLike(homedir, ".config", "google-chrome"),
  joinPathLike(homedir, ".config", "chromium"),
  joinPathLike(homedir, ".config", "BraveSoftware"),
  joinPathLike(homedir, ".config", "vivaldi"),
  joinPathLike(homedir, ".thunderbird"),
  joinPathLike(homedir, ".local", "share", "keyrings"),
  joinPathLike(homedir, ".password-store"),
  joinPathLike(homedir, ".config", "rclone", "rclone.conf"),
  joinPathLike(homedir, ".terraform.d", "credentials.tfrc.json"),
  joinPathLike(homedir, ".my.cnf"),
  joinPathLike(homedir, ".pgpass"),
  joinPathLike(homedir, ".config", "wrangler"),
  // ── Synergy runtime stores (token, session, and log state) ──────
  joinPathLike(homedir, ".synergy", "data", "browser", "profiles"),
  joinPathLike(homedir, ".synergy", "cache", "inspire-token.json"),
  joinPathLike(homedir, ".synergy", "data", "library.db"),
  joinPathLike(homedir, ".synergy", "log"),
  joinPathLike(homedir, ".synergy", "state"),
  joinPathLike(homedir, ".synergy", "config", "skills"),
]

/** Credential roots include both the OS user and the explicitly selected Runtime home. */
export function readDenyHomeDirs(): string[] {
  return uniqueRoots([os.homedir(), RuntimeContext.current().host.home])
}

/**
 * Credential and sensitive read denies for a workspace.
 *
 * The single owner of the deny-list read model's deny set, shared by every
 * backend that allows ordinary reads globally (macOS Seatbelt, the Linux
 * helper's full-read bind) so the platforms cannot drift apart.
 *
 * Denies are derived from every read-deny home — the OS home plus the Synergy
 * runtime home when it differs — so custom SYNERGY_HOME installs keep their
 * provider/MCP/account/plugin stores protected, and explicit non-default deny
 * roots merge in.
 *
 * The set is deliberately a function of the workspace and the explicit deny
 * roots alone: no writable root can prune an entry. Treating a writable root
 * as grounds to drop the denies it contains collapsed the whole set to zero
 * whenever a Scope directory resolved to the home directory (or the home
 * directory was added as a project folder), leaving `~/.ssh`, `~/.aws`,
 * `~/.synergy/data/auth`, and `~/.netrc` readable — and on Linux there is no
 * `--tmpfs /` fallback left to hide them. Backends are responsible for making
 * each kept deny effective by mount or rule order; they must not be handed a
 * set that already gave up.
 *
 * The one entry dropped is a deny EQUAL to the workspace: a Scope directory
 * rooted exactly at a credential path cannot deny itself without making the
 * project's own files unreadable. A deny strictly inside the workspace is
 * kept, because an explicitly denied subdirectory is operator intent, not a
 * collision, and the ordering rule enforces it.
 */
export function readDenyPathsFor(input: { workspace: string; extraDenyPaths?: string[] }): string[] {
  const workspaceScope = normalizeSlashes(input.workspace)
  const defaultHomeDeny = normalizeSlashes(os.homedir())
  const explicitDenyPaths = (input.extraDenyPaths ?? []).filter((p) => normalizeSlashes(p) !== defaultHomeDeny)
  return uniqueRoots([...readDenyHomeDirs().flatMap((home) => READ_DENY_PATHS(home)), ...explicitDenyPaths]).filter(
    (p) => normalizeSlashes(p) !== workspaceScope,
  )
}

/**
 * Split read denies into the ones a backend must emit BEFORE a writable root's
 * allow and the ones it must emit AFTER it.
 *
 * Both backends resolve an overlapping allow and deny by rule order, not by
 * specificity: Seatbelt applies the last matching rule and bwrap applies the
 * last mount, so which one is emitted second decides the outcome. Ordering
 * therefore has to follow containment:
 *
 * - a deny CONTAINING a writable root is emitted before it, so the deeper
 *   writable allow wins and a workspace nested inside a credential directory
 *   keeps working while its credential siblings stay denied;
 * - a deny equal to or INSIDE a writable root is emitted after it, so the deny
 *   wins; a deny equal to a writable root is fail-closed this way.
 *
 * Without the second half, a writable root re-exposes every deny inside it —
 * which is exactly why the deny set used to prune those entries, and why
 * restoring them requires this ordering. Callers must canonicalize both sides
 * in the same spelling the rules are emitted in.
 */
export function partitionDeniesByWritableRoot(
  denies: string[],
  writableRoots: string[],
): { beforeWritableRoots: string[]; afterWritableRoots: string[] } {
  const roots = writableRoots.map((root) => normalizeSlashes(root).replace(/\/+$/, ""))
  const insideWritableRoot = (deny: string) => {
    const candidate = normalizeSlashes(deny).replace(/\/+$/, "")
    return roots.some((root) => candidate === root || candidate.startsWith(root + "/"))
  }
  return {
    beforeWritableRoots: denies.filter((deny) => !insideWritableRoot(deny)),
    afterWritableRoots: denies.filter(insideWritableRoot),
  }
}
export const PROTECTED_METADATA_PATH_NAMES = [".git", ".agents", ".codex"]

/**
 * Check if a target path would be denied write access because it falls inside
 * a protected metadata directory under any writable root.
 *
 * Mirrors Codex's `forbidden_agent_metadata_write()`.
 */
export function isMetadataWriteDenied(
  writableRoots: string[],
  targetPath: string,
  customProtectedNames?: string[],
): { denied: true; path: string; metadataName: string } | { denied: false } {
  const names = customProtectedNames ?? PROTECTED_METADATA_PATH_NAMES
  const normalizedTarget = normalizeSlashes(targetPath)

  for (const root of writableRoots) {
    const normalizedRoot = normalizeSlashes(root)
    if (!normalizedTarget.startsWith(normalizedRoot + "/") && normalizedTarget !== normalizedRoot) continue
    for (const name of names) {
      const protectedFullPath = joinPathLike(root, name)
      const normalizedProtected = normalizeSlashes(protectedFullPath)
      if (normalizedTarget === normalizedProtected || normalizedTarget.startsWith(normalizedProtected + "/")) {
        return { denied: true, path: targetPath, metadataName: name }
      }
    }
  }
  return { denied: false }
}

export const DEFAULT_PROTECTED_PATHS = (homedir: string, workspace: string): string[] => [
  joinPathLike(workspace, ".git"),
  ...CREDENTIAL_PATHS(homedir),
]
/**
 * Returns the subset of protectedPaths that fall under any writableRoot.
 *
 * These paths need explicit read-only subpath overrides because otherwise
 * they would be writable by virtue of being inside a writable root mount.
 */
export function protectedMetadataUnderWritableRoot(
  writableRoots: string[],
  protectedPaths: string[],
  workspace: string,
): string[] {
  return protectedPaths.filter((pp) => {
    const resolved = normalizeSlashes(pp).replace(/\/+$/, "")
    return writableRoots.some((root) => {
      const resolvedRoot = normalizeSlashes(root).replace(/\/+$/, "")
      return resolved.startsWith(resolvedRoot + "/") || resolved === resolvedRoot
    })
  })
}

// ------------------------------------------------------------------
// ReadDenyMatcher — Runtime glob deny-read matching
// ------------------------------------------------------------------

/**
 * Escape a single character for use in a JavaScript regex.
 */
function escapeRegexChar(c: string): string {
  const specials = new Set([".", "+", "^", "$", "(", ")", "[", "]", "|", "\\"])
  return specials.has(c) ? "\\" + c : c
}

/**
 * Find the matching closing brace for a brace expansion starting at `start`.
 */
function findMatchingBrace(s: string, start: number): number {
  let depth = 1
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "{") depth++
    else if (s[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split a brace expansion body on top-level commas, respecting nesting.
 */
function splitBraceAlternatives(s: string): string[] {
  const result: string[] = []
  let depth = 0
  let current = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === "," && depth === 0) {
      result.push(current)
      current = ""
      continue
    }
    current += c
  }
  result.push(current)
  return result
}

/**
 * Compile the body of a glob (without anchors or depth prefix) into a regex fragment.
 */
function compileGlobFragment(glob: string): string {
  let result = ""
  let i = 0

  while (i < glob.length) {
    const c = glob[i]

    if (c === "*" && i + 1 < glob.length && glob[i + 1] === "*") {
      result += ".*"
      i += 2
      if (i < glob.length && glob[i] === "/") {
        result += "/"
        i += 1
      }
    } else if (c === "*") {
      result += "[^/]*"
      i += 1
    } else if (c === "?") {
      result += "[^/]"
      i += 1
    } else if (c === "{") {
      const closing = findMatchingBrace(glob, i)
      if (closing === -1) {
        result += escapeRegexChar(c)
        i += 1
        continue
      }
      const inner = glob.slice(i + 1, closing)
      const alternatives = splitBraceAlternatives(inner)
      const compiled = alternatives.map((a) => compileGlobFragment(a))
      result += "(" + compiled.join("|") + ")"
      i = closing + 1
    } else {
      result += escapeRegexChar(c)
      i += 1
    }
  }

  return result
}

/**
 * Compile a git-style glob pattern into a JavaScript RegExp.
 *
 * Glob semantics:
 *   **  → .*  (any directory depth including zero)
 *   *   → [^/]*  (single path component, non-slash)
 *   ?   → [^/]
 *   {a,b} → (a|b)
 *
 * Patterns that do not start with ** are prefixed with a directory-depth prefix to match
 * at any directory depth, consistent with gitignore default semantics.
 *
 * Returns null if compilation fails (invalid regex syntax).
 */
function compileGlobToRegex(glob: string): RegExp | null {
  try {
    const startsWithGlobstar = glob.startsWith("**")
    const body = compileGlobFragment(glob)
    const anchored = startsWithGlobstar ? body : "(.*/)?" + body
    return new RegExp("^" + anchored + "$")
  } catch {
    return null
  }
}

/**
 * Runtime matcher for deny-read rules.
 *
 * Combines exact-path rejection (unreadableRoots) with glob-pattern
 * rejection (unreadableGlobs). Designed for use in non-Seatbelt
 * sandbox backends (e.g. Windows) where kernel-level deny rules
 * are not available and must be enforced in-process.
 *
 * Fail-closed: if any glob fails to compile, all paths are denied.
 */
export class ReadDenyMatcher {
  private deniedCandidates: Set<string>
  private denyReadMatchers: RegExp[]
  private failedCompilation: boolean

  constructor(unreadableGlobs: string[], unreadableRoots: string[]) {
    this.deniedCandidates = new Set(unreadableRoots.map((r) => normalizeSlashes(r)))
    this.denyReadMatchers = []
    this.failedCompilation = false

    for (const glob of unreadableGlobs) {
      const regex = compileGlobToRegex(glob)
      if (!regex) {
        this.failedCompilation = true
        break
      }
      this.denyReadMatchers.push(regex)
    }
  }

  /**
   * Check whether a path is denied for reading.
   * Returns true if the path matches any deny rule.
   * Fail-closed: returns true if any glob failed to compile.
   */
  isDenied(filepath: string): boolean {
    if (this.failedCompilation) return true
    const normalized = normalizeSlashes(filepath)
    if (this.deniedCandidates.has(normalized)) return true
    return this.denyReadMatchers.some((r) => r.test(normalized))
  }

  /**
   * Filter a batch of paths, returning only the denied subset.
   */
  isDeniedBatch(paths: string[]): string[] {
    return paths.filter((p) => this.isDenied(p))
  }
}
