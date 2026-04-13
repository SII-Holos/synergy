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

  export async function fromDirectory(directory: string): Promise<{ scope: Scope.Project; sandbox: string }> {
    log.info("fromDirectory", { directory })

    const resolved = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const git = await matches.next().then((x) => x.value)
      await matches.return()
      if (git) {
        let sandbox = path.dirname(git)
        const gitBinary = Bun.which("git")

        let id = await Bun.file(path.join(git, "synergy"))
          .text()
          .then((x) => x.trim())
          .catch(() => undefined)

        if (!gitBinary) {
          return {
            id: id ?? dirHash(sandbox),
            worktree: sandbox,
            sandbox: sandbox,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        if (!id) {
          const roots = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(sandbox)
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
            void Bun.file(path.join(git, "synergy"))
              .write(id)
              .catch(() => undefined)
          }
        }

        if (!id) {
          return {
            id: dirHash(sandbox),
            worktree: sandbox,
            sandbox: sandbox,
            vcs: "git",
          }
        }

        const top = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => path.resolve(sandbox, x.trim()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            sandbox,
            worktree: sandbox,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        sandbox = top

        const worktree = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => {
            const dirname = path.dirname(x.trim())
            if (dirname === ".") return sandbox
            return dirname
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id,
            sandbox,
            worktree: sandbox,
            vcs: Info.shape.vcs.parse(Flag.SYNERGY_FAKE_VCS),
          }
        }

        return {
          id,
          sandbox,
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
    return results
      .filter((data): data is z.infer<typeof Info> => !!data)
      .filter((data) => !data.time?.archived)
      .map((data) => ({
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
    await Storage.update<z.infer<typeof Info>>(StoragePath.scope(pid(scopeID)), (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function touch(scopeID: string) {
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
