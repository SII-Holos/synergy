import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { $ } from "bun"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceCatalog, WorkspaceBinding, WorkspaceLocation } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"

export namespace ProjectDirectories {
  export const Record = z
    .object({
      version: z.literal(1),
      scopeID: z.string(),
      revision: z.number().int().nonnegative(),
      mainWorkspaceID: z.string().nullable(),
      additionalWorkspaceIDs: z.array(z.string()),
    })
    .meta({ ref: "ProjectDirectoryConfiguration" })
  export type Record = z.infer<typeof Record>
  export const Folder = z
    .object({
      workspaceID: z.string(),
      generation: z.number().int(),
      path: z.string(),
      available: z.boolean(),
      git: z.boolean(),
    })
    .meta({ ref: "ProjectFolder" })
  export const Result = Record.extend({ folders: z.array(Folder) }).meta({ ref: "ProjectDirectories" })
  export type Result = z.infer<typeof Result>
  const Selection = z.object({
    directories: z.array(z.string().min(1)).min(1).max(32),
    mainDirectory: z.string().min(1),
  })
  export const CreateInput = Selection.extend({ name: z.string().trim().min(1).max(120) }).meta({
    ref: "ProjectCreateInput",
  })
  export const UpdateInput = Selection.extend({ revision: z.number().int().nonnegative() }).meta({
    ref: "ProjectDirectoriesUpdate",
  })
  export const Created = z
    .object({ scope: Scope.Info, directories: Result, existing: z.boolean() })
    .meta({ ref: "ProjectCreated" })
  export const Conflict = NamedError.create("ProjectDirectoriesConflict", z.object({ message: z.string() }))
  export const Invalid = NamedError.create("ProjectDirectoriesInvalid", z.object({ message: z.string() }))

  export async function isGit(directory: string) {
    const result = await $`git rev-parse --show-toplevel`
      .cwd(directory)
      .quiet()
      .nothrow()
      .catch(() => undefined)
    if (!result || result.exitCode !== 0) return false
    return path.resolve(result.text().trim()) === directory
  }

  async function validate(input: z.infer<typeof Selection>) {
    const source = WorkspaceLocation.source()
    const locations = await Promise.all(
      input.directories.map(async (directory) => {
        if (!path.isAbsolute(directory)) throw new Invalid({ message: "Choose an absolute folder path." })
        try {
          const location = await source.identify(directory)
          if (!(await fs.stat(location.path)).isDirectory()) throw new Invalid({ message: "Choose a folder." })
          return location
        } catch (error) {
          if (error instanceof Invalid) throw error
          throw new Invalid({ message: `Cannot access folder: ${directory}. Check that it exists and is readable.` })
        }
      }),
    )
    const unique = [...new Map(locations.map((item) => [item.path, item])).values()]
    if (!path.isAbsolute(input.mainDirectory)) throw new Invalid({ message: "Choose an absolute main folder path." })
    const main = await source.identify(input.mainDirectory).catch(() => {
      throw new Invalid({ message: "The main folder is unavailable. Choose a project folder again." })
    })
    if (!unique.some((item) => item.path === main.path))
      throw new Invalid({ message: "The main folder must be in the project." })
    return { locations: unique, main: main.path, hostID: await source.hostID() }
  }

  export async function create(input: z.input<typeof CreateInput>): Promise<z.infer<typeof Created>> {
    const parsed = CreateInput.parse(input)
    const selection = await validate(parsed)
    const owner = await findMainOwner(selection.main)
    if (owner) return { scope: owner, directories: await get(owner.id), existing: true }
    const discovered = (await Scope.fromDirectory(selection.main, { persist: false })).scope
    if (discovered.type !== "project") throw new Invalid({ message: "A project folder is required." })
    const existing = await Scope.fromID(discovered.id)
    if (existing?.type === "project") return { scope: existing, directories: await get(existing.id), existing: true }
    const created = await WorkspaceAccess.exclusive(
      selection.locations.map((item) => item.path),
      async () => {
        await revalidate(selection)
        const mainOwner = await findMainOwner(selection.main)
        if (mainOwner)
          throw new Conflict({ message: "This folder was just assigned to another project. Open that project." })
        const concurrent = await Scope.fromID(discovered.id)
        if (concurrent?.type === "project")
          throw new Conflict({ message: "This project was just created. Open the existing project." })
        await Config.domainUpdate(
          "general",
          { defaultSessionWorkspace: "main" },
          { root: path.join(discovered.local!.directory, ".synergy") },
        )
        return Storage.transaction(async () => {
          const mainOwner = await findMainOwner(selection.main)
          if (mainOwner)
            throw new Conflict({ message: "This folder was just assigned to another project. Open that project." })
          const concurrent = await Scope.fromID(discovered.id)
          if (concurrent?.type === "project")
            throw new Conflict({ message: "This project was just created. Open the existing project." })
          const scope = await Scope.registerProject({ ...discovered, name: parsed.name })
          const record = await save(scope.id, selection, 0)
          return { scope, record }
        })
      },
    )
    return { scope: created.scope, directories: await describe(created.record), existing: false }
  }

