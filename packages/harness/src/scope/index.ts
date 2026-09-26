import { RuntimeContext } from "../lifecycle/context"
import z from "zod"
import path from "path"
import { $ } from "bun"
import { existsSync, statSync } from "fs"
import { Filesystem } from "../util/filesystem"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Identifier } from "../id/id"
import { iife } from "../util/iife"
import { GlobalBus } from "../bus/global"
import { BusEvent } from "../bus/bus-event"
import {
  Local as LocalSchema,
  type Home as HomeType,
  type Project as ProjectType,
  Runtime as RuntimeSchema,
  Info as InfoSchema,
  type Info as InfoType,
} from "./types"
import { ScopeRoots } from "./roots"
import { isEphemeralTestWorktree } from "./test-artifacts"

export type Scope = Scope.Home | Scope.Project

export namespace Scope {
  const log = Log.create({ service: "scope" })

  export const Local = LocalSchema
  export type Local = import("./types").Local
  export const RequiredError = NamedError.create("ScopeRequired", z.object({ message: z.string() }))
  export const NotFoundError = NamedError.create(
    "ScopeNotFound",
    z.object({ message: z.string(), scopeID: z.string() }),
  )
  export async function resolve(selector: { scopeID?: string; directory?: string }): Promise<Scope> {
    if (selector.scopeID) {
      const scope = await fromID(selector.scopeID)
      if (!scope) throw new NotFoundError({ message: "Scope not found", scopeID: selector.scopeID })
      return scope
    }
    if (selector.directory) return (await fromDirectory(selector.directory)).scope
    throw new RequiredError({ message: "An explicit Scope ID or directory is required." })
  }
  export const WorkspaceRequiredError = NamedError.create(
    "WorkspaceRequired",
    z.object({ message: z.string(), scopeID: z.string() }),
  )
  export const WorkspaceUnavailableError = NamedError.create(
    "WorkspaceUnavailable",
    z.object({ message: z.string(), path: z.string() }),
  )

  export function requireLocal(scope: Scope): Local {
    if (!scope.local)
      throw new WorkspaceRequiredError({
        message: "A local workspace is required for this operation.",
        scopeID: scope.id,
      })
    return scope.local
  }

  export type Home = HomeType
  export type Project = ProjectType
  export const Runtime = RuntimeSchema
  export const Info = InfoSchema
  export type Info = InfoType
  export const Root = ScopeRoots
  export const Event = {
    Updated: BusEvent.define("scope.updated", Info),
    Removed: BusEvent.define("scope.removed", z.object({ id: z.string(), directory: z.string().optional() })),
  }
  export type ArchiveGuard = (scopeID: string) => void | Promise<void>

  const runtimeState = RuntimeContext.state(() => ({
    archiveGuards: new Set<ArchiveGuard>(),
  }))

  export function registerArchiveGuard(guard: ArchiveGuard): () => void {
    const instanceState = runtimeState()

    instanceState.archiveGuards.add(guard)
    return () => instanceState.archiveGuards.delete(guard)
  }

  export function contains(scope: Scope, targetPath: string): boolean {
    return ScopeRoots.projectRoots(scope).some((root) => Filesystem.contains(root, targetPath))
  }

  export function home(): Scope.Home {
    return { type: "home", id: "home", local: null }
  }

  function dirHash(directory: string): string {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(path.resolve(directory))
    return `d_${hasher.digest("hex").slice(0, 16)}`
  }

  function pid(s: string) {
    return Identifier.asScopeID(s)
  }

