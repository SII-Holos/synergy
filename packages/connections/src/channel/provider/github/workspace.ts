import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceCatalog, WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceRuntime } from "@ericsanchezok/synergy-harness/workspace/runtime"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { WorktreeProcess } from "@ericsanchezok/synergy-runtime-local/workspace/process"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { externalIdentityHash } from "@ericsanchezok/synergy-harness/util/identity"
import { buildCredentialCommand } from "./api"

const log = Log.create({ service: "channel.github.workspace" })

const WorkspaceRecord = z.object({
  workspaceHash: z.string(),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  directory: z.string(),
  scopeID: z.string(),
  workspaceID: z.string().optional(),
  branch: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>

function workspaceHash(repository: string, issueNumber: number): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(`${repository}#${issueNumber}`)
  return hasher.digest("hex").slice(0, 16)
}

function workspaceRoot(input: { accountId: string; workspaceDir: string }): string {
  // The configured workspaceDir is resolved relative to the Synergy data home
  // so relative values stay inside the home directory.
  return path.resolve(Global.Path.home, input.workspaceDir)
}

export namespace GithubChannelWorkspace {
  /**
   * Resolve the stable per-thread workspace directory for a repository
   * issue/PR thread. Each thread gets one deterministic random-looking hash
   * directory under the configured workspace root; the checkout is created
   * lazily by `ensure`.
   */
  export function resolveDirectory(input: {
    accountId: string
    workspaceDir: string
    repository: string
    issueNumber: number
  }): string {
    const hash = workspaceHash(input.repository, input.issueNumber)
    return path.join(workspaceRoot(input), hash)
  }

  export async function find(input: {
    accountId: string
    repository: string
    issueNumber: number
  }): Promise<WorkspaceRecord | undefined> {
    const accountHash = externalIdentityHash(input.accountId)
    const hash = workspaceHash(input.repository, input.issueNumber)
    const raw = await Storage.read<unknown>(StoragePath.githubChannelWorkspaceIndexEntry(accountHash, hash)).catch(
      (error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      },
    )
    if (raw === undefined) return undefined
    const parsed = WorkspaceRecord.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  async function directoryExists(directory: string) {
    const entry = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error("GitHub checkout must be a real directory")
    return !!entry
  }

  async function binding(record: WorkspaceRecord) {
    if (!record.workspaceID) throw new Error("GitHub checkout has no verified local Workspace binding")
    const workspace = await WorkspaceCatalog.get(record.workspaceID, record.scopeID)
    if (
      workspace.lifecycle !== "active" ||
      workspace.binding.state !== "bound" ||
      workspace.binding.hostID !== (await RuntimeContext.current().host.workspaceLocation!.hostID()) ||
      workspace.binding.path !== record.directory
    )
      throw new Error("GitHub checkout has no verified local Workspace binding")
    if (await directoryExists(record.directory)) await WorkspaceBinding.validate(workspace.id, record.scopeID)
    return workspace
  }

  async function clean(directory: string, signal?: AbortSignal) {
    const run = (args: string[]) =>
      WorktreeProcess.run({
        command: ["git", "-c", "core.fsmonitor=false", ...args],
        directory,
        roots: [],
        metadata: true,
        signal,
        env: { GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      })
    if (!(await directoryExists(path.join(directory, ".git")))) return false
    const status = await run(["status", "--porcelain"])
    if (status.exitCode !== 0 || status.stdout.length) return false
    const commits = await run(["rev-list", "--count", "--all", "--not", "--remotes"])
    return commits.exitCode === 0 && commits.stdout.toString("utf8").trim() === "0"
  }

  export async function ensure(input: {
    accountId: string
    workspaceDir: string
    workspaceTtlHours?: number
    repository: string
    issueNumber: number
    pullNumber?: number
    defaultBranch?: string
    token: string
    signal?: AbortSignal
  }): Promise<{ record: WorkspaceRecord; scope: Scope.Project }> {
    input.signal?.throwIfAborted()
    const accountHash = externalIdentityHash(input.accountId)
    const hash = workspaceHash(input.repository, input.issueNumber)
    using _ = await Lock.write(`github-channel:workspace:${accountHash}:${hash}`)
    input.signal?.throwIfAborted()
    const recordKey = StoragePath.githubChannelWorkspaceIndexEntry(accountHash, hash)
    const existing = await find(input)
    const requested = resolveDirectory(input)
    await fs.mkdir(path.dirname(requested), { recursive: true })
    const parent = await fs.realpath(path.dirname(requested))
    const directory = path.join(parent, path.basename(requested))
    if (existing && path.resolve(existing.directory) !== directory)
      throw new Error("GitHub checkout configuration changed; relocate its Workspace explicitly")
    const before = existing ? await binding(existing) : undefined
    const signal = AbortSignal.any([AbortSignal.timeout(300_000), ...(input.signal ? [input.signal] : [])])
    const branch = input.pullNumber ? `pr-${input.pullNumber}` : input.defaultBranch
    return WorkspaceAccess.maintenance(
      async () => {
        // Git filters and credential helpers are native processes with an unconfined footprint.
        // Reserve it before retirement so concurrent checkouts cannot deadlock while expanding roots.
        await WorkspaceAccess.reserveWrite(null, signal)
        return WorkspaceAccess.retire([directory], async () => {
          if ((await fs.realpath(path.dirname(requested))) !== parent) throw new Error("GitHub checkout parent changed")
          let present = await directoryExists(directory)
          if (existing) await binding(existing)
          if (present && existing && !(await clean(directory, signal)))
            throw new Error("GitHub checkout contains local work or unverified Git metadata")
          const expired =
            existing && Date.now() - existing.updatedAt > Math.max(1, input.workspaceTtlHours ?? 24) * 3_600_000
          if (present && expired) {
            if (!before) throw new Error("GitHub checkout expiry requires a verified Workspace")
            await WorkspaceRuntime.disposeWorkspace(before.id)
            await fs.rm(directory, { recursive: true })
            present = false
          }
          if (present && !existing && (await fs.readdir(directory)).length)
            throw new Error("GitHub checkout directory already contains unowned files")
          const credential = buildCredentialCommand({ token: input.token, args: [] })
          const git = async (args: string[], cwd = directory) => {
            const result = await WorktreeProcess.run({
              command: [
                "git",
                "-c",
                "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
                ...credential.args,
                ...args,
              ],
              directory: cwd,
              roots: null,
              signal,
              env: { ...credential.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
            })
            if (result.exitCode !== 0) throw new Error(`GitHub checkout ${args[0]} failed`)
          }
          const cloned = !(await directoryExists(path.join(directory, ".git")))
          if (!present) await fs.mkdir(directory)
          const owned = cloned ? await RuntimeContext.current().host.workspaceLocation!.identify(directory) : undefined
          let scope: Scope.Project | undefined
          try {
            if (cloned)
              await git(["clone", "--no-checkout", `https://github.com/${input.repository}.git`, directory], parent)
            else await git(["fetch", "origin", "--prune"])
            if (input.pullNumber && branch) {
              await git(["fetch", "origin", `pull/${input.pullNumber}/head:refs/remotes/origin/${branch}`])
              await git(["checkout", "-B", branch, `refs/remotes/origin/${branch}`])
            } else if (input.defaultBranch) {
              await git(["checkout", input.defaultBranch])
              if (!cloned) await git(["pull", "--ff-only", "origin", input.defaultBranch])
            } else if (cloned) await git(["checkout"])
            const resolved = (await Scope.fromDirectory(directory, { persist: true })).scope
            if (resolved.type !== "project" || (existing && existing.scopeID !== resolved.id))
              throw new Error("GitHub checkout changed its owning Scope")
            scope = resolved
            const location = await RuntimeContext.current().host.workspaceLocation!.identify(directory)
            const rebound = before
              ? before.binding.physicalID === location.physicalID
                ? before
                : await WorkspaceBinding.rebind(
                    before.id,
                    {
                      scopeID: before.scopeID,
                      expectedRevision: before.revision,
                      path: directory,
                    },
                    signal,
                  )
              : undefined
            return await Storage.transaction(async () => {
              const workspace = rebound ?? (await WorkspaceBinding.register(resolved.id, directory))
              const now = Date.now()
              const record: WorkspaceRecord = {
                workspaceHash: hash,
                repository: input.repository,
                issueNumber: input.issueNumber,
                directory,
                scopeID: resolved.id,
                workspaceID: workspace.id,
                branch,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
              }
              await Storage.write(recordKey, record)
              return { record, scope: resolved }
            })
          } catch (error) {
            if (owned) {
              const current = await RuntimeContext.current()
                .host.workspaceLocation!.identify(directory)
                .catch(() => undefined)
              const published = scope
                ? (await WorkspaceCatalog.list(scope.id)).some((entry) => entry.binding.physicalID === owned.physicalID)
                : false
              if (!published && current?.physicalID === owned.physicalID) await fs.rm(directory, { recursive: true })
            }
            throw error
          }
        })
      },
      { signal },
    )
  }

  export async function list(input: { accountId: string }): Promise<WorkspaceRecord[]> {
    const accountHash = externalIdentityHash(input.accountId)
    const root = StoragePath.githubChannelWorkspaceIndexRoot(accountHash)
    const keys = await Storage.scan(root)
    if (keys.length === 0) return []
    const records = await Storage.readMany<unknown>(keys.map((key) => [...root, key]))
    return records.flatMap((raw) => {
      const parsed = WorkspaceRecord.safeParse(raw)
      return parsed.success ? [parsed.data] : []
    })
  }

  /**
   * Remove local clones whose records are older than the TTL. Session
   * history and workspace index records are preserved; the checkout is
   * recreated by `ensure` the next time the thread is triggered.
   * Returns the number of removed checkouts.
   */
  export async function sweep(input: { accountId: string; workspaceTtlHours: number }): Promise<number> {
    const ttlMs = Math.max(1, input.workspaceTtlHours) * 60 * 60 * 1_000
    const records = await list(input)
    let removed = 0
    for (const record of records) {
      if (Date.now() - record.updatedAt <= ttlMs || !record.workspaceID) continue
      using _ = await Lock.write(
        `github-channel:workspace:${externalIdentityHash(input.accountId)}:${record.workspaceHash}`,
      )
      try {
        await WorkspaceAccess.maintenance(() =>
          WorkspaceAccess.retire([record.directory], async () => {
            const current = await find({
              accountId: input.accountId,
              repository: record.repository,
              issueNumber: record.issueNumber,
            })
            if (
              !current ||
              current.workspaceID !== record.workspaceID ||
              current.directory !== record.directory ||
              Date.now() - current.updatedAt <= ttlMs
            )
              return
            const workspace = await binding(current)
            if (!workspace || !(await directoryExists(current.directory)) || !(await clean(current.directory))) return
            await WorkspaceRuntime.disposeWorkspace(workspace.id)
            await fs.rm(current.directory, { recursive: true })
            removed++
          }),
        )
      } catch (error) {
        log.warn("GitHub checkout retained during expiry", { workspaceHash: record.workspaceHash, error })
      }
    }
    return removed
  }
}
