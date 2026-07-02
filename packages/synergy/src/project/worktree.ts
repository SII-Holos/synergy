import { $ } from "bun"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { parse as parseJsonc } from "jsonc-parser"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Identifier } from "../id/id"
import { Session } from "../session"
import type { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { fn } from "../util/fn"
import { Log } from "../util/log"

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
      owner: Owner.optional(),
      bindings: z.array(z.string()).optional(),
      lifecycle: z.enum(["active", "detached", "gc_candidate", "deleted"]).optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
      lastUsedAt: z.number().optional(),
      setupFailed: z.boolean().optional(),
      setupError: z.string().optional(),
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
  export type TargetInput = z.infer<typeof TargetInput>

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
  }

  export interface LockResult {
    acquired: boolean
    /** true when git reported that the worktree was already locked before this call. */
    existing: boolean
  }

  interface LockState {
    count: number
    synergyAcquired: boolean
  }

  const activeLocks = new Map<string, LockState>()

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
    await fs.rm(registryPath({ id }, repoRoot), { force: true }).catch(() => {})
  }

  function normalizeRegistryPath(info: RegistryInfo, repoRoot: string): RegistryInfo {
    const resolved = path.resolve(info.path)
    if (resolved.startsWith(path.resolve(repoRoot) + path.sep)) return info
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
    })
  }

  export async function list(): Promise<Info[]> {
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

    return result
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
    const base = slug(baseName || randomName())
    const suffix = sessionID ? sessionID.replace(/^ses_/, "").slice(0, 6) : Date.now().toString(36).slice(-6)
    for (const attempt of Array.from({ length: 26 }, (_, i) => i)) {
      const name = attempt === 0 ? `${base}-${suffix}` : `${base}-${suffix}-${attempt + 1}`
      const branch = `synergy/${name}`
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
    const titleName = session?.title && !session.title.startsWith("New Session") ? session.title : undefined
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
    } catch (error) {
      await cleanupCreatedWorktree(repoRoot, registry.path, registry.branch)
      throw error
    }
  })

  function match(info: Info, target: string) {
    return info.id === target || info.name === target || info.branch === target || info.path === target
  }

  async function find(target: string) {
    const items = await list()
    const found = items.find((item) => match(item, target))
    if (!found) throw new NotFoundError({ message: `Worktree not found: ${target}` })
    return found
  }

  async function updateBinding(info: Info, sessionID: string, action: "add" | "remove") {
    if (!info.managed || !info.id) return
    const { repoRoot } = ensureGitScope()
    const current = await readJson(registryPath({ id: info.id }, repoRoot), RegistryInfo)
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
    await Session.updateWorkspace(sessionID, workspace)
    ScopeContext.refreshWorkspace(workspace as import("../session/types").Workspace)
    await updateBinding(info, sessionID, "add")
  }

  export async function enter(input: TargetInput) {
    const info = await find(input.target)
    await bindSession(input.sessionID, info)
    return info
  }

  export async function leave(sessionID: string) {
    const session = await Session.get(sessionID)
    const previous = session.workspace
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
    const scope = session.scope as Scope
    const originalCheckout =
      previous?.type === "git_worktree" && typeof previous.originalCheckout === "string"
        ? previous.originalCheckout
        : undefined
    const mainPath = originalCheckout ?? scope.worktree ?? scope.directory
    const mainWorkspace = { type: "main" as const, path: mainPath, scopeID: scope.id }
    const result = await Session.updateWorkspace(sessionID, mainWorkspace)
    ScopeContext.refreshWorkspace(mainWorkspace as import("../session/types").Workspace)
    return result
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

  export async function remove(input: TargetInput) {
    const parsed = TargetInput.parse(input)
    const info = await find(parsed.target)
    if (info.isMain) throw new CreateFailedError({ message: "Cannot remove the main worktree" })
    if (!parsed.force && (await isDirty(info.path))) {
      throw new DirtyError({ message: `Worktree ${info.name} has uncommitted changes. Re-run with force to remove.` })
    }
    const removed = parsed.force
      ? await $`git worktree remove --force ${info.path}`.quiet().nothrow().cwd(ensureGitScope().repoRoot)
      : await $`git worktree remove ${info.path}`.quiet().nothrow().cwd(ensureGitScope().repoRoot)
    if (removed.exitCode !== 0)
      throw new CreateFailedError({ message: errorText(removed) || "Failed to remove git worktree" })
    if (info.managed) await removeRegistry(info.id)
    let session: Awaited<ReturnType<typeof Session.get>> | undefined
    try {
      session = await Session.get(parsed.sessionID)
    } catch {
      // sessionID may be a placeholder like "none" — ignore
    }
    if (session?.workspace?.type === "git_worktree" && session.workspace.worktreeID === info.id)
      await leave(parsed.sessionID)
    return info
  }

  export async function pruneStaleRegistry() {
    const { repoRoot } = ensureGitScope()
    const items = await list()
    for (const item of items) {
      if (item.stale && item.managed) await removeRegistry(item.id, repoRoot)
    }
    return true
  }

  export async function lock(directory: string): Promise<LockResult> {
    const resolved = path.resolve(directory)
    let state = activeLocks.get(resolved)
    if (!state) {
      state = { count: 0, synergyAcquired: false }
      activeLocks.set(resolved, state)
    }
    state.count += 1
    if (state.count > 1) return { acquired: false, existing: false }
    const { repoRoot } = ensureGitScope()
    const result = await $`git worktree lock ${resolved}`.quiet().nothrow().cwd(repoRoot)
    if (result.exitCode !== 0) {
      const msg = errorText(result)
      if (/already locked/i.test(msg)) {
        activeLocks.delete(resolved)
        return { acquired: false, existing: true }
      }
      activeLocks.delete(resolved)
      throw new LockFailedError({ message: msg || `Failed to lock worktree: ${resolved}` })
    }
    state.synergyAcquired = true
    return { acquired: true, existing: false }
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
    if (!state.synergyAcquired) return
    const { repoRoot } = ensureGitScope()
    const result = await $`git worktree unlock ${resolved}`.quiet().nothrow().cwd(repoRoot)
    if (result.exitCode !== 0) {
      throw new LockFailedError({ message: errorText(result) || `Failed to unlock worktree: ${resolved}` })
    }
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

  export type CleanupAction = "keep" | "safe_to_remove" | "prompt"
  export interface CleanupDecision {
    action: CleanupAction
    reason: string
  }

  export function cleanupState(info: Info): CleanupDecision {
    if (!info.managed) return { action: "keep", reason: "external worktree, not managed by Synergy" }
    if (info.isMain) return { action: "keep", reason: "main worktree" }
    if (info.lifecycle === "active" && info.bindings && info.bindings.length > 0)
      return { action: "keep", reason: "active with live bindings" }
    if (info.lifecycle === "active" && activeLocks.has(info.path)) return { action: "keep", reason: "locked" }
    if (info.dirty === true) return { action: "prompt", reason: "has uncommitted changes" }
    if (info.lifecycle === "gc_candidate") return { action: "safe_to_remove", reason: "marked for garbage collection" }
    if (info.stale === true && (!info.bindings || info.bindings.length === 0))
      return { action: "safe_to_remove", reason: "stale with no bindings" }
    return { action: "keep", reason: "in use or undetermined" }
  }

  async function unlockStale(directory: string, repoRoot: string) {
    try {
      const result = await $`git worktree unlock ${directory}`.quiet().nothrow().cwd(repoRoot)
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  export async function collectGarbage(): Promise<{ removed: string[]; skipped: string[] }> {
    const removed: string[] = []
    const skipped: string[] = []
    const { repoRoot } = ensureGitScope()
    const items = await list()
    log.info("starting gc scan", { count: items.length })

    for (const item of items) {
      try {
        if (item.stale) {
          await unlockStale(item.path, repoRoot)
          log.info("unlocked stale worktree locks", { id: item.id, name: item.name })
        }

        const decision = cleanupState(item)
        if (decision.action === "keep") {
          log.info("gc keeping worktree", { id: item.id, name: item.name, reason: decision.reason })
          continue
        }

        if (decision.action === "prompt") {
          log.info("gc skipping worktree (prompt)", { id: item.id, name: item.name, reason: decision.reason })
          skipped.push(item.id)
          continue
        }

        if (decision.action === "safe_to_remove") {
          log.info("gc removing worktree", { id: item.id, name: item.name, reason: decision.reason })
          const dirty = await isDirty(item.path).catch(() => true)
          if (dirty) {
            log.warn("gc skipping worktree (unexpected dirty)", { id: item.id, name: item.name })
            skipped.push(item.id)
            continue
          }
          const op = await $`git worktree remove ${item.path}`.quiet().nothrow().cwd(repoRoot)
          if (op.exitCode !== 0) {
            log.warn("gc failed to remove worktree", { id: item.id, name: item.name, error: errorText(op) })
            skipped.push(item.id)
          } else {
            if (item.managed) await removeRegistry(item.id, repoRoot)
            removed.push(item.id)
            log.info("gc removed worktree", { id: item.id, name: item.name })
          }
        }
      } catch (error) {
        log.warn("gc error for worktree", { id: item.id, name: item.name, error })
        skipped.push(item.id)
      }
    }

    log.info("gc scan complete", { removed: removed.length, skipped: skipped.length })
    return { removed, skipped }
  }

  export async function markLifecycle(id: string, lifecycle: RegistryInfo["lifecycle"]) {
    const { repoRoot } = ensureGitScope()
    const current = await readJson(registryPath({ id }, repoRoot), RegistryInfo)
    if (!current) return
    const updated = RegistryInfo.parse({ ...current, lifecycle, updatedAt: Date.now() })
    await writeRegistry(updated, repoRoot)
  }
}