  async function readPersisted(scopeID: string) {
    return Storage.read<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID))).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  }

  export async function fromID(scopeID: string): Promise<Scope | undefined> {
    if (scopeID === "home") return home()
    const data = await readPersisted(scopeID)
    return data
  }

  function publish<Definition extends BusEvent.Definition>(
    definition: Definition,
    properties: z.output<Definition["properties"]>,
    scopeID: string,
  ) {
    const payload = { type: definition.type, properties: structuredClone(properties) }
    return Storage.enqueue({ id: crypto.randomUUID(), scopeID, type: definition.type, payload }, async () => {
      GlobalBus().emit("event", { scopeID, payload })
    })
  }

  async function writePersisted(data: z.infer<typeof Info>) {
    await Storage.write(StoragePath.scope(pid(data.id)), data)
  }

  async function findByWorktree(worktree: string): Promise<z.infer<typeof Info> | undefined> {
    const resolved = path.resolve(worktree)
    for (const rawID of await Storage.scan(StoragePath.scopeRoot())) {
      const data = await readPersisted(rawID)
      if (!data || data.time?.archived) continue
      if (data.local && path.resolve(data.local.worktree) === resolved) return data
    }
    return undefined
  }

  export async function fromDirectory(
    input: string,
    options?: { persist?: boolean },
  ): Promise<{ scope: Scope; sandbox: string }> {
    const directory = Filesystem.sanitizePath(input)
    const persist = options?.persist ?? true
    log.info("fromDirectory", { directory })

    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new WorkspaceUnavailableError({
        message: "The requested workspace is no longer available.",
        path: directory,
      })
    }

    // TODO: [scope-boundary] Upward .git traversal disabled — see analysis below.
    //
    // Previously, fromDirectory used Filesystem.up() to search for .git in
    // ancestor directories, then resolved the scope to the git repo root.
    // This caused two problems:
    //
    // 1. Over-merging: if $HOME has a dotfiles git (git init ~), ALL
    //    subdirectories resolve to the same scopeID, collapsing every
    //    project into one. More generally, any ancestor .git that the user
    //    doesn't consider a project boundary will silently merge unrelated
    //    directories.
    //
    // 2. Unbounded traversal: Filesystem.up() has no depth limit and no
    //    GIT_CEILING_DIRECTORIES support — it walks all the way to /.
    //    With a dotfiles git this is catastrophic; even without one it's
    //    wasted stat calls through dozens of ancestor directories.
    //
    // The original motivation for upward traversal was: "if a user opens
    // synergy/apps/web/src, they probably want the 'synergy' project,
    // not a碎片 project at 'src'." In practice, users open the directory
    // they consider their project root — if they want the repo root, they
    // open the repo root. The "convenience" of auto-traversal is an
    // assumption that doesn't hold and introduces dangerous ambiguity.
    //
    // New behavior: the directory the user opens IS the project boundary.
    // If the directory contains .git, we still detect VCS info (branch,
    // worktree) for display purposes — but we never traverse upward.
    //
    // If we later want to restore upward traversal, the safe approach would
    // be a multi-signal model with explicit precedence:
    //   1. .synergy marker (user-declared boundary, hard stop)
    //   2. .git in current directory (VCS boundary, hard stop)
    //   3. Project marker files (package.json, Cargo.toml, etc.)
    //   4. The directory itself (fallback, no traversal)
    // With GIT_CEILING_DIRECTORIES respected as an additional ceiling.

    const resolved = await iife(async () => {
      // Check for .git only in the current directory (no upward traversal)
      const gitDir = path.join(directory, ".git")
      const hasGit = existsSync(gitDir)

      if (hasGit) {
        const gitBinary = Bun.which("git")

        let id = await Bun.file(path.join(gitDir, "synergy"))
          .text()
          .then((x) => x.trim())
          .catch(() => undefined)

        if (!gitBinary) {
          return {
            id: id ?? dirHash(directory),
            worktree: directory,
            sandbox: directory,
            vcs: Local.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        if (!id) {
          const roots = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(directory)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
            .catch(() => undefined)

          id = roots?.[0]
          if (id && persist) {
            void Bun.file(path.join(gitDir, "synergy"))
              .write(id)
              .catch(() => undefined)
          }
        }

        if (!id) {
          return {
            id: dirHash(directory),
            worktree: directory,
            sandbox: directory,
            vcs: "git",
          }
        }

        const top = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(directory)
          .text()
          .then((x) => path.resolve(directory, x.trim()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            sandbox: directory,
            worktree: directory,
            vcs: Local.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        const worktree = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(directory)
          .text()
          .then((x) => {
            const dirname = path.dirname(x.trim())
            if (dirname === ".") return directory
            return path.resolve(directory, dirname)
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id,
            sandbox: directory,
            worktree: directory,
            vcs: Local.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        return {
          id,
          sandbox: directory,
          worktree,
          vcs: "git",
        }
      }

      return {
        id: dirHash(directory),
        sandbox: directory,
        worktree: directory,
        vcs: undefined,
      }
    })

    const { id, sandbox, worktree, vcs } = resolved

    let existing = await readPersisted(id)

    // If the derived ID doesn't match any existing scope, check whether this
    // worktree already has a scope under a different ID. This happens when
    // directory characteristics change (e.g. git init adds a commit-based ID
    // to a directory that was previously tracked by path hash). Rather than
    // creating a second scope and fragmenting data, we reuse the existing one
    // and update its metadata.
    if (!existing) {
      const byWorktree = await findByWorktree(worktree)
      if (byWorktree) {
        existing = byWorktree
        log.info("reusing existing scope for worktree", {
          existingID: existing.id,
          derivedID: id,
          worktree,
        })
        // Cache the stable scope ID in .git/synergy so future lookups are instant
        const gitDir = path.join(worktree, ".git")
        if (persist && existsSync(gitDir)) {
          void Bun.file(path.join(gitDir, "synergy"))
            .write(existing.id)
            .catch(() => undefined)
        }
      }
    }

    if (existing?.time?.archived) return { scope: existing, sandbox }

    const local: Local = {
      directory: worktree,
      worktree,
      vcs: vcs as Local["vcs"],
      sandboxes: [...new Set([...(existing?.local?.sandboxes ?? []), ...(sandbox !== worktree ? [sandbox] : [])])],
    }
    const project: Info = {
      ...existing,
      id: existing?.id ?? id,
      type: "project",
      local,
      time: existing?.time ?? { created: Date.now(), updated: Date.now() },
    }
    if (persist && (!existing || JSON.stringify(existing.local) !== JSON.stringify(local))) {
      await Storage.transaction(async () => {
        const latest = await readPersisted(project.id)
        const merged = {
          ...latest,
          ...project,
          local: {
            ...local,
            sandboxes: [...new Set([...(latest?.local?.sandboxes ?? []), ...local.sandboxes])],
          },
        }
        await writePersisted(merged)
        await publish(Event.Updated, merged, merged.id)
      })
    }
    const scope: Scope.Project = { ...project, local: { ...local, directory: sandbox } }

    return { scope, sandbox }
  }

  export async function listScopeIDs() {
    return Storage.scan(StoragePath.scopeRoot())
  }

  export async function list(): Promise<Scope.Project[]> {
    const ids = await listScopeIDs()
    const results = await Promise.all(ids.map((id) => readPersisted(id)))
    const active = results.filter((data): data is z.infer<typeof Info> => !!data && !data.time?.archived)

    return active.filter((data) => !data.local || !isEphemeralTestWorktree(data.local.worktree))
  }

  export async function setInitialized(scopeID: string) {
    if (scopeID === "home") return
    await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function touch(scopeID: string) {
    if (scopeID === "home") return
    await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
      draft.time.updated = Date.now()
    })
  }

  export async function updatePersisted(input: {
    scopeID: string
    name?: string
    icon?: { url?: string; color?: string }
    pinned?: number | null
    archived?: number | null
    sandboxes?: string[]
  }) {
    const instanceState = runtimeState()

    return Storage.transaction(async () => {
      if (input.scopeID === "home") return undefined
      if (input.archived !== undefined && input.archived !== null) {
        for (const guard of instanceState.archiveGuards) await guard(input.scopeID)
      }
      const result = await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(input.scopeID)), (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.icon !== undefined) {
          draft.icon = { ...draft.icon }
          if (input.icon.url !== undefined) draft.icon!.url = input.icon.url
          if (input.icon.color !== undefined) draft.icon!.color = input.icon.color
        }
        if (input.pinned !== undefined) {
          draft.pinned = input.pinned ?? undefined
        }
        if (input.archived !== undefined) {
          draft.time.archived = input.archived ?? undefined
        }
        if (input.sandboxes !== undefined) {
          const local = requireLocal(draft)
          const worktree = path.resolve(local.worktree)
          const seen = new Set<string>()
          local.sandboxes = input.sandboxes
            .filter((s) => path.isAbsolute(s))
            .filter((s) => {
              const resolved = path.resolve(s)
              if (resolved === worktree) return false
              if (seen.has(resolved)) return false
              seen.add(resolved)
              return true
            })
        }
        draft.time.updated = Date.now()
      })
      await publish(Event.Updated, result, result.id)
      return result
    })
  }

  export async function remove(scopeID: string) {
    const instanceState = runtimeState()

    return Storage.transaction(async () => {
      if (scopeID === "home") return undefined
      for (const guard of instanceState.archiveGuards) await guard(scopeID)
      const result = await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
        draft.time.archived = Date.now()
      })
      await publish(Event.Removed, { id: scopeID, directory: result.local?.worktree }, scopeID)
      return result
    })
  }

  export async function sandboxes(scopeID: string) {
    const data = await readPersisted(scopeID)
    if (!data?.local?.sandboxes) return []
    const { stat } = await import("fs/promises")
    const valid: string[] = []
    for (const dir of data.local.sandboxes) {
      const s = await stat(dir).catch(() => undefined)
      if (s?.isDirectory()) valid.push(dir)
    }
    return valid
  }
}
