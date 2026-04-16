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
    const home = Global.Path.home
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

    // FIXED BUG: Scope ID Generation from Subdirectories
    // =================================================
    // Previously, when opening a project from a subdirectory (e.g., /project/src),
    // the scope ID was generated before resolving the git repository root.
    // This caused:
    //   - Opening /project/src → ID based on '/project/src', worktree = '/project'
    //   - Opening /project/lib → ID based on '/project/lib', worktree = '/project'
    //   - Result: Different IDs but same worktree, causing confusion
    //
    // The fix ensures:
    //   1. ID is generated AFTER resolving the final worktree (git root)
    //   2. Opening the same project from any subdirectory yields the SAME scope ID
    //   3. The original opening directory is tracked in sandboxes array
    //   4. Git repositories with commits use the first commit hash (stable across machines)
    //   5. Git repositories without commits use dirHash(git_root) not dirHash(subdirectory)

    if (!existsSync(directory)) {
      const existing = await readPersisted(dirHash(directory))
      if (existing && !existing.time?.archived) {
        await remove(existing.id)
        log.info("archived scope for missing directory", { directory, scopeID: existing.id })
      }
      return { scope: global(), sandbox: Global.Path.home }
    }

    const resolved = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const git = await matches.next().then((x) => x.value)
      await matches.return()
      if (git) {
        // Initial sandbox is the directory where .git was found
        // This could be a subdirectory within the actual git repository
        const initialSandbox = path.dirname(git)
        const gitBinary = Bun.which("git")

        // Try to read existing scope ID from .git/synergy file
        let id = await Bun.file(path.join(git, "synergy"))
          .text()
          .then((x) => x.trim())
          .catch(() => undefined)

        if (!gitBinary) {
          // No git binary available, use hash of the directory
          return {
            id: id ?? dirHash(initialSandbox),
            worktree: initialSandbox,
            sandbox: initialSandbox,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        // Try to get the first commit hash to use as a stable ID
        if (!id) {
          const roots = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(initialSandbox)
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
            // Cache the ID in .git/synergy for future use
            void Bun.file(path.join(git, "synergy"))
              .write(id)
              .catch(() => undefined)
          }
        }

        if (!id) {
          // No commits yet, fall back to directory hash
          // CRITICAL: We must wait to generate the hash until we resolve the actual worktree
          return {
            id: null, // Mark as needing deferred ID generation
            worktree: null, // Mark as needing worktree resolution
            sandbox: initialSandbox,
            vcs: "git",
          }
        }

        // Resolve the actual git repository root (top-level directory)
        const top = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(initialSandbox)
          .text()
          .then((x) => path.resolve(initialSandbox, x.trim()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            sandbox: initialSandbox,
            worktree: initialSandbox,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        // Resolve the actual worktree (git common dir for linked worktrees)
        const worktree = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(top)
          .text()
          .then((x) => {
            const dirname = path.dirname(x.trim())
            if (dirname === ".") return top
            return dirname
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id,
            sandbox: top,
            worktree: top,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        return {
          id,
          sandbox: top,
          worktree,
          vcs: "git",
        }
      }

      // Not a git repository, use directory hash directly
      return {
        id: dirHash(directory),
        sandbox: directory,
        worktree: directory,
        vcs: undefined,
      }
    })

    let { id, sandbox, worktree, vcs } = resolved

    // CRITICAL FIX: Handle deferred ID generation for git repos with no commits
    // The ID must be generated based on the FINAL resolved worktree, not the initial subdirectory
    // This prevents duplicate scope IDs when opening the same project from different subdirectories
    if (id === null && worktree === null && sandbox) {
      // This is a git repo with no commits - we need to resolve the actual git root
      const top = await $`git rev-parse --show-toplevel`
        .quiet()
        .nothrow()
        .cwd(sandbox)
        .text()
        .then((x) => path.resolve(sandbox, x.trim()))
        .catch(() => undefined)

      if (top) {
        sandbox = top
        worktree = top
        // Generate ID based on the git root directory - this ensures the same ID
        // regardless of which subdirectory the user opened
        id = dirHash(top)
      } else {
        worktree = sandbox
        id = dirHash(sandbox)
      }
    }

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
    // Track the original opening directory in sandboxes if it's different from worktree
    // This allows us to show all the subdirectories/checkouts where this project was opened
    if (directory !== persisted.worktree && !persisted.sandboxes.includes(directory)) {
      persisted.sandboxes.push(directory)
    }
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
