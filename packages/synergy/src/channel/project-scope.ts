import fs from "fs/promises"
import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Global } from "@/global"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"

const Binding = z.object({
  projectID: z.string(),
  scopeID: z.string(),
})

type Identity = {
  channelType: string
  accountId: string
  projectID: string
}

export const ProjectScopeConflictError = NamedError.create(
  "ChannelProjectScopeConflictError",
  z.object({
    expectedScopeID: z.string(),
    actualScopeID: z.string(),
  }),
)

function identityHash(input: Identity): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input.channelType)
  hasher.update("\0")
  hasher.update(input.accountId)
  hasher.update("\0")
  hasher.update(input.projectID)
  return hasher.digest("hex")
}

function workspaceRoot(): string {
  return path.join(Global.Path.data, "channel", "workspaces")
}

function workspacePath(hash: string): string {
  return path.join(workspaceRoot(), hash, "workspace")
}

function staysInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function validateDirectoryChain(target: string, create: boolean): Promise<boolean> {
  const root = path.resolve(Global.Path.data)
  const resolved = path.resolve(target)
  if (!staysInside(root, resolved)) throw new Error("Channel project workspace escapes the data root")

  const relative = path.relative(root, resolved)
  let current = root
  const rootStat = await fs.lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Channel project workspace root must be a real directory")
  }

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (create) {
      await fs.mkdir(current).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      })
    }
    const stat = await fs.lstat(current).catch((error) => {
      if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return false
    if (stat.isSymbolicLink()) throw new Error("Channel project workspace path must not contain symbolic links")
    if (!stat.isDirectory()) throw new Error("Channel project workspace path component is not a directory")
  }
  return true
}

async function readBinding(hash: string) {
  const raw = await Storage.read<unknown>(StoragePath.channelProjectScope(hash)).catch(() => undefined)
  if (raw === undefined) return undefined
  return Binding.parse(raw)
}

export namespace ChannelProjectScope {
  export async function find(input: Identity): Promise<Scope.Project | undefined> {
    const hash = identityHash(input)
    const binding = await readBinding(hash)
    if (!binding || binding.projectID !== input.projectID) return undefined
    const scope = await Scope.fromID(binding.scopeID)
    if (scope?.type !== "project") return undefined
    if (path.resolve(scope.directory) === path.resolve(workspacePath(hash))) return scope
    if (!(await validateDirectoryChain(workspacePath(hash), false))) {
      throw new ProjectScopeConflictError({ expectedScopeID: binding.scopeID, actualScopeID: scope.id })
    }
    const actual = await Scope.fromDirectory(workspacePath(hash)).catch(() => undefined)
    throw new ProjectScopeConflictError({
      expectedScopeID: binding.scopeID,
      actualScopeID: actual?.scope.id ?? scope.id,
    })
  }

  export async function ensure(input: Identity & { projectName?: string }): Promise<Scope.Project> {
    const hash = identityHash(input)
    using _ = await Lock.write(`channel:project-scope:${hash}`)

    const directory = workspacePath(hash)
    await validateDirectoryChain(directory, true)
    const resolved = await Scope.fromDirectory(directory)
    if (resolved.scope.type !== "project")
      throw new Error("Channel project workspace did not resolve to a project Scope")

    const binding = await readBinding(hash)
    if (binding && binding.projectID !== input.projectID) {
      throw new ProjectScopeConflictError({
        expectedScopeID: binding.scopeID,
        actualScopeID: resolved.scope.id,
      })
    }
    if (binding && binding.scopeID !== resolved.scope.id) {
      throw new ProjectScopeConflictError({
        expectedScopeID: binding.scopeID,
        actualScopeID: resolved.scope.id,
      })
    }

    if (!binding) {
      await Storage.write(StoragePath.channelProjectScope(hash), {
        projectID: input.projectID,
        scopeID: resolved.scope.id,
      })
    }

    if (input.projectName !== undefined && resolved.scope.name !== input.projectName) {
      await Scope.updatePersisted({ scopeID: resolved.scope.id, name: input.projectName })
      const updated = await Scope.fromID(resolved.scope.id)
      if (updated?.type === "project") return updated
    }
    return resolved.scope
  }

  export async function archive(input: Identity): Promise<void> {
    const hash = identityHash(input)
    using _ = await Lock.write(`channel:project-scope:${hash}`)
    const binding = await readBinding(hash)
    if (!binding || binding.projectID !== input.projectID) return
    const scope = await Scope.fromID(binding.scopeID)
    if (scope?.type !== "project") return
    if (path.resolve(scope.directory) !== path.resolve(workspacePath(hash))) {
      if (!(await validateDirectoryChain(workspacePath(hash), false))) {
        throw new ProjectScopeConflictError({ expectedScopeID: binding.scopeID, actualScopeID: scope.id })
      }
      const actual = await Scope.fromDirectory(workspacePath(hash)).catch(() => undefined)
      throw new ProjectScopeConflictError({
        expectedScopeID: binding.scopeID,
        actualScopeID: actual?.scope.id ?? scope.id,
      })
    }
    await Scope.remove(scope.id)
  }
}
