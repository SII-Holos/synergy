import { $ } from "bun"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { parse as parseJsonc } from "jsonc-parser"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { isDefaultTitle } from "@ericsanchezok/synergy-harness/session/title"
import type { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { fn } from "@ericsanchezok/synergy-harness/util/fn"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { isPathContained } from "@ericsanchezok/synergy-harness/util/path-contain"

export namespace Worktree {
  export const Owner = z.discriminatedUnion("type", [
    z.object({ type: z.literal("session"), sessionID: z.string() }),
    z.object({
      type: z.literal("superplan"),
      runID: Identifier.schema("superplan_run"),
      nodeID: Identifier.schema("superplan_node").optional(),
      mergeID: Identifier.schema("superplan_merge").optional(),
    }),
    z.object({ type: z.literal("user") }),
    z.object({ type: z.literal("external") }),
  ])
  export type Owner = z.infer<typeof Owner>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      branch: z.string().optional(),
      path: z.string(),
      scopeID: z.string(),
      head: z.string().optional(),
      baseRef: z.string().optional(),
      baseRevision: z.string().optional(),
      resolvedBaseCommit: z.string().optional(),
      detached: z.boolean().optional(),
      bare: z.boolean().optional(),
      isMain: z.boolean().optional(),
      managed: z.boolean().optional(),
      stale: z.boolean().optional(),
      dirty: z.boolean().optional(),
      diskBytes: z.number().optional(),
      owner: Owner.optional(),
      bindings: z.array(z.string()).optional(),
      lifecycle: z.enum(["active", "detached", "gc_candidate", "deleted"]).optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
      lastUsedAt: z.number().optional(),
      setupFailed: z.boolean().optional(),
      setupError: z.string().optional(),
      locked: z.string().optional(),
      prunable: z.boolean().optional(),
    })
    .meta({ ref: "Worktree" })
  export type Info = z.infer<typeof Info>

  export const RegistryInfo = Info.extend({
    branch: z.string(),
    owner: Owner,
    bindings: z.array(z.string()),
    lifecycle: z.enum(["active", "detached", "gc_candidate", "deleted"]),
    managed: z.literal(true),
  }).meta({ ref: "WorktreeRegistryInfo" })
  export type RegistryInfo = z.infer<typeof RegistryInfo>

  export const PublicCreateInput = z
    .object({
      name: z.string().optional(),
      sessionID: z.string().optional(),
      baseRef: z.enum(["current", "fresh"]).optional().default("current"),
      baseRevision: z.string().min(1).optional(),
      bind: z.boolean().optional().default(true),
    })
    .meta({ ref: "WorktreeCreateInput" })
  export type PublicCreateInput = z.infer<typeof PublicCreateInput>

  export const CreateInput = PublicCreateInput.extend({
    owner: Owner.optional(),
  }).meta({ ref: "WorktreeInternalCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const TargetInput = z
    .object({
      sessionID: z.string(),
      target: z.string().min(1),
      force: z.boolean().optional().default(false),
    })
    .meta({ ref: "WorktreeTargetInput" })
  export type TargetInput = z.input<typeof TargetInput>

  export const RemoveInput = z
    .object({
      target: z.string().min(1),
      force: z.boolean().optional().default(false),
    })
    .meta({ ref: "WorktreeRemoveInput" })
  export type RemoveInput = z.input<typeof RemoveInput>

  export const CommandResult = z
    .object({
      title: z.string(),
      output: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
    })
    .meta({ ref: "WorktreeCommandResult" })
  export type CommandResult = z.infer<typeof CommandResult>

  const SetupInfo = z.object({
    setup: z.array(z.string()).optional().default([]),
    copyIgnored: z.array(z.string()).optional().default([]),
    env: z.record(z.string(), z.string()).optional().default({}),
  })
  export type SetupInfo = z.infer<typeof SetupInfo>

  export const NotGitError = NamedError.create("WorktreeNotGitError", z.object({ message: z.string() }))
  export const NameGenerationFailedError = NamedError.create(
    "WorktreeNameGenerationFailedError",
    z.object({ message: z.string() }),
  )
  export const CreateFailedError = NamedError.create("WorktreeCreateFailedError", z.object({ message: z.string() }))
  export const StartCommandFailedError = NamedError.create(
    "WorktreeStartCommandFailedError",
    z.object({ message: z.string() }),
  )
  export const SetupConfigError = NamedError.create("WorktreeSetupConfigError", z.object({ message: z.string() }))
  export const LockFailedError = NamedError.create("WorktreeLockFailedError", z.object({ message: z.string() }))
  export const NotFoundError = NamedError.create("WorktreeNotFoundError", z.object({ message: z.string() }))
  export const UnavailableError = NamedError.create(
    "WorktreeUnavailableError",
    z.object({
      message: z.string(),
      reason: z.literal("missing"),
    }),
  )
  export const DirtyError = NamedError.create("WorktreeDirtyError", z.object({ message: z.string() }))
  export const SessionBusyError = NamedError.create(
    "WorktreeSessionBusyError",
    z.object({ message: z.string(), sessionID: z.string() }),
  )

  const ADJECTIVES = [
    "brave",
    "calm",
    "clever",
    "cosmic",
    "crisp",
    "curious",
    "eager",
    "gentle",
    "glowing",
    "happy",
    "hidden",
    "jolly",
    "kind",
    "lucky",
    "mighty",
    "misty",
    "neon",
    "nimble",
    "playful",
    "proud",
    "quick",
    "quiet",
    "shiny",
    "silent",
    "stellar",
    "sunny",
    "swift",
    "tidy",
    "witty",
  ] as const

  const NOUNS = [
    "cabin",
    "cactus",
    "canyon",
    "circuit",
    "comet",
    "eagle",
    "engine",
    "falcon",
    "forest",
    "garden",
    "harbor",
    "island",
    "knight",
    "lagoon",
    "meadow",
    "moon",
    "mountain",
    "nebula",
    "orchid",
    "otter",
    "panda",
    "pixel",
    "planet",
    "river",
    "rocket",
    "sailor",
    "squid",
    "star",
    "tiger",
    "wizard",
    "wolf",
  ] as const

  type GitWorktreeEntry = {
    path: string
    head?: string
    branch?: string
    detached?: boolean
    bare?: boolean
    /** Git's `locked` line value, verbatim: "" when locked without a reason. */
    locked?: string
    /** Git translates the `prunable` reason, so only the line's presence is recorded. */
    prunable?: boolean
  }

  export interface LockResult {
    acquired: boolean
    /** true when git reported that the worktree was already locked before this call. */
    existing: boolean
    /** true when the lock already on disk carries this repository's own marker. */
    markerOwner?: boolean
  }

  interface LockState {
    count: number
    synergyAcquired: boolean
    /** A Synergy marker is provenance, not proof this process owns the lock. */
    markerOwner: boolean
    reason?: string
  }

  interface UseState {
    removing: boolean
    active: Map<symbol, string | undefined>
  }

  const activeLocks = new Map<string, LockState>()
  const activeUses = new Map<string, UseState>()
  const registryMutations = new Map<string, Promise<void>>()

  let sweepRequester: ((scope: Scope.Project) => void) | undefined

  /**
   * Let the owner of the worktree janitor ask for a cap sweep after a worktree
   * is created. This module owns the cap; it does not own when to run it, the
   * configuration, or the timer, so the requester is injected rather than
   * imported. A requester must never throw or block: creation has already
   * succeeded, so cleanup failing is not creation failing.
   */
  export function setSweepRequester(requester: ((scope: Scope.Project) => void) | undefined) {
    sweepRequester = requester
  }

  function requestSweep(scope: Scope.Project) {
    try {
      sweepRequester?.(scope)
    } catch (error) {
      log.warn("worktree sweep request failed", { scopeID: scope.id, error })
    }
  }

  function useState(directory: string) {
    const resolved = path.resolve(directory)
    const existing = activeUses.get(resolved)
    if (existing) return { resolved, state: existing }
    const state: UseState = { removing: false, active: new Map() }
    activeUses.set(resolved, state)
    return { resolved, state }
  }

  function releaseUse(resolved: string, state: UseState, token: symbol) {
    state.active.delete(token)
    if (!state.removing && state.active.size === 0 && activeUses.get(resolved) === state) {
      activeUses.delete(resolved)
    }
  }

  async function acquireUse(directory: string, sessionID?: string) {
    const current = useState(directory)
    if (current.state.removing) {
      throw new CreateFailedError({ message: `Worktree ${path.basename(current.resolved)} is being removed.` })
    }
    const token = Symbol("worktree-use")
    current.state.active.set(token, sessionID)
    try {
      if (!(await exists(current.resolved))) {
        throw new NotFoundError({ message: `Worktree directory not found: ${current.resolved}` })
      }
      return () => releaseUse(current.resolved, current.state, token)
    } catch (error) {
      releaseUse(current.resolved, current.state, token)
      throw error
    }
  }

  export async function withUse<T>(directory: string, sessionID: string | undefined, fn: () => Promise<T>) {
    const release = await acquireUse(directory, sessionID)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  function beginRemoval(info: Info, excludeSessionID?: string) {
    const current = useState(info.path)
    if (current.state.removing) {
      throw new CreateFailedError({ message: `Worktree ${info.name} is already being removed.` })
    }
    // A removal issued from the caller's own turn must not be blocked by the
    // use token that turn itself holds, while every other user still must.
    // Anonymous uses carry no session, so they always remain blockers.
    const others = Array.from(current.state.active.values()).filter(
      (value) => excludeSessionID === undefined || value !== excludeSessionID,
    )
    if (others.length > 0) {
      const sessionID = others.find((value) => value !== undefined)
      if (sessionID) {
        throw new SessionBusyError({
          sessionID,
          message: `Wait for session ${sessionID} to finish using worktree ${info.name} before removing it.`,
        })
      }
      throw new CreateFailedError({ message: `Worktree ${info.name} is currently in use.` })
    }
    current.state.removing = true
    return () => {
      current.state.removing = false
      if (current.state.active.size === 0 && activeUses.get(current.resolved) === current.state) {
        activeUses.delete(current.resolved)
      }
    }
  }

  async function withRegistryMutation<T>(key: string, fn: () => Promise<T>) {
    const previous = registryMutations.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = previous.catch(() => undefined).then(() => current)
    registryMutations.set(key, next)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (registryMutations.get(key) === next) registryMutations.delete(key)
    }
  }

  function pick<const T extends readonly string[]>(items: T) {
    return items[Math.floor(Math.random() * items.length)]
  }

  function randomName() {
    return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
  }

  function slug(input: string) {
    const result = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
    return result || randomName()
  }

  function purposeSlug(input?: string) {
    const base = input ? slug(input) : "session"
    const withoutBrand = base.replace(/^synergy(?:-+|$)/, "")
    return withoutBrand || "session"
  }

  function worktreeName(segment: string) {
    return `synergy-${segment}`
  }

  function hashID(input: string) {
    return "wt_" + createHash("sha256").update(input).digest("hex").slice(0, 16)
  }

  function outputText(input: Uint8Array | undefined) {
    if (!input?.length) return ""
    return new TextDecoder().decode(input).trim()
  }

  function errorText(result: { stdout?: Uint8Array; stderr?: Uint8Array }) {
    return [outputText(result.stderr), outputText(result.stdout)].filter(Boolean).join("\n")
  }

  function ensureGitScope() {
    const scope = ScopeContext.current.scope
    if (scope.type !== "project" || scope.vcs !== "git") {
      throw new NotGitError({ message: "Current scope is not a Git repository; git worktree is unavailable." })
    }
    return { scope, repoRoot: ScopeContext.current.worktree }
  }

  function worktreesRoot(repoRoot = ensureGitScope().repoRoot) {
    return path.join(repoRoot, ".synergy", "worktrees")
  }

  function registryRoot(repoRoot = ensureGitScope().repoRoot) {
    return path.join(worktreesRoot(repoRoot), ".registry")
  }

  function registryPath(info: Pick<Info, "id">, repoRoot = ensureGitScope().repoRoot) {
    return path.join(registryRoot(repoRoot), `${info.id}.json`)
  }

  async function exists(target: string) {
    return fs
      .stat(target)
      .then(() => true)
      .catch(() => false)
  }
  export async function assertAvailable(directory: string) {
    if (await exists(path.resolve(directory))) return
    throw new UnavailableError({
      message: "The worktree for this session is no longer available.",
      reason: "missing",
    })
  }

  async function readJson<T>(filepath: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const text = await Bun.file(filepath)
      .text()
      .catch(() => undefined)
    if (!text) return undefined
    return schema.parse(JSON.parse(text))
  }

  async function writeRegistry(info: RegistryInfo, repoRoot = ensureGitScope().repoRoot) {
    await fs.mkdir(registryRoot(repoRoot), { recursive: true })
    await Bun.write(registryPath(info, repoRoot), JSON.stringify(info, null, 2))
  }

  async function removeRegistry(id: string, repoRoot = ensureGitScope().repoRoot) {
    const filepath = registryPath({ id }, repoRoot)
    await withRegistryMutation(filepath, () => fs.rm(filepath, { force: true }).catch(() => {}))
  }

  function normalizeRegistryPath(info: RegistryInfo, repoRoot: string): RegistryInfo {
    const resolved = path.resolve(info.path)
    if (isPathContained(repoRoot, resolved)) return info
    return { ...info, path: path.join(worktreesRoot(repoRoot), path.basename(resolved)) }
  }

  async function readRegistry(repoRoot = ensureGitScope().repoRoot) {
    const root = registryRoot(repoRoot)
    const entries = await fs.readdir(root).catch(() => [] as string[])
    const result = new Map<string, RegistryInfo>()
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const parsed = await readJson(path.join(root, entry), RegistryInfo).catch(() => undefined)
      if (!parsed) continue
      const normalized = normalizeRegistryPath(parsed, repoRoot)
      result.set(path.resolve(normalized.path), normalized)
    }
    return result
  }

  async function ensureExclude(repoRoot: string) {
    const resolved = await $`git rev-parse --git-path info/exclude`.quiet().nothrow().cwd(repoRoot)
    if (resolved.exitCode !== 0) return
    const excludePath = path.resolve(repoRoot, outputText(resolved.stdout))
    await fs.mkdir(path.dirname(excludePath), { recursive: true })
    const existing = await Bun.file(excludePath)
      .text()
      .catch(() => "")
    if (existing.split(/\r?\n/).some((line) => line.trim() === ".synergy/worktrees/")) return
    const next = existing.endsWith("\n") || existing.length === 0 ? existing : existing + "\n"
    await Bun.write(excludePath, next + ".synergy/worktrees/\n")
  }

  export function parsePorcelain(text: string): GitWorktreeEntry[] {
    const result: GitWorktreeEntry[] = []
    let current: GitWorktreeEntry | undefined
    const flush = () => {
      if (current) result.push(current)
      current = undefined
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        flush()
        continue
      }
      const [key, ...rest] = line.split(" ")
      const value = rest.join(" ")
      if (key === "worktree") {
        flush()
        current = { path: value }
        continue
      }
      if (!current) continue
      if (key === "HEAD") current.head = value
      if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
      if (key === "detached") current.detached = true
      if (key === "bare") current.bare = true
      // Porcelain keys are never translated, but the `prunable` reason is, so
      // only the lock's own marker is stored verbatim and prunability is
      // recorded as presence. Stderr must not be parsed for either: git
      // localizes it, and a zh_CN runtime would miss an English-only match.
      if (key === "locked") current.locked = value
      if (key === "prunable") current.prunable = true
    }
    flush()
    return result
  }

  async function gitList(repoRoot: string) {
    const listed = await $`git worktree list --porcelain`.quiet().nothrow().cwd(repoRoot)
    if (listed.exitCode !== 0) throw new NotGitError({ message: errorText(listed) || "Failed to list git worktrees" })
    return parsePorcelain(outputText(listed.stdout))
  }

  function fromGitEntry(
    entry: GitWorktreeEntry,
    registry: RegistryInfo | undefined,
    repoRoot: string,
    scopeID: string,
  ): Info {
    const resolved = path.resolve(entry.path)
    const isMain = resolved === path.resolve(repoRoot)
    const id = registry?.id ?? hashID(resolved)
    const name = registry?.name ?? (isMain ? "main" : path.basename(resolved))
    return Info.parse({
      id,
      name,
      branch: registry?.branch ?? entry.branch,
      path: resolved,
      scopeID,
      head: entry.head,
      baseRef: registry?.baseRef,
      baseRevision: registry?.baseRevision,
      resolvedBaseCommit: registry?.resolvedBaseCommit,
      detached: entry.detached,
      bare: entry.bare,
      isMain,
      managed: !!registry,
      owner: registry?.owner ?? { type: "external" },
      bindings: registry?.bindings ?? [],
      lifecycle: registry?.lifecycle ?? "active",
      createdAt: registry?.createdAt,
      updatedAt: registry?.updatedAt,
      lastUsedAt: registry?.lastUsedAt,
      setupFailed: registry?.setupFailed,
      setupError: registry?.setupError,
      locked: entry.locked,
      prunable: entry.prunable,
    })
  }

  async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
    const result = new Array<R>(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        result[index] = await fn(items[index]!, index)
      }
    })
    await Promise.all(workers)
    return result
  }

  async function directorySize(info: Info, repoRoot: string) {
    const root = path.resolve(info.path)
    const excluded = new Set([path.join(root, ".git")])
    if (info.isMain) excluded.add(path.resolve(worktreesRoot(repoRoot)))

    let total = 0
    const pending = [root]
    while (pending.length > 0) {
      const batch = pending.splice(0, 32)
      const inspected = await Promise.all(
        batch.map(async (current) => {
          if (excluded.has(path.resolve(current))) return { size: 0, children: [] as string[] }
          try {
            const stat = await fs.lstat(current)
            if (!stat.isDirectory() || stat.isSymbolicLink()) return { size: stat.size, children: [] as string[] }
            const entries = await fs.readdir(current)
            return { size: 0, children: entries.map((entry) => path.join(current, entry)) }
          } catch (error) {
            if (current === root) throw error
            return { size: 0, children: [] as string[] }
          }
        }),
      )
      for (const item of inspected) {
        total += item.size
        pending.push(...item.children)
      }
    }
    return total
  }

  async function inventory() {
    const { scope, repoRoot } = ensureGitScope()
    const [gitEntries, registry] = await Promise.all([gitList(repoRoot), readRegistry(repoRoot)])
    const seen = new Set<string>()
    const result = gitEntries.map((entry) => {
      const resolved = path.resolve(entry.path)
      seen.add(resolved)
      return fromGitEntry(entry, registry.get(resolved), repoRoot, scope.id)
    })

    for (const [resolved, info] of registry) {
      if (seen.has(resolved)) continue
      result.push({ ...info, stale: true })
    }

    return { items: result, repoRoot }
  }

  export async function list(): Promise<Info[]> {
    const { items, repoRoot } = await inventory()
    return mapConcurrent(items, 4, async (item) => {
      const [dirty, diskBytes] = await Promise.all([
        item.stale ? undefined : isDirty(item.path).catch(() => undefined),
        item.stale || !item.managed ? undefined : directorySize(item, repoRoot).catch(() => undefined),
      ])
      return {
        ...item,
        dirty,
        diskBytes,
      }
    })
  }

  async function isDirty(directory: string) {
    const status = await $`git status --porcelain`.quiet().nothrow().cwd(directory)
    if (status.exitCode !== 0) return true
    return outputText(status.stdout).length > 0
  }

  async function setupInfo(repoRoot: string) {
    let result: SetupInfo = { setup: [], copyIgnored: [], env: {} }
    for (const file of ["worktree-setup.jsonc", "worktree-setup.local.jsonc"]) {
      const filepath = path.join(repoRoot, ".synergy", file)
      const text = await Bun.file(filepath)
        .text()
        .catch(() => undefined)
      if (!text) continue
      try {
        const parsed = SetupInfo.parse(parseJsonc(text))
        result = {
          setup: [...(result.setup ?? []), ...(parsed.setup ?? [])],
          copyIgnored: [...(result.copyIgnored ?? []), ...(parsed.copyIgnored ?? [])],
          env: { ...(result.env ?? {}), ...(parsed.env ?? {}) },
        }
      } catch (error) {
        throw new SetupConfigError({
          message: `Invalid worktree setup file ${filepath}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    return result
  }

  async function copyIgnoredFiles(setup: SetupInfo, repoRoot: string, directory: string) {
    for (const item of setup.copyIgnored) {
      const relative = item.replace(/^\/+/, "")
      const source = path.join(repoRoot, relative)
      const target = path.join(directory, relative)
      if (!(await exists(source))) continue
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.cp(source, target, { recursive: true, force: true, errorOnExist: false })
    }
  }

  async function runSetup(setup: SetupInfo, repoRoot: string, directory: string, info: Pick<Info, "name" | "branch">) {
    const env = {
      ...process.env,
      ...setup.env,
      ROOT_WORKTREE_PATH: repoRoot,
      WORKTREE_PATH: directory,
      WORKTREE_NAME: info.name,
      WORKTREE_BRANCH: info.branch ?? "",
      SYNERGY_SCOPE_ID: ScopeContext.current.scope.id,
    }
    for (const command of setup.setup) {
      const ran = process.platform === "win32" ? $`cmd /c ${command}` : $`bash -lc ${command}`
      const result = await ran.env(env).cwd(directory).nothrow()
      if (result.exitCode !== 0) {
        throw new StartCommandFailedError({ message: errorText(result) || `Worktree setup command failed: ${command}` })
      }
    }
  }

  async function resolveBase(input: { baseRef: "current" | "fresh"; baseRevision?: string }, repoRoot: string) {
    let revision = input.baseRevision?.trim()
    if (!revision) {
      revision = "HEAD"
      if (input.baseRef === "fresh") {
        const originHead = await $`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`
          .quiet()
          .nothrow()
          .cwd(repoRoot)
        if (originHead.exitCode === 0) revision = outputText(originHead.stdout)
        else {
          const branch = await $`git branch --show-current`.quiet().nothrow().cwd(repoRoot)
          revision = outputText(branch.stdout) || "HEAD"
        }
      }
    }

    const verified = await $`git rev-parse --verify ${`${revision}^{commit}`}`.quiet().nothrow().cwd(repoRoot)
    if (verified.exitCode !== 0) {
      throw new CreateFailedError({ message: errorText(verified) || `Invalid worktree base revision: ${revision}` })
    }

    return {
      revision,
      resolvedCommit: outputText(verified.stdout),
    }
  }

  async function candidate(repoRoot: string, baseName?: string, sessionID?: string) {
    const root = worktreesRoot(repoRoot)
    const purpose = purposeSlug(baseName)
    const suffix = sessionID ? sessionID.replace(/^ses_/, "").slice(0, 6) : Date.now().toString(36).slice(-6)
    for (const attempt of Array.from({ length: 26 }, (_, i) => i)) {
      const segment = attempt === 0 ? `${purpose}-${suffix}` : `${purpose}-${suffix}-${attempt + 1}`
      const name = worktreeName(segment)
      const branch = `synergy/${segment}`
      const directory = path.join(root, name)
      if (await exists(directory)) continue
      const ref = `refs/heads/${branch}`
      const branchCheck = await $`git show-ref --verify --quiet ${ref}`.quiet().nothrow().cwd(repoRoot)
      if (branchCheck.exitCode === 0) continue
      return { name, branch, directory }
    }
    throw new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
  }

  async function cleanupCreatedWorktree(repoRoot: string, directory: string, branch: string) {
    await $`git worktree remove --force ${directory}`.quiet().nothrow().cwd(repoRoot)
    await $`git branch -D ${branch}`.quiet().nothrow().cwd(repoRoot)
  }

  export const create = fn(CreateInput.optional(), async (input) => {
    const parsed = CreateInput.parse(input ?? {})
    const { scope, repoRoot } = ensureGitScope()
    await ensureExclude(repoRoot)
    await fs.mkdir(worktreesRoot(repoRoot), { recursive: true })

    const session = parsed.sessionID ? await Session.get(parsed.sessionID) : undefined
    const titleName = session?.title && !isDefaultTitle(session.title) ? session.title : undefined
    const info = await candidate(repoRoot, parsed.name ?? titleName, parsed.sessionID)
    const base = await resolveBase({ baseRef: parsed.baseRef, baseRevision: parsed.baseRevision }, repoRoot)

    const created = await $`git worktree add -b ${info.branch} ${info.directory} ${base.revision}`
      .quiet()
      .nothrow()
      .cwd(repoRoot)
    if (created.exitCode !== 0)
      throw new CreateFailedError({ message: errorText(created) || "Failed to create git worktree" })

    const now = Date.now()
    const registry: RegistryInfo = RegistryInfo.parse({
      branch: info.branch,
      id: hashID(path.resolve(info.directory)),
      name: info.name,
      path: path.resolve(info.directory),
      scopeID: scope.id,
      baseRef: parsed.baseRef,
      baseRevision: parsed.baseRevision,
      resolvedBaseCommit: base.resolvedCommit,
      managed: true,
      owner: parsed.owner ?? (parsed.sessionID ? { type: "session", sessionID: parsed.sessionID } : { type: "user" }),
      bindings: parsed.sessionID && parsed.bind ? [parsed.sessionID] : [],
      lifecycle: "active",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    })

    try {
      const result = await withUse(registry.path, parsed.sessionID, async () => {
        const setup = await setupInfo(repoRoot)
        try {
          await copyIgnoredFiles(setup, repoRoot, registry.path)
          await runSetup(setup, repoRoot, registry.path, registry)
        } catch (error) {
          registry.setupFailed = true
          registry.setupError = error instanceof Error ? error.message : String(error)
        }
        await writeRegistry(registry, repoRoot)
        if (parsed.sessionID && parsed.bind) await bindSession(parsed.sessionID, registry)
        return fromGitEntry({ path: registry.path, branch: registry.branch }, registry, repoRoot, scope.id)
      })
      // Opportunistic cap top-up, fire-and-forget by contract: creation has
      // already succeeded, so a sweep that cannot converge must never surface
      // as a creation failure.
      requestSweep(scope)
      return result
    } catch (error) {
      await cleanupCreatedWorktree(repoRoot, registry.path, registry.branch)
      throw error
    }
  })

  function match(info: Info, target: string) {
    return info.id === target || info.name === target || info.branch === target || info.path === target
  }

  async function find(target: string) {
    const { items } = await inventory()
    const found = items.find((item) => match(item, target))
    if (!found) throw new NotFoundError({ message: `Worktree not found: ${target}` })
    return found
  }

  async function updateBinding(info: Info, sessionID: string, action: "add" | "remove") {
    if (!info.managed || !info.id) return
    const { repoRoot } = ensureGitScope()
    const filepath = registryPath({ id: info.id }, repoRoot)
    await withRegistryMutation(filepath, async () => {
      const current = await readJson(filepath, RegistryInfo)
      if (!current) return
      const bindings = new Set(current.bindings)
      if (action === "add") bindings.add(sessionID)
      else bindings.delete(sessionID)
      const updated = RegistryInfo.parse({
        ...current,
        bindings: Array.from(bindings),
        lastUsedAt: Date.now(),
        updatedAt: Date.now(),
        lifecycle: bindings.size === 0 ? "detached" : "active",
      })
      await writeRegistry(updated, repoRoot)
    })
  }

  async function bindSession(sessionID: string, info: Info) {
    const { repoRoot } = ensureGitScope()
    const workspace = {
      type: "git_worktree",
      path: info.path,
      scopeID: info.scopeID,
      worktreeID: info.id,
      name: info.name,
      branch: info.branch,
      baseRef: info.baseRef,
      baseRevision: info.baseRevision,
      resolvedBaseCommit: info.resolvedBaseCommit,
      originalCheckout: path.resolve(repoRoot),
    }
    await updateBinding(info, sessionID, "add")
    try {
      await Session.updateWorkspace(sessionID, workspace)
      ScopeContext.refreshWorkspace(workspace as import("@ericsanchezok/synergy-harness/session/types").Workspace)
    } catch (error) {
      await updateBinding(info, sessionID, "remove").catch(() => undefined)
      throw error
    }
  }

  export async function enter(input: TargetInput) {
    const info = await find(input.target)
    return withUse(info.path, input.sessionID, async () => {
      const current = await find(input.target)
      await bindSession(input.sessionID, current)
      return current
    })
  }

  async function leaveSession(sessionID: string) {
    const session = await Session.get(sessionID)
    const previous = session.workspace
    const scope = session.scope as Scope
    const originalCheckout =
      previous?.type === "git_worktree" && typeof previous.originalCheckout === "string"
        ? previous.originalCheckout
        : undefined
    const mainPath = originalCheckout ?? scope.worktree ?? scope.directory
    const mainWorkspace = { type: "main" as const, path: mainPath, scopeID: scope.id }
    const result = await Session.updateWorkspace(sessionID, mainWorkspace)
    ScopeContext.refreshWorkspace(mainWorkspace as import("@ericsanchezok/synergy-harness/session/types").Workspace)
    if (previous?.type === "git_worktree" && previous.worktreeID) {
      await updateBinding(
        {
          id: previous.worktreeID as string,
          name: String(previous.name ?? previous.worktreeID),
          path: previous.path,
          scopeID: previous.scopeID,
          managed: true,
        },
        sessionID,
        "remove",
      )
    }
    return result
  }

  export async function leave(sessionID: string) {
    const session = await Session.get(sessionID)
    const workspace = session.workspace
    if (workspace?.type !== "git_worktree") return leaveSession(sessionID)
    return withUse(workspace.path, sessionID, () => leaveSession(sessionID))
  }

  export async function status(sessionID: string) {
    const session = await Session.get(sessionID)
    const workspace = session.workspace
    const item =
      workspace?.type === "git_worktree" && workspace.worktreeID ? await find(String(workspace.worktreeID)) : undefined
    const directory = workspace?.path ?? (session.scope as Scope).directory
    return {
      workspace,
      worktree: item,
      dirty: await isDirty(directory).catch(() => undefined),
      path: directory,
    }
  }

  async function isSessionRunning(sessionID: string) {
    const { SessionManager } = await import("@ericsanchezok/synergy-harness/session/manager")
    return SessionManager.isRunning(sessionID)
  }

  async function getSession(sessionID: string) {
    try {
      return await Session.get(sessionID)
    } catch {
      return undefined
    }
  }

  async function leaveBoundSessions(info: Info, extraSessionID?: string, options?: { excludeRunning?: string }) {
    const bindings = new Set(info.bindings ?? [])
    if (extraSessionID) bindings.add(extraSessionID)
    // The caller's own turn is running by definition. It is still unbound in
    // the loop below, but it must not count as a competing session here, or a
    // removal issued from that turn rejects itself.
    for (const sessionID of bindings) {
      if (sessionID === options?.excludeRunning) continue
      if (await isSessionRunning(sessionID)) {
        throw new SessionBusyError({
          sessionID,
          message: `Stop session ${sessionID} before removing worktree ${info.name}.`,
        })
      }
    }
    for (const sessionID of bindings) {
      const session = await getSession(sessionID)
      if (session?.workspace?.type === "git_worktree" && session.workspace.worktreeID === info.id) {
        await leaveSession(sessionID)
      } else if (info.managed) {
        await updateBinding(info, sessionID, "remove")
      }
    }
  }

  export async function remove(input: RemoveInput & { sessionID?: string }, options?: { insideCallerTurn?: boolean }) {
    const sessionID = input.sessionID
    // Internal fact, never a wire field: only the caller that owns the running
    // turn may exclude itself from the guards below.
    const excludeSessionID = options?.insideCallerTurn ? sessionID : undefined
    const parsed = RemoveInput.parse(input)
    const initial = await find(parsed.target)
    if (initial.isMain) throw new CreateFailedError({ message: "Cannot remove the main worktree" })
    const finishRemoval = beginRemoval(initial, excludeSessionID)
    try {
      const info = await find(parsed.target)
      if (info.stale) {
        await leaveBoundSessions(info, sessionID, { excludeRunning: excludeSessionID })
        if (info.managed) await removeRegistry(info.id)
        return info
      }
      if (!parsed.force && (await isDirty(info.path))) {
        throw new DirtyError({ message: `Worktree ${info.name} has uncommitted changes. Re-run with force to remove.` })
      }
      await leaveBoundSessions(info, sessionID, { excludeRunning: excludeSessionID })
      await removeWorktree(info, { force: parsed.force, reason: "explicit" })
      return info
    } finally {
      finishRemoval()
    }
  }

  /** The branch a landed check compares against: the remote default, else HEAD. */
  async function targetBranch(repoRoot: string): Promise<string | undefined> {
    const remote = await $`git symbolic-ref --short refs/remotes/origin/HEAD`.quiet().nothrow().cwd(repoRoot)
    const fromRemote = outputText(remote.stdout).replace(/^origin\//, "")
    if (remote.exitCode === 0 && fromRemote) return fromRemote
    const head = await $`git rev-parse --abbrev-ref HEAD`.quiet().nothrow().cwd(repoRoot)
    const value = outputText(head.stdout)
    return head.exitCode === 0 && value ? value : undefined
  }

  /**
   * Stable patch-id of a diff, used to match a squash commit against a branch.
   * The diff is streamed through stdin rather than interpolated into a shell
   * command, so revision expressions never reach a shell parser.
   */
  async function patchIdOf(repoRoot: string, args: string[]): Promise<string | undefined> {
    const diff = await $`git ${args}`.quiet().nothrow().cwd(repoRoot)
    if (diff.exitCode !== 0) return undefined
    const proc = Bun.spawn(["git", "patch-id", "--stable"], {
      cwd: repoRoot,
      stdin: diff.stdout,
      stdout: "pipe",
      stderr: "ignore",
    })
    const id = (await new Response(proc.stdout).text()).trim().split(/\s+/)[0]
    return (await proc.exited) === 0 && id ? id : undefined
  }

  /**
   * Content-level landed detection. `git branch -d` and `merge-base
   * --is-ancestor` compare commit reachability, so both report a squash- or
   * rebase-merged branch as unmerged even when its content is already on the
   * target. Tree equality is the cheapest proof; an aggregate patch-id match
   * covers a squash that rewrote the tree; `git cherry` only settles a regular
   * merge. Anything unproven leaves the branch alone, because deleting a branch
   * is the one step here that can lose work.
   */
  async function branchLanded(repoRoot: string, branch: string, target: string): Promise<boolean> {
    const ancestor = await $`git merge-base --is-ancestor ${branch} ${target}`.quiet().nothrow().cwd(repoRoot)
    if (ancestor.exitCode === 0) return true
    const identical = await $`git diff --quiet ${branch} ${target}`.quiet().nothrow().cwd(repoRoot)
    if (identical.exitCode === 0) return true

    const mergeBase = await $`git merge-base ${target} ${branch}`.quiet().nothrow().cwd(repoRoot)
    const base = outputText(mergeBase.stdout)
    if (mergeBase.exitCode !== 0 || !base) return false

    const aggregate = await patchIdOf(repoRoot, ["diff", base, branch])
    if (aggregate) {
      const commits = await $`git log --format=%H ${base}..${target}`.quiet().nothrow().cwd(repoRoot).text()
      for (const commit of commits
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 25)) {
        const candidate = await patchIdOf(repoRoot, ["show", commit])
        if (candidate && candidate === aggregate) return true
      }
    }

    const merges = await $`git rev-list --merges ${target}..${branch}`.quiet().nothrow().cwd(repoRoot)
    if (merges.exitCode !== 0 || outputText(merges.stdout)) return false
    const cherry = await $`git cherry -v ${target} ${branch}`.quiet().nothrow().cwd(repoRoot).text()
    const lines = cherry
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.length > 0 && lines.every((line) => line.startsWith("-"))
  }

  async function deleteBranchIfLanded(repoRoot: string, branch: string) {
    if (!branch) return
    const target = await targetBranch(repoRoot)
    if (!target || target === branch) return
    const porcelain = await $`git worktree list --porcelain`.quiet().nothrow().cwd(repoRoot).text()
    const stillCheckedOut = parsePorcelain(porcelain).some(
      (item) => item.branch === branch && path.resolve(item.path) !== path.resolve(repoRoot),
    )
    if (stillCheckedOut) return
    if (!(await branchLanded(repoRoot, branch, target))) {
      log.info("worktree branch kept (content not proven landed)", { branch, target })
      return
    }
    await $`git branch -D ${branch}`.quiet().nothrow().cwd(repoRoot)
    log.info("worktree branch deleted (content landed)", { branch, target })
  }

  /**
   * The single place a managed worktree is destroyed, shared by explicit
   * removal, the janitor, and Cortex cleanup so all three honour the same lock
   * and branch rules.
   */
  async function removeWorktree(info: Info, options: { force: boolean; reason: string }) {
    const { repoRoot } = ensureGitScope()
    // An explicit removal runs inside the turn that holds a git-level lock, and
    // the janitor may meet a Synergy lock a dead holder left behind. Either one
    // blocks `git worktree remove` at every force level below `-f -f`, so
    // release it here; `-f -f` is not an option because the turn's own finally
    // would then unlock a path that is no longer a working tree and throw.
    // A lock this repository did not write is refused, never cleared: it is
    // indistinguishable from one a user pinned by hand.
    if (!(await releaseLockForRemoval(info.path))) {
      throw new CreateFailedError({
        message: `Worktree ${info.name} is locked outside Synergy. Unlock it before removing.`,
      })
    }
    const removed = options.force
      ? await $`git worktree remove --force ${info.path}`.quiet().nothrow().cwd(repoRoot)
      : await $`git worktree remove ${info.path}`.quiet().nothrow().cwd(repoRoot)
    if (removed.exitCode !== 0) {
      throw new CreateFailedError({ message: errorText(removed) || "Failed to remove git worktree" })
    }
    if (info.managed) await removeRegistry(info.id)
    await deleteBranchIfLanded(repoRoot, info.branch ?? "")
    log.info("worktree removed", { id: info.id, name: info.name, reason: options.reason })
  }

  const LOCK_MARKER_PREFIX = "synergy:v1:"

  function lockMarker(sessionID?: string) {
    return `${LOCK_MARKER_PREFIX}session=${sessionID ?? "unknown"}`
  }

  function ownsLockMarker(reason: string | undefined) {
    return typeof reason === "string" && reason.startsWith(LOCK_MARKER_PREFIX)
  }

  async function readLockReason(directory: string, repoRoot: string): Promise<string | undefined> {
    const text = await $`git worktree list --porcelain`.quiet().nothrow().cwd(repoRoot).text()
    if (!text) return undefined
    const resolved = path.resolve(directory)
    return parsePorcelain(text).find((item) => path.resolve(item.path) === resolved)?.locked
  }

  export async function lock(directory: string, sessionID?: string): Promise<LockResult> {
    const resolved = path.resolve(directory)
    let state = activeLocks.get(resolved)
    if (!state) {
      state = { count: 0, synergyAcquired: false, markerOwner: false }
      activeLocks.set(resolved, state)
    }
    state.count += 1
    if (state.count > 1) return { acquired: false, existing: false, markerOwner: state.markerOwner }
    const { repoRoot } = ensureGitScope()
    const reason = lockMarker(sessionID)
    const result = await $`git worktree lock --reason ${reason} ${resolved}`.quiet().nothrow().cwd(repoRoot)
    if (result.exitCode !== 0) {
      // "Already locked" is decided from porcelain, never from stderr: git
      // localizes that message, so a text match only holds under an English
      // locale and a non-English runtime threw instead of reporting the lock.
      const existingReason = await readLockReason(resolved, repoRoot)
      if (existingReason !== undefined) {
        // Keep the state so a concurrent holder's count survives, and record
        // whether this repository provably wrote the lock that is on disk.
        state.markerOwner = ownsLockMarker(existingReason)
        return { acquired: false, existing: true, markerOwner: state.markerOwner }
      }
      activeLocks.delete(resolved)
      throw new LockFailedError({ message: errorText(result) || `Failed to lock worktree: ${resolved}` })
    }
    state.synergyAcquired = true
    state.markerOwner = true
    state.reason = reason
    return { acquired: true, existing: false, markerOwner: true }
  }

  export async function unlock(directory: string) {
    const resolved = path.resolve(directory)
    const state = activeLocks.get(resolved)
    if (!state) return
    if (state.count > 1) {
      state.count -= 1
      return
    }
    activeLocks.delete(resolved)
    // A lock this repository did not write is never cleared, so a user's own
    // `git worktree lock` survives a session that merely ran in the worktree.
    if (!state.synergyAcquired) return
    const { repoRoot } = ensureGitScope()
    if ((await readLockReason(resolved, repoRoot)) !== state.reason) return
    const result = await $`git worktree unlock ${resolved}`.quiet().nothrow().cwd(repoRoot)
    if (result.exitCode !== 0) {
      throw new LockFailedError({ message: errorText(result) || `Failed to unlock worktree: ${resolved}` })
    }
  }

  /**
   * Clear the lock that blocks removing a worktree. Only a lock carrying this
   * repository's own marker is released: an unmarked lock is indistinguishable
   * from one a user wrote by hand, so it is reported instead of guessed at.
   */
  export async function releaseLockForRemoval(directory: string): Promise<boolean> {
    const resolved = path.resolve(directory)
    const { repoRoot } = ensureGitScope()
    const existingReason = await readLockReason(resolved, repoRoot)
    if (existingReason === undefined) return true
    const state = activeLocks.get(resolved)
    if (!ownsLockMarker(existingReason) || !state?.synergyAcquired || state.reason !== existingReason) return false
    const result = await $`git worktree unlock ${resolved}`.quiet().nothrow().cwd(repoRoot)
    if (result.exitCode !== 0) return false
    // Both flags must clear. The turn's own finally still calls unlock(), and
    // leaving the marker recorded would make it run `git worktree unlock` on a
    // path that is no longer a working tree, throwing out of that finally and
    // failing an otherwise successful turn.
    if (state) {
      state.synergyAcquired = false
      state.markerOwner = false
    }
    return true
  }

  export async function detachSession(sessionID: string) {
    const session = await Session.get(sessionID).catch(() => undefined)
    const workspace = session?.workspace
    if (workspace?.type !== "git_worktree" || !workspace.worktreeID) return
    await updateBinding(
      {
        id: String(workspace.worktreeID),
        name: String(workspace.name ?? workspace.worktreeID),
        path: workspace.path,
        scopeID: workspace.scopeID,
        managed: true,
      },
      sessionID,
      "remove",
    )
  }
  const log = Log.create({ service: "worktree" })

  export const DEFAULT_MAX_MANAGED = 20

  export interface SweepEvidence {
    /** Who owns the on-disk lock, decided from the porcelain marker. */
    lock: "none" | "synergy" | "foreign"
    dirty?: boolean
    running: boolean
    localOnlyCommits?: number
  }

  export type SweepKeepReason =
    | "external"
    | "main"
    | "foreign_lock"
    | "synergy_lock"
    | "running"
    | "dirty"
    | "unknown_dirty"
    | "local_only_commits"
    | "unknown_commits"
    | "removal_failed"

  export type SweepDecision = { eligible: true } | { eligible: false; reason: SweepKeepReason }

  /**
   * Pure eligibility decision. Evidence is supplied by the caller so this stays
   * testable and independent of where the facts came from — an earlier version
   * consulted the in-process lock map here, which cannot see another process.
   * Whether an eligible worktree is actually reclaimed is the caller's cap
   * decision, not this function's.
   */
  export function decide(info: Info, evidence: SweepEvidence): SweepDecision {
    if (!info.managed) return { eligible: false, reason: "external" }
    if (info.isMain) return { eligible: false, reason: "main" }
    if (evidence.lock === "foreign") return { eligible: false, reason: "foreign_lock" }
    if (evidence.lock === "synergy") return { eligible: false, reason: "synergy_lock" }
    if (evidence.running) return { eligible: false, reason: "running" }
    if (evidence.dirty === true) return { eligible: false, reason: "dirty" }
    if (evidence.dirty === undefined) return { eligible: false, reason: "unknown_dirty" }
    if (evidence.localOnlyCommits === undefined) return { eligible: false, reason: "unknown_commits" }
    if (evidence.localOnlyCommits > 0) return { eligible: false, reason: "local_only_commits" }
    return { eligible: true }
  }

  export interface SweepReport {
    scanned: number
    maxManaged: number
    removed: string[]
    skipped: { id: string; name: string; reason: SweepKeepReason }[]
    reconciled: string[]
  }

  /** Local commits with no remote-tracking counterpart, i.e. work only this checkout holds. */
  export async function localOnlyCommitCount(directory: string): Promise<number> {
    const result = await $`git rev-list --count HEAD --not --remotes`.quiet().nothrow().cwd(directory)
    const count = Number.parseInt(outputText(result.stdout), 10)
    if (result.exitCode !== 0 || !Number.isSafeInteger(count) || count < 0) {
      throw new CreateFailedError({ message: "Cannot verify whether the worktree has local-only commits." })
    }
    return count
  }

  function lockOwner(locked: string | undefined): SweepEvidence["lock"] {
    if (locked === undefined) return "none"
    return ownsLockMarker(locked) ? "synergy" : "foreign"
  }

  /**
   * Reconcile stale registrations and enforce the managed-worktree cap.
   *
   * Uses the lightweight inventory rather than `list()`: the sweep runs on a
   * background tick, and `list()` computes directory size for every worktree,
   * which on this checkout meant walking tens of gigabytes. Expensive probes
   * (dirty, local-only commits) run only for worktrees that survived the cheap
   * guards. The cap is measured over all managed worktrees but drawn only from
   * eligible ones, so a blocked worktree is reported rather than deleted to
   * reach the target.
   */
  export async function sweep(options?: { maxManaged?: number }): Promise<SweepReport> {
    const { repoRoot } = ensureGitScope()
    const maxManaged = options?.maxManaged ?? DEFAULT_MAX_MANAGED
    const { items } = await inventory()
    const report: SweepReport = { scanned: items.length, maxManaged, removed: [], skipped: [], reconciled: [] }

    async function running(info: Info) {
      for (const sessionID of info.bindings ?? []) {
        if (await isSessionRunning(sessionID)) return true
      }
      return false
    }

    async function probe(info: Info) {
      const lock = lockOwner(info.locked)
      const busy = await running(info)
      const dirty = lock !== "none" || busy ? undefined : await isDirty(info.path).catch(() => undefined)
      const localOnlyCommits =
        dirty === false ? await localOnlyCommitCount(info.path).catch(() => undefined) : undefined
      return decide(info, { lock, dirty, running: busy, localOnlyCommits })
    }

    const reconciled = new Set<string>()
    for (const item of items) {
      if (!item.managed || item.isMain || (!item.stale && item.prunable !== true)) continue
      let finishRemoval: (() => void) | undefined
      try {
        finishRemoval = beginRemoval(item)
        const current = await find(item.id)
        const lock = lockOwner(current.locked)
        if (lock !== "none" || (await running(current))) {
          report.skipped.push({
            id: item.id,
            name: item.name,
            reason: lock === "foreign" ? "foreign_lock" : lock === "synergy" ? "synergy_lock" : "running",
          })
          continue
        }
        const missing = await fs.lstat(current.path).then(
          () => false,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return true
            throw error
          },
        )
        if (!missing) continue
        await leaveBoundSessions(current)
        if (!current.stale) {
          const removed = await $`git worktree remove --force ${current.path}`.quiet().nothrow().cwd(repoRoot)
          if (removed.exitCode !== 0) throw new CreateFailedError({ message: errorText(removed) })
        }
        await removeRegistry(current.id, repoRoot)
        reconciled.add(current.id)
        report.reconciled.push(current.id)
      } catch (error) {
        log.warn("sweep reconciliation failed", { id: item.id, error })
        report.skipped.push({ id: item.id, name: item.name, reason: "removal_failed" })
      } finally {
        finishRemoval?.()
      }
    }

    const managed = items.filter((item) => !reconciled.has(item.id) && !item.stale && item.managed && !item.isMain)
    const oldestFirst = [...managed].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
    const excess = Math.max(managed.length - maxManaged, 0)
    for (const item of oldestFirst) {
      let finishRemoval: (() => void) | undefined
      try {
        finishRemoval = beginRemoval(item)
        const current = await find(item.id)
        const decision = await probe(current)
        if (!decision.eligible) {
          report.skipped.push({ id: item.id, name: item.name, reason: decision.reason })
          continue
        }
        if (report.removed.length >= excess) continue
        await leaveBoundSessions(current)
        await removeWorktree(current, { force: false, reason: "managed cap" })
        report.removed.push(current.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn("sweep failed to remove worktree", { id: item.id, name: item.name, error: message })
        report.skipped.push({ id: item.id, name: item.name, reason: "removal_failed" })
      } finally {
        finishRemoval?.()
      }
    }

    log.info("sweep complete", {
      scanned: report.scanned,
      removed: report.removed.length,
      skipped: report.skipped.length,
      reconciled: report.reconciled.length,
    })
    return report
  }

  export async function markLifecycle(id: string, lifecycle: RegistryInfo["lifecycle"]) {
    const { repoRoot } = ensureGitScope()
    const current = await readJson(registryPath({ id }, repoRoot), RegistryInfo)
    if (!current) return
    const updated = RegistryInfo.parse({ ...current, lifecycle, updatedAt: Date.now() })
    await writeRegistry(updated, repoRoot)
  }
}
