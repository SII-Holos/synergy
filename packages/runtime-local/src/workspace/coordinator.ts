import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { FileLockTimeoutError, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { processStartIdentity } from "@ericsanchezok/synergy-util/process-identity"
import { retrySleep } from "@ericsanchezok/synergy-util/retry"
import { AtomicFile } from "@ericsanchezok/synergy-harness/storage/atomic-file"
import { FileMutation } from "../file/mutation"

const Root = z.object({ path: z.string(), physicalID: z.string().optional() })
const Claim = z.object({
  id: z.string(),
  token: z.string(),
  owner: z.string(),
  ancestors: z.array(z.string()),
  kind: z.enum(["use", "task", "operation", "process", "exclusive"]),
  parentClaim: z.string().optional(),
  roots: z.array(Root).nullable(),
  useRoots: z.array(Root).default([]),
  pid: z.number().int().positive(),
  startIdentity: z.string().optional(),
  processBound: z.boolean().default(false),
  state: z.enum(["waiting", "active"]),
})
const Ledger = z.object({ version: z.literal(1), claims: z.array(Claim) })
type Claim = z.infer<typeof Claim>
type Ledger = z.infer<typeof Ledger>

export interface WorkspaceClaimInput {
  id: string
  owner: string
  ancestors: string[]
  kind: Claim["kind"]
  roots: string[] | null
  useRoots?: string[]
  parentClaim?: string
  processID?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export const WorkspaceBusyError = WorkspaceAccess.BusyError

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
function overlaps(a: Claim["roots"], b: Claim["roots"]) {
  if (a?.length === 0 || b?.length === 0) return false
  if (a === null || b === null) return true
  return a.some((left) =>
    b.some(
      (right) =>
        contains(left.path, right.path) ||
        contains(right.path, left.path) ||
        (!!left.physicalID && left.physicalID === right.physicalID),
    ),
  )
}
function covers(a: Claim["roots"], b: Claim["roots"]) {
  if (a === null) return true
  return (
    b !== null &&
    b.every((right) =>
      a.some((left) => contains(left.path, right.path) || (!!left.physicalID && left.physicalID === right.physicalID)),
    )
  )
}
function conflicts(request: Claim, held: Claim) {
  if (request.id === held.id) return false
  if (request.kind === "exclusive" && overlaps(request.roots, held.useRoots)) return true
  if (held.kind === "exclusive" && overlaps(held.roots, request.useRoots)) return true
  if ((request.kind === "use" && held.kind !== "exclusive") || (held.kind === "use" && request.kind !== "exclusive"))
    return false
  if (request.parentClaim === held.id && request.owner === held.owner) return false
  if (
    request.kind === "task" &&
    held.kind === "operation" &&
    held.parentClaim === request.id &&
    held.owner === request.owner
  )
    return false
  return overlaps(request.roots, held.roots)
}

export class WorkspaceCoordinator {
  private readonly live = new Map<string, number>()
  private directoryPromise?: Promise<string>
  constructor(private readonly options: { directory?: string } = {}) {}

  private directory() {
    return (this.directoryPromise ??= (async () => {
      if (!this.options.directory) return FileMutation.lockDirectory()
      const directory = this.options.directory
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const stat = await fs.lstat(directory)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
      )
        throw new Error("Workspace coordination directory is not private")
      return directory
    })())
  }

  private async alive(claim: Pick<Claim, "pid" | "startIdentity">, fresh = false) {
    const key = `${claim.pid}:${claim.startIdentity}`
    if (!fresh && (this.live.get(key) ?? 0) > Date.now()) return true
    try {
      process.kill(claim.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        this.live.delete(key)
        return false
      }
    }
    const actual = claim.startIdentity ? await processStartIdentity(claim.pid) : undefined
    if (actual !== undefined && actual !== claim.startIdentity) {
      this.live.delete(key)
      return false
    }
    if (this.live.size > 1024) this.live.clear()
    this.live.set(key, Date.now() + 500)
    return true
  }

  private async update<T>(
    fn: (ledger: Ledger) => Promise<T> | T,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) {
    const directory = await this.directory()
    return withFileLock(
      { directory, key: "workspace-coordinator-v1", signal: options?.signal, timeoutMs: options?.timeoutMs },
      async () => {
        const filename = path.join(directory, "workspace-claims-v1.json")
        const raw = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        const ledger = raw === undefined ? { version: 1 as const, claims: [] } : Ledger.parse(JSON.parse(raw))
        const alive = await Promise.all(ledger.claims.map((claim) => this.alive(claim)))
        ledger.claims = ledger.claims.filter((_claim, index) => alive[index])
        const result = await fn(ledger)
        const serialized = JSON.stringify(ledger)
        if (raw !== serialized) await AtomicFile.writeJsonAtomic(filename, serialized, { durable: true, private: true })
        return result
      },
    )
  }

  async acquire(input: WorkspaceClaimInput) {
    input.signal?.throwIfAborted()
    if (input.roots?.some((root) => !path.isAbsolute(root))) throw new Error("Workspace claim roots must be absolute")
    if (input.useRoots?.some((root) => !path.isAbsolute(root))) throw new Error("Workspace use roots must be absolute")
    if (input.processID !== undefined && (!Number.isInteger(input.processID) || input.processID <= 0))
      throw new Error("Invalid Workspace process ID")
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0))
      throw new Error("Invalid Workspace admission timeout")
    const deadline = Date.now() + (input.timeoutMs ?? 120_000)
    const canonicalRoots = async (values: string[] | null) =>
      values === null
        ? null
        : await Promise.all(
            [...new Set(values)].map(async (root) => {
              let canonical = await FileMutation.canonical(root)
              if (process.platform === "win32") canonical = canonical.toLowerCase()
              const stat = await fs.stat(canonical, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error
              })
              return { path: canonical, physicalID: stat ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : undefined }
            }),
          )
    const roots = await canonicalRoots(input.roots)
    const useRoots = (await canonicalRoots(input.useRoots ?? []))!
    const pid = input.processID ?? process.pid
    const request: Claim = {
      id: input.id,
      token: randomUUID(),
      owner: input.owner,
      ancestors: input.ancestors,
      kind: input.kind,
      parentClaim: input.parentClaim,
      roots,
      useRoots,
      pid,
      startIdentity: await processStartIdentity(pid),
      processBound: input.processID !== undefined,
      state: "waiting",
    }
    let registered = false
    let created = false
    try {
      for (;;) {
        input.signal?.throwIfAborted()
        if (Date.now() >= deadline) throw new WorkspaceBusyError("Workspace is busy; the writable roots are in use")
        const granted = await this.update(
          (ledger) => {
            const own = ledger.claims.find((claim) => claim.id === request.id)
            if (own && own.owner !== request.owner) throw new Error("Workspace claim identity belongs to another owner")
            if (!registered) {
              if (own?.state === "active" && covers(own.roots, roots)) request.token = own.token
              else {
                ledger.claims = ledger.claims.filter((claim) => claim.id !== request.id)
                if (ledger.claims.length >= 1024) throw new WorkspaceBusyError("Workspace coordination queue is busy")
                ledger.claims.push(request)
                created = true
              }
              registered = true
            }
            const index = ledger.claims.findIndex((claim) => claim.id === request.id && claim.token === request.token)
            if (index < 0) throw new WorkspaceBusyError("Workspace claim was cancelled or superseded")
            const current = ledger.claims[index]!
            const parent = ledger.claims.find(
              (claim) => claim.id === current.parentClaim && claim.owner === current.owner && claim.state === "active",
            )
            const alreadyAdmitted = parent?.kind === "task" && covers(parent.roots, current.roots)
            if (current.parentClaim && !alreadyAdmitted)
              throw new WorkspaceBusyError("Workspace parent reservation is no longer available")
            const blockers = ledger.claims.filter(
              (claim, position) =>
                (claim.state === "active" || (!alreadyAdmitted && position < index)) && conflicts(current, claim),
            )
            if (
              blockers.some(
                (claim) =>
                  claim.kind === "process" &&
                  (claim.owner === current.owner ||
                    current.ancestors.includes(claim.owner) ||
                    claim.ancestors.includes(current.owner)),
              )
            )
              throw new WorkspaceBusyError(
                "A process owned by this session or its parent is still using the Workspace; wait for its exit or stop it before writing",
              )
            if (blockers.length) return false
            current.state = "active"
            return true
          },
          { signal: input.signal, timeoutMs: Math.max(1, deadline - Date.now()) },
        )
        if (granted) break
        await retrySleep(Math.min(25, Math.max(1, deadline - Date.now())), input.signal)
      }
    } catch (error) {
      if (created) await this.release(request.id, request.token)
      if (error instanceof FileLockTimeoutError)
        throw new WorkspaceBusyError("Workspace is busy; coordination admission timed out")
      throw error
    }
    return {
      id: request.id,
      release: () => this.release(request.id, request.token),
      bindProcess: (processID: number) => this.bindProcess(request.id, request.token, processID),
    }
  }

  private async bindProcess(id: string, token: string, pid: number) {
    const identity = await processStartIdentity(pid)
    if (!identity) throw new Error("Cannot verify the Workspace process identity")
    await this.update((ledger) => {
      const claim = ledger.claims.find((claim) => claim.id === id && claim.token === token)
      if (!claim || claim.kind !== "process" || claim.processBound)
        throw new Error("Workspace process claim is not pending")
      claim.pid = pid
      claim.startIdentity = identity
      claim.processBound = true
    })
  }

  private async release(id: string, token: string) {
    await this.update(async (ledger) => {
      const claim = ledger.claims.find((claim) => claim.id === id && claim.token === token)
      if (!claim) return
      if (claim.kind === "process" && claim.processBound && (await this.alive(claim, true))) return
      ledger.claims = ledger.claims.filter((claim) => claim.id !== id || claim.token !== token)
    })
  }

  inspect() {
    return this.update((ledger) => ledger.claims)
  }
}