  async function findMainOwner(directory: string) {
    const scopes = await Scope.list()
    const configs = await Storage.readMany<Record>(scopes.map((scope) => StoragePath.projectDirectories(scope.id)))
    for (const [index, config] of configs.entries()) {
      if (!config?.mainWorkspaceID) continue
      const [workspace] = await WorkspaceCatalog.readMany([config.mainWorkspaceID])
      if (workspace?.binding.path === directory) return scopes[index]
    }
  }

  export async function get(scopeID: string): Promise<Result> {
    const [stored] = await Storage.readMany<unknown>([StoragePath.projectDirectories(scopeID)])
    const record = stored ? Record.parse(stored) : await migrateProject(await Scope.resolve({ scopeID }))
    return describe(record)
  }

  export async function update(scopeID: string, input: z.input<typeof UpdateInput>): Promise<Result> {
    const parsed = UpdateInput.parse(input)
    const current = await get(scopeID)
    if (current.revision !== parsed.revision)
      throw new Conflict({ message: "Project folders changed. Reload before saving." })
    const selection = await validate(parsed)
    const all = await WorkspaceCatalog.list(scopeID)
    const roots = [
      ...new Set([
        ...current.folders.map((item) => item.path),
        ...selection.locations.map((item) => item.path),
        ...all
          .filter((item) => item.type === "git_worktree")
          .flatMap((item) => (item.binding.path ? [item.binding.path] : [])),
      ]),
    ]
    const saved = await WorkspaceAccess.exclusive(roots, async () => {
      await revalidate(selection)
      return Storage.transaction(async () => {
        const [latest] = await Storage.readMany<Record>([StoragePath.projectDirectories(scopeID)])
        if (latest?.revision !== parsed.revision)
          throw new Conflict({ message: "Project folders changed. Reload before saving." })
        const record = await save(scopeID, selection, parsed.revision, current)
        return record
      })
    })
    return describe(saved)
  }

  async function revalidate(selection: Awaited<ReturnType<typeof validate>>) {
    for (const location of selection.locations) {
      const current = await WorkspaceLocation.source().identify(location.path)
      if (current.path !== location.path || current.physicalID !== location.physicalID)
        throw new Conflict({ message: "A selected folder changed. Choose it again before saving." })
    }
  }

  async function save(
    scopeID: string,
    selection: Awaited<ReturnType<typeof validate>>,
    revision: number,
    previous?: Result,
  ) {
    const folders = await Promise.all(
      selection.locations.map((location) =>
        WorkspaceCatalog.register({
          scopeID,
          type: "directory",
          hostID: selection.hostID,
          ...location,
        }),
      ),
    )
    const main = folders.find((item) => item.binding.path === selection.main)!
    const record: Record = {
      version: 1,
      scopeID,
      revision: revision + 1,
      mainWorkspaceID: main.id,
      additionalWorkspaceIDs: folders.filter((item) => item.id !== main.id).map((item) => item.id),
    }
    const oldIDs = new Set(previous?.folders.map((item) => item.workspaceID) ?? [])
    const all = await WorkspaceCatalog.list(scopeID)
    const selected = new Set(folders.map((item) => item.id))
    for (const item of all) {
      const origin = typeof item.metadata.originalCheckout === "string" ? item.metadata.originalCheckout : undefined
      if (!selected.has(item.id) && !oldIDs.has(item.id) && !(item.type === "git_worktree" && origin)) continue
      const grants =
        item.type === "git_worktree"
          ? folders
              .filter((folder) => folder.binding.path !== origin && folder.id !== item.id)
              .map((folder) => folder.id)
          : selected.has(item.id)
            ? folders.filter((folder) => folder.id !== item.id).map((folder) => folder.id)
            : []
      if (JSON.stringify(item.sharedWritableWorkspaceIDs) === JSON.stringify(grants)) continue
      const changed = await WorkspaceCatalog.setSharing(item.id, {
        scopeID,
        expectedRevision: item.revision,
        workspaceIDs: grants,
      })
      Storage.afterCommit(() => WorkspaceCatalog.publishUpdated(changed))
    }
    for (const folder of await WorkspaceCatalog.readMany(folders.map((item) => item.id)))
      if (folder) Storage.afterCommit(() => WorkspaceCatalog.publishUpdated(folder))
    await Storage.write(StoragePath.projectDirectories(scopeID), record)
    return record
  }

