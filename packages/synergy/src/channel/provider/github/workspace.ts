import fs from "fs/promises"
import path from "path"
import z from "zod"
import { $ } from "bun"
import { Global } from "@/global"
import { Scope } from "@/scope"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { externalIdentityHash } from "../../../util/identity"
import { buildCredentialCommand } from "./api"

const log = Log.create({ service: "channel.github.workspace" })

const WorkspaceRecord = z.object({
  workspaceHash: z.string(),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  directory: z.string(),
  scopeID: z.string(),
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
      () => undefined,
    )
    if (raw === undefined) return undefined
    const parsed = WorkspaceRecord.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  /**
   * Ensure a checkout exists for the repository thread and return its Scope.
   *
   * - Creates the random-hash directory under the configured workspace root.
   * - Clones the repository (fresh or reuses an existing checkout).
   * - When `pullNumber` is given, fetches `pull/<n>/head` into a local branch
   *   and checks it out so the agent reviews the exact PR head.
   * - Binds the directory to a project Scope (persisted) and records the
   *   mapping in the account workspace index.
   * - When `workspaceTtlHours` is set and the existing checkout has been
   *   unused longer than the TTL, the local clone is removed first and
   *   recreated below. Session history is never touched.
   */
  export async function ensure(input: {
    accountId: string
    workspaceDir: string
    workspaceTtlHours?: number
    repository: string
    issueNumber: number
    pullNumber?: number
    defaultBranch?: string
    token: string
  }): Promise<{ record: WorkspaceRecord; scope: Scope.Project }> {
    const accountHash = externalIdentityHash(input.accountId)
    const directory = resolveDirectory(input)
    const lock = `github-channel:workspace:${accountHash}:${workspaceHash(input.repository, input.issueNumber)}`

    using _ = await Lock.write(lock)

    const recordKey = StoragePath.githubChannelWorkspaceIndexEntry(
      accountHash,
      workspaceHash(input.repository, input.issueNumber),
    )
    const existing = await find(input)

    await fs.mkdir(path.dirname(directory), { recursive: true })
    const repoUrl = `https://github.com/${input.repository}.git`
    const gitDir = path.join(directory, ".git")

    let branch = existing?.branch
    if (input.pullNumber) {
      branch = `pr-${input.pullNumber}`
    }

    // TTL expiry: an unused checkout older than the TTL is removed so the
    // clone is recreated fresh on the next trigger. The workspace record and
    // the thread's session history are preserved.
    const ttlMs = (input.workspaceTtlHours ?? 24) * 60 * 60 * 1_000
    if (existing && Date.now() - (existing.updatedAt ?? 0) > ttlMs) {
      log.info("workspace checkout expired; removing local clone", {
        repository: input.repository,
        issueNumber: input.issueNumber,
        directory,
        ttlHours: input.workspaceTtlHours ?? 24,
      })
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    }

    if (existing && !(await fs.stat(gitDir).catch(() => undefined))) {
      // The checkout disappeared (TTL expiry or user cleanup); recreate it.
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
      await fs.mkdir(directory, { recursive: true })
    }

    const credential = buildCredentialCommand({ token: input.token, args: [] })

    // Run git with the credential helper as a plain argv array so static
    // analysis (knip) recognizes the subcommand; template interpolation of
    // the credential args would otherwise hide `clone`/`fetch`/`pull` behind
    // a dynamic token and trip the unlisted-binaries check.
    const runGit = async (args: string[], options?: { cwd?: string }): Promise<number> => {
      const proc = Bun.spawn(["git", ...credential.args, ...args], {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        env: credential.env,
        stdout: "pipe",
        stderr: "pipe",
      })
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      return proc.exited
    }

    if (!(await fs.stat(gitDir).catch(() => undefined))) {
      log.info("cloning repository workspace", { repository: input.repository, directory })
      const cloneExit = await runGit(["clone", "--no-checkout", repoUrl, directory])
      if (cloneExit !== 0 || !(await fs.stat(gitDir).catch(() => undefined))) {
        throw new Error(`GithubChannelWorkspaceError: clone failed for ${input.repository}`)
      }
      if (input.defaultBranch) {
        await runGit(["checkout", input.defaultBranch], { cwd: directory })
      }
    } else {
      await runGit(["fetch", "origin", "--prune"], { cwd: directory })
    }

    if (input.pullNumber && branch) {
      const fetchRef = `pull/${input.pullNumber}/head:refs/remotes/origin/${branch}`
      const fetched = await runGit(["fetch", "origin", fetchRef], { cwd: directory })
      if (fetched === 0) {
        await $`git checkout ${branch}`.cwd(directory).quiet().nothrow()
        await $`git reset --hard origin/${branch}`.cwd(directory).quiet().nothrow()
      } else {
        log.warn("pull head fetch failed; keeping current checkout", {
          repository: input.repository,
          pullNumber: input.pullNumber,
        })
      }
    } else if (input.defaultBranch) {
      await $`git checkout ${input.defaultBranch}`.cwd(directory).quiet().nothrow()
      await runGit(["pull", "--ff-only", "origin", input.defaultBranch], { cwd: directory })
    }

    const { scope } = await Scope.fromDirectory(directory, { persist: true })
    if (scope.type !== "project") {
      throw new Error(
        `GithubChannelWorkspaceError: workspace did not resolve to a project Scope for ${input.repository}`,
      )
    }

    const now = Date.now()
    const record: WorkspaceRecord = {
      workspaceHash: workspaceHash(input.repository, input.issueNumber),
      repository: input.repository,
      issueNumber: input.issueNumber,
      directory,
      scopeID: scope.id,
      branch,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await Storage.write(recordKey, record)

    return { record, scope }
  }

  export async function list(input: { accountId: string }): Promise<WorkspaceRecord[]> {
    const accountHash = externalIdentityHash(input.accountId)
    const root = StoragePath.githubChannelWorkspaceIndexRoot(accountHash)
    const keys = await Storage.scan(root).catch(() => [])
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
      if (Date.now() - (record.updatedAt ?? 0) <= ttlMs) continue
      log.info("sweeping expired workspace checkout", {
        repository: record.repository,
        issueNumber: record.issueNumber,
        directory: record.directory,
        ttlHours: input.workspaceTtlHours,
      })
      await fs.rm(record.directory, { recursive: true, force: true }).catch(() => {})
      removed += 1
    }
    return removed
  }
}
