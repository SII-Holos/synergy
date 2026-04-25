import z from "zod"
import path from "path"
import { $ } from "bun"
import { existsSync } from "fs"
import { Filesystem } from "../util/filesystem"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { BusEvent } from "@/bus/bus-event"
import {
  type Global as GlobalType,
  type Project as ProjectType,
  Info as InfoSchema,
  type Info as InfoType,
} from "./types"

export type Scope = Scope.Global | Scope.Project

export namespace Scope {
  const log = Log.create({ service: "scope" })

  export type Global = GlobalType
  export type Project = ProjectType
  export const Info = InfoSchema
  export type Info = InfoType

  export const Event = {
    Updated: BusEvent.define("scope.updated", Info),
    Removed: BusEvent.define("scope.removed", z.object({ id: z.string() })),
  }

  export function contains(scope: Scope, targetPath: string): boolean {
    return Filesystem.contains(scope.directory, targetPath)
  }

  export function global(): Scope.Global {
    const home = Flag.SYNERGY_HOSTED ? path.resolve(Flag.SYNERGY_SCOPE_ROOT || "/workspace") : Global.Path.home
    return {
      type: "global",
      id: "global",
      directory: home,
      worktree: home,
    }
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
    return Storage.read<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID))).catch(() => undefined)
  }

  async function writePersisted(data: z.infer<typeof Info>) {
    await Storage.write(StoragePath.scope(pid(data.id)), data)
  }

  export async function fromDirectory(directory: string): Promise<{ scope: Scope; sandbox: string }> {
    log.info("fromDirectory", { directory })

    if (!existsSync(directory)) {
      const existing = await readPersisted(dirHash(directory))
      if (existing && !existing.time?.archived) {
        await remove(existing.id)
        log.info("archived scope for missing directory", { directory, scopeID: existing.id })
      }
      return { scope: global(), sandbox: Global.Path.home }
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
    // synergy/packages/app/src, they probably want the 'synergy' project,
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
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
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
          if (id) {
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
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
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
            return dirname
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id,
            sandbox: directory,
            worktree: directory,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
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

    if (existing?.time?.archived) {
      const scope: Scope.Project = {
        type: "project",
        id: existing.id,
        directory: sandbox,
        worktree: existing.worktree,
        vcs: existing.vcs,
        name: existing.name,
        icon: existing.icon,
        sandboxes: existing.sandboxes ?? [],
        time: existing.time,
      }
      return { scope, sandbox }
    }

    if (!existing) {
      existing = {
        id,
        worktree,
        vcs: vcs as Scope.Project["vcs"],
        sandboxes: [],
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
    }

    if (!existing.sandboxes) existing.sandboxes = []

    const persisted: z.infer<typeof Info> = {
      ...existing,
      worktree,
      vcs: vcs as Scope.Project["vcs"],
      time: { ...existing.time },
    }
    if (sandbox !== persisted.worktree && !persisted.sandboxes.includes(sandbox)) persisted.sandboxes.push(sandbox)
    persisted.sandboxes = persisted.sandboxes.filter((x) => existsSync(x))
    await writePersisted(persisted)

    const scope: Scope.Project = {
      type: "project",
      id: persisted.id,
      directory: sandbox,
      worktree: persisted.worktree,
      vcs: persisted.vcs,
      name: persisted.name,
      icon: persisted.icon,
      sandboxes: persisted.sandboxes,
      time: persisted.time,
    }

    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: persisted,
      },
    })

    return { scope, sandbox }
  }

  export async function listScopeIDs() {
    return Storage.scan(StoragePath.scopeRoot())
  }

  export async function list(): Promise<Scope.Project[]> {
    const ids = await listScopeIDs()
    const results = await Promise.all(ids.map((id) => readPersisted(id)))
    const active = results.filter((data): data is z.infer<typeof Info> => !!data && !data.time?.archived)

    const detached: string[] = []
    const valid = active.filter((data) => {
      if (existsSync(data.worktree)) return true
      detached.push(data.id)
      return false
    })

    if (detached.length > 0) {
      await Promise.all(detached.map((id) => remove(id)))
      log.info("archived scopes with missing worktrees", { ids: detached })
    }

    return valid.map((data) => ({
      type: "project" as const,
      id: data.id,
      directory: data.worktree,
      worktree: data.worktree,
      vcs: data.vcs,
      name: data.name,
      icon: data.icon,
      sandboxes: data.sandboxes,
      time: data.time,
    }))
  }

  export async function setInitialized(scopeID: string) {
    if (scopeID === "global") return
    await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function touch(scopeID: string) {
    if (scopeID === "global") return
    await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
      draft.time.updated = Date.now()
    })
  }

  export async function updatePersisted(input: {
    scopeID: string
    name?: string
    icon?: { url?: string; color?: string }
    archived?: number | null
  }) {
    if (input.scopeID === "global") return undefined
    const result = await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(input.scopeID)), (draft) => {
      if (input.name !== undefined) draft.name = input.name
      if (input.icon !== undefined) {
        draft.icon = { ...draft.icon }
        if (input.icon.url !== undefined) draft.icon!.url = input.icon.url
        if (input.icon.color !== undefined) draft.icon!.color = input.icon.color
      }
      if (input.archived !== undefined) {
        draft.time.archived = input.archived ?? undefined
      }
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }

  export async function remove(scopeID: string) {
    if (scopeID === "global") return undefined
    const result = await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
      draft.time.archived = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Removed.type,
        properties: { id: scopeID },
      },
    })
    return result
  }

  export async function sandboxes(scopeID: string) {
    const data = await readPersisted(scopeID)
    if (!data?.sandboxes) return []
    const { stat } = await import("fs/promises")
    const valid: string[] = []
    for (const dir of data.sandboxes) {
      const s = await stat(dir).catch(() => undefined)
      if (s?.isDirectory()) valid.push(dir)
    }
    return valid
  }
}
