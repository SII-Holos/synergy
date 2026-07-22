import fs from "fs/promises"
import path from "path"
import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Global } from "@/global"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import { Vcs } from "@/project/vcs"
import { ObservabilityIssues } from "@/observability/issues"

const RemoteState = z.enum(["active", "paused", "stale", "archived"])
type RemoteState = z.infer<typeof RemoteState>

export type OwnershipIdentity = {
  channelType: string
  accountId: string
  externalProjectId: string
}

const OwnershipRecord = z.object({
  channelType: z.string(),
  accountId: z.string(),
  externalProjectId: z.string(),
  scopeID: z.string(),
  directory: z.string(),
  remoteState: RemoteState,
  createdAt: z.number(),
  lastSeenAt: z.number(),
})
export type OwnershipRecord = z.infer<typeof OwnershipRecord>

export const OwnershipMismatchError = NamedError.create(
  "ManagedProjectOwnershipMismatchError",
  z.object({
    scopeID: z.string(),
    actualChannelType: z.string(),
    actualAccountId: z.string(),
    actualExternalProjectId: z.string(),
  }),
)
export const ManagedProjectArchiveError = NamedError.create(
  "ManagedProjectArchiveError",
  z.object({
    scopeID: z.string(),
    remoteState: z.enum(["active", "paused"]),
  }),
)

function identityHash(input: OwnershipIdentity): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input.channelType)
  hasher.update("\0")
  hasher.update(input.accountId)
  hasher.update("\0")
  hasher.update(input.externalProjectId)
  return hasher.digest("hex")
}

function workspaceRoot(): string {
  return path.join(Global.Path.data, "channel", "workspaces")
}

function workspaceDirectory(hash: string): string {
  return path.join(workspaceRoot(), hash, "workspace")
}

function staysInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function validateDirectoryChain(target: string, create: boolean): Promise<boolean> {
  const root = path.resolve(Global.Path.data)
  const resolved = path.resolve(target)
  if (!staysInside(root, resolved)) throw new Error("Channel managed project workspace escapes the data root")

  const relative = path.relative(root, resolved)
  let current = root
  const rootStat = await fs.lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Channel managed project workspace root must be a real directory")
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
    if (stat.isSymbolicLink()) throw new Error("Channel managed project workspace path must not contain symbolic links")
    if (!stat.isDirectory()) throw new Error("Channel managed project workspace path component is not a directory")
  }
  return true
}

async function readForward(hash: string): Promise<OwnershipRecord | undefined> {
  const raw = await Storage.read<unknown>(StoragePath.channelManagedOwnership(hash)).catch(() => undefined)
  if (raw === undefined) return undefined
  return OwnershipRecord.parse(raw)
}

async function readReverse(scopeID: string): Promise<OwnershipIdentity | undefined> {
  const raw = await Storage.read<unknown>(StoragePath.channelManagedOwnershipReverse(scopeID)).catch(() => undefined)
  if (raw === undefined) return undefined
  const identity = z
    .object({
      channelType: z.string(),
      accountId: z.string(),
      externalProjectId: z.string(),
    })
    .parse(raw)
  return identity
}

async function writeForward(hash: string, record: OwnershipRecord): Promise<void> {
  await Storage.write(StoragePath.channelManagedOwnership(hash), record)
}

async function writeReverse(scopeID: string, identity: OwnershipIdentity): Promise<void> {
  await Storage.write(StoragePath.channelManagedOwnershipReverse(scopeID), identity)
}

function validateAndRepairReverse(hash: string, record: OwnershipRecord): void {
  const expectedIdentity: OwnershipIdentity = {
    channelType: record.channelType,
    accountId: record.accountId,
    externalProjectId: record.externalProjectId,
  }
  const expectedHash = identityHash(expectedIdentity)
  if (expectedHash !== hash) {
    throw new OwnershipMismatchError({
      scopeID: record.scopeID,
      actualChannelType: record.channelType,
      actualAccountId: record.accountId,
      actualExternalProjectId: record.externalProjectId,
    })
  }
}

async function resolveScope(directory: string, hash: string): Promise<Scope.Project> {
  await Vcs.initIfNeeded(directory, { searchParents: false })
  await Bun.write(path.join(directory, ".git", "synergy"), `d_${hash.slice(0, 16)}`)
  const resolved = await Scope.fromDirectory(directory)
  if (resolved.scope.type !== "project") {
    throw new Error("Channel managed project workspace did not resolve to a project Scope")
  }
  return resolved.scope
}