  async function describe(record: Record): Promise<Result> {
    const ids = [...(record.mainWorkspaceID ? [record.mainWorkspaceID] : []), ...record.additionalWorkspaceIDs]
    const records = await WorkspaceCatalog.readMany(ids)
    const folders = await Promise.all(
      records.map(async (item, index) => {
        if (!item) return { workspaceID: ids[index]!, generation: 1, path: "", available: false, git: false }
        const directory = item.binding.path ?? ""
        const available = await WorkspaceBinding.validate(item.id, record.scopeID).then(
          () => true,
          () => false,
        )
        return {
          workspaceID: item.id,
          generation: item.binding.generation,
          path: directory,
          available,
          git: available && (await isGit(directory)),
        }
      }),
    )
    return { ...record, folders }
  }

  export async function migrateProject(scope: Scope): Promise<Record> {
    const [existing] = await Storage.readMany<Record>([StoragePath.projectDirectories(scope.id)])
    if (existing) return Record.parse(existing)
    const source = WorkspaceLocation.source()
    const hostID = await source.hostID()
    const paths = scope.local ? [...new Set([scope.local.worktree, ...scope.local.sandboxes])] : []
    const git = scope.local
      ? await $`git worktree list --porcelain -z`
          .cwd(scope.local.worktree)
          .quiet()
          .nothrow()
          .catch(() => undefined)
      : undefined
    const worktrees = new Set(
      git?.exitCode === 0
        ? git
            .text()
            .split("\0")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => path.resolve(line.slice(9)))
        : [],
    )
    if (scope.local) worktrees.delete(path.resolve(scope.local.worktree))
    const catalog = await WorkspaceCatalog.list(scope.id)
    for (const record of catalog)
      if (record.type === "git_worktree" && record.binding.path) worktrees.add(record.binding.path)
    const candidates = await Promise.all(
      paths.filter((directory) => !worktrees.has(directory)).map((directory) => source.identify(directory, true)),
    )
    const historical = await Promise.all([...worktrees].map((directory) => source.identify(directory, true)))
    return Storage.transaction(async () => {
      const [concurrent] = await Storage.readMany<Record>([StoragePath.projectDirectories(scope.id)])
      if (concurrent) return Record.parse(concurrent)
      const records = await Promise.all(
        candidates
          .filter((item) => !!item)
          .map((location) => WorkspaceCatalog.register({ scopeID: scope.id, type: "directory", hostID, ...location })),
      )
      for (const location of historical) {
        await WorkspaceCatalog.register({
          scopeID: scope.id,
          type: "git_worktree",
          hostID,
          ...location,
          metadata: {
            originalCheckout: scope.local?.worktree,
            sourceWorkspaceID: records[0]?.id,
            worktreeID: "wt_" + createHash("sha256").update(location.path).digest("hex").slice(0, 16),
            name: path.basename(location.path),
          },
        })
      }
      const migratedTrees = (await WorkspaceCatalog.list(scope.id)).filter((item) => item.type === "git_worktree")
      for (const folder of [...records, ...migratedTrees]) {
        const grants = records
          .filter((other) => other.id !== folder.id && other.binding.path !== folder.metadata.originalCheckout)
          .map((other) => other.id)
        if (!grants.length) continue
        const updated = await WorkspaceCatalog.setSharing(folder.id, {
          scopeID: scope.id,
          expectedRevision: folder.revision,
          workspaceIDs: [...new Set([...folder.sharedWritableWorkspaceIDs, ...grants])],
        })
        Storage.afterCommit(() => WorkspaceCatalog.publishUpdated(updated))
      }
      const record: Record = {
        version: 1,
        scopeID: scope.id,
        revision: 1,
        mainWorkspaceID: records[0]?.id ?? null,
        additionalWorkspaceIDs: records.slice(1).map((item) => item.id),
      }
      await Storage.write(StoragePath.projectDirectories(scope.id), record)
      return record
    })
  }
}