export namespace ManagedProjectOwnership {
  export async function ensure(
    input: OwnershipIdentity & { projectName?: string; remoteState: RemoteState },
  ): Promise<OwnershipRecord> {
    const hash = identityHash(input)
    using _ = await Lock.write(`channel:managed-ownership:${hash}`)

    const directory = workspaceDirectory(hash)
    await validateDirectoryChain(directory, true)
    const scope = await resolveScope(directory, hash)

    const reverseIdentity = await readReverse(scope.id)
    if (reverseIdentity && identityHash(reverseIdentity) !== hash) {
      throw new OwnershipMismatchError({
        scopeID: scope.id,
        actualChannelType: reverseIdentity.channelType,
        actualAccountId: reverseIdentity.accountId,
        actualExternalProjectId: reverseIdentity.externalProjectId,
      })
    }

    const existing = await readForward(hash)

    if (existing) {
      validateAndRepairReverse(hash, existing)

      if (existing.scopeID !== scope.id) {
        throw new OwnershipMismatchError({
          scopeID: existing.scopeID,
          actualChannelType: scope.id,
          actualAccountId: input.accountId,
          actualExternalProjectId: input.externalProjectId,
        })
      }

      if (path.resolve(existing.directory) !== path.resolve(directory)) {
        throw new OwnershipMismatchError({
          scopeID: existing.scopeID,
          actualChannelType: existing.directory,
          actualAccountId: directory,
          actualExternalProjectId: input.externalProjectId,
        })
      }

      const updated: OwnershipRecord = {
        ...existing,
        remoteState: input.remoteState,
        lastSeenAt: Date.now(),
      }

      if (input.projectName !== undefined && existing.lastSeenAt === existing.createdAt && scope.name === undefined) {
        await Scope.updatePersisted({ scopeID: scope.id, name: input.projectName })
      }

      await writeForward(hash, updated)
      await writeReverse(scope.id, {
        channelType: input.channelType,
        accountId: input.accountId,
        externalProjectId: input.externalProjectId,
      })
      return { ...updated }
    }

    const now = Date.now()

    if (input.projectName !== undefined) {
      await Scope.updatePersisted({ scopeID: scope.id, name: input.projectName })
    }

    const record: OwnershipRecord = {
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
      scopeID: scope.id,
      directory: scope.directory,
      remoteState: input.remoteState,
      createdAt: now,
      lastSeenAt: now,
    }

    await writeForward(hash, record)
    await writeReverse(scope.id, {
      channelType: input.channelType,
      accountId: input.accountId,
      externalProjectId: input.externalProjectId,
    })

    return { ...record }
  }

  export async function find(input: OwnershipIdentity): Promise<OwnershipRecord | undefined> {
    const hash = identityHash(input)
    const record = await readForward(hash)
    if (!record) return undefined

    const reverseIdentity = await readReverse(record.scopeID)
    if (reverseIdentity && identityHash(reverseIdentity) !== hash) {
      throw new OwnershipMismatchError({
        scopeID: record.scopeID,
        actualChannelType: reverseIdentity.channelType,
        actualAccountId: reverseIdentity.accountId,
        actualExternalProjectId: reverseIdentity.externalProjectId,
      })
    }

    validateAndRepairReverse(hash, record)
    return { ...record }
  }

  export async function findByScopeID(scopeID: string): Promise<OwnershipRecord | undefined> {
    const reverseIdentity = await readReverse(scopeID)
    if (!reverseIdentity) return undefined

    const hash = identityHash(reverseIdentity)
    const record = await readForward(hash)
    if (!record) {
      await Storage.remove(StoragePath.channelManagedOwnershipReverse(scopeID))
      return undefined
    }

    if (record.scopeID !== scopeID) {
      throw new OwnershipMismatchError({
        scopeID,
        actualChannelType: record.channelType,
        actualAccountId: record.accountId,
        actualExternalProjectId: record.externalProjectId,
      })
    }

    validateAndRepairReverse(hash, record)
    return { ...record }
  }

  export async function markArchived(input: OwnershipIdentity): Promise<OwnershipRecord> {
    const hash = identityHash(input)
    using _ = await Lock.write(`channel:managed-ownership:${hash}`)

    const existing = await readForward(hash)
    if (!existing) {
      throw new Error("No managed project ownership to archive")
    }

    validateAndRepairReverse(hash, existing)

    const updated: OwnershipRecord = {
      ...existing,
      remoteState: "archived",
      lastSeenAt: Date.now(),
    }

    await writeForward(hash, updated)
    return { ...updated }
  }

  export async function markStale(input: OwnershipIdentity): Promise<OwnershipRecord> {
    const hash = identityHash(input)
    using _ = await Lock.write(`channel:managed-ownership:${hash}`)

    const existing = await readForward(hash)
    if (!existing) {
      throw new Error("No managed project ownership to mark stale")
    }

    validateAndRepairReverse(hash, existing)

    const updated: OwnershipRecord = {
      ...existing,
      remoteState: "stale",
      lastSeenAt: Date.now(),
    }

    await writeForward(hash, updated)
    return { ...updated }
  }
  export async function list(input: { channelType: string; accountId: string }): Promise<OwnershipRecord[]> {
    const records = await readAllRecords()
    return records.filter((record) => record.channelType === input.channelType && record.accountId === input.accountId)
  }

  export async function listAll(): Promise<OwnershipRecord[]> {
    return readAllRecords()
  }

  async function readAllRecords(): Promise<OwnershipRecord[]> {
    const hashes = await Storage.scan(["channel", "managed_ownership"])
    if (hashes.length === 0) return []
    const keys = hashes.map((hash) => ["channel", "managed_ownership", hash])
    const records = await Storage.readMany<unknown>(keys)
    const valid: OwnershipRecord[] = []
    for (let index = 0; index < records.length; index++) {
      const raw = records[index]
      if (raw === undefined || raw === null) continue
      const parsed = OwnershipRecord.safeParse(raw)
      if (parsed.success) {
        valid.push(parsed.data)
        continue
      }
      const recordHash = hashes[index]?.slice(0, 128) ?? "unknown"
      ObservabilityIssues.raise({
        code: "CHANNEL_MANAGED_OWNERSHIP_RECORD_INVALID",
        severity: "warning",
        module: "channel",
        title: "Managed project ownership record is invalid",
        message: "A managed project ownership record was skipped because it failed schema validation.",
        recommendation:
          "Inspect or remove the corrupt ownership record before relying on complete project reconciliation.",
        evidence: { recordHash, issueCount: parsed.error.issues.length },
        fingerprint: `channel:managed-ownership:invalid:${recordHash}`,
      })
    }
    return valid
  }
}
Scope.registerArchiveGuard(async (scopeID) => {
  const ownership = await ManagedProjectOwnership.findByScopeID(scopeID)
  if (!ownership || (ownership.remoteState !== "active" && ownership.remoteState !== "paused")) return
  throw new ManagedProjectArchiveError({ scopeID, remoteState: ownership.remoteState })
})
