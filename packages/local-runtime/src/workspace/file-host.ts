import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { identifyFilesystemObject } from "@ericsanchezok/synergy-util/filesystem-identity"
import { WorkspaceProtocol, type WorkspaceFileHost } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"
import { SensitivePathPolicy } from "@ericsanchezok/synergy-harness/enforcement/sensitive-path"
import { NativeFileEntry } from "../file/entry-core"
import { NativeFileMutation } from "../file/mutation-core"
import { WorkspaceCoordinator } from "./coordinator"
import { NativeWorkspaceTree } from "./tree"

const MountReceipt = z.object({
  input: WorkspaceProtocol.MountInput,
  digest: z.string(),
  mount: WorkspaceProtocol.Mount.optional(),
  detached: z.boolean().default(false),
})
const Receipt = z.object({
  id: z.string(),
  digest: z.string(),
  mount: WorkspaceProtocol.Reference,
  claim: z.object({ id: z.string(), token: z.string() }).optional(),
  checkpoint: WorkspaceProtocol.Checkpoint.optional(),
  released: z.boolean().default(false),
  effectStarted: z.boolean().default(false),
  effectCompleted: z.boolean().default(false),
  error: z.string().optional(),
  failure: WorkspaceErrors.Failure.optional(),
})
type Receipt = z.infer<typeof Receipt>

export class NativeWorkspaceFiles implements WorkspaceFileHost {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly shutdown = new AbortController()
  constructor(
    private readonly options: {
      directory: string
      materializationRoot: string
      coordinator: WorkspaceCoordinator
      allowedRoots?: string[]
      owner?: { uid: number; gid: number }
      executionWriter?(id: string, root: string): Promise<void>
    },
  ) {}

  private filename(kind: string, id: string) {
    return path.join(this.options.directory, kind, createHash("sha256").update(id).digest("hex"))
  }
  private digest(value: unknown) {
    return WorkspaceTree.hash(new TextEncoder().encode(JSON.stringify(value)))
  }
  private async persist(kind: string, id: string, value: unknown) {
    await AtomicFile.writeJsonAtomic(this.filename(kind, id), JSON.stringify(value), { private: true, durable: true })
  }
  private async receipt(kind: string, id: string): Promise<unknown> {
    const file = Bun.file(this.filename(kind, id))
    return (await file.exists()) ? file.json() : undefined
  }
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted()
    for (;;) {
      const current = this.pending.get(key)
      if (!current) break
      await current.catch(() => {})
      this.shutdown.signal.throwIfAborted()
    }
    const promise = fn()
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      this.pending.delete(key)
    }
  }

  async mount(raw: WorkspaceProtocol.MountInput): Promise<WorkspaceProtocol.Mount> {
    const input = WorkspaceProtocol.MountInput.parse(raw)
    return this.serial(`mount:${input.id}`, async () => {
      const digest = this.digest(input)
      const previous = MountReceipt.optional().parse(await this.receipt("mounts", input.id))
      if (previous && (previous.digest !== digest || previous.detached))
        throw new Error("Workspace mount already has different input or was detached")
      if (previous?.mount) return this.required(input)
      await this.persist("mounts", input.id, { input, digest })
      const root =
        input.source.kind === "directory"
          ? await fs.realpath(input.source.path)
          : path.join(await this.materializationRoot(), createHash("sha256").update(input.id).digest("hex"))
      if (input.source.kind === "directory" && this.options.allowedRoots) {
        const allowed = await Promise.all(this.options.allowedRoots.map((root) => fs.realpath(root)))
        if (!allowed.some((parent) => this.contains(parent, root)))
          throw new Error("Workspace path is not an allowed mount")
      }
      const claim = await this.options.coordinator.acquire({
        id: `mount:${input.id}`,
        owner: input.id,
        ancestors: [],
        roots: [root],
        kind: input.source.kind === "directory" ? "use" : "exclusive",
        signal: this.shutdown.signal,
      })
      try {
        if (input.source.kind === "materialized") {
          const manifest = WorkspaceTree.Manifest.parse(
            JSON.parse(
              new TextDecoder().decode(await this.getBlob(input.source.manifest, WorkspaceTree.manifestBytes)),
            ),
          )
          const exists = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
          if (exists) {
            const actual = WorkspaceTree.hash(
              WorkspaceTree.encode(await NativeWorkspaceTree.capture(root, this.blobs(), this.shutdown.signal)),
            )
            if (actual !== input.source.manifest)
              throw new Error("Materialized Workspace changed before mount acknowledgement")
          } else
            await NativeWorkspaceTree.materialize(root, manifest, this.blobs(), {
              owner: this.options.owner,
              signal: this.shutdown.signal,
            })
        }
        const identity = await identifyFilesystemObject(root)
        if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace mount is not a directory")
        const mount = WorkspaceProtocol.Mount.parse({ ...input, path: root, physicalID: identity.physicalID })
        await this.persist("mounts", input.id, { input, digest, mount })
        return mount
      } finally {
        await claim.release()
      }
    })
  }

  private async materializationRoot() {
    await fs.mkdir(this.options.materializationRoot, { recursive: true, mode: 0o711 })
    return fs.realpath(this.options.materializationRoot)
  }
  async inspect(reference: WorkspaceProtocol.Reference) {
    const input = WorkspaceProtocol.Reference.parse(reference)
    const receipt = MountReceipt.optional().parse(await this.receipt("mounts", input.id))
    if (!receipt || receipt.detached || !receipt.mount) return undefined
    const mount = receipt.mount
    if (mount.workspaceID !== input.workspaceID || mount.generation !== input.generation)
      throw new Error("Workspace mount changed")
    if ((await identifyFilesystemObject(mount.path)).physicalID !== mount.physicalID)
      throw new Error("Workspace directory changed")
    return mount
  }
  private async required(reference: WorkspaceProtocol.Reference) {
    const mount = await this.inspect(reference)
    if (!mount) throw new Error("Workspace mount is unavailable")
    return mount
  }
  private contains(root: string, value: string) {
    const relative = path.relative(root, value)
    return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  private async target(mount: WorkspaceProtocol.Mount, relative: string) {
    if (relative) WorkspaceTree.Path.parse(relative)
    const requested = path.join(mount.path, ...relative.split("/"))
    const target = await NativeFileMutation.canonical(requested)
    if (!this.contains(mount.path, target))
      throw new NativeFileMutation.AccessDeniedError("Workspace path escapes its mount")
    return target
  }

  async canonical(reference: WorkspaceProtocol.Reference, relative: string, follow: boolean) {
    const mount = await this.required(reference)
    if (relative) WorkspaceTree.Path.parse(relative)
    const requested = path.join(mount.path, ...relative.split("/"))
    const target = follow ? await this.target(mount, relative) : await NativeFileEntry.canonical(requested)
    if (!this.contains(mount.path, target))
      throw new NativeFileMutation.AccessDeniedError("Workspace path escapes its mount")
    return path.relative(mount.path, target).replaceAll(path.sep, "/")
  }

  private protectedTarget(mount: WorkspaceProtocol.Mount, target: string) {
    if (SensitivePathPolicy.classifyRelative(path.relative(mount.path, target)).matched)
      throw new NativeFileMutation.AccessDeniedError("Access denied: protected filesystem entry")
  }

  async read(raw: WorkspaceProtocol.ReadInput) {
    const input = WorkspaceProtocol.ReadInput.parse(raw)
    const mount = await this.required(input.mount)
    const target = await this.target(mount, input.path)
    const file = await fs.open(
      target,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || (input.offset === undefined && before.size > input.maximumBytes))
        throw new Error("Workspace file exceeds the read limit or is not regular")
      const offset = input.offset ?? 0
      const bytes = Buffer.alloc(Math.min(input.maximumBytes, Math.max(0, Number(before.size) - offset)))
      const buffer = Buffer.allocUnsafe(64 * 1024)
      const hash = createHash("sha256")
      let position = 0
      while (position <= before.size) {
        this.shutdown.signal.throwIfAborted()
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) + 1 - position),
          position,
        )
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
        const from = Math.max(offset, position)
        const to = Math.min(offset + bytes.length, position + bytesRead)
        if (from < to) bytes.set(buffer.subarray(from - position, to - position), from - offset)
        position += bytesRead
      }
      const after = await file.stat({ bigint: true })
      const current = await fs.stat(target, { bigint: true })
      if (
        position !== Number(before.size) ||
        before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs ||
        before.size !== after.size ||
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        after.ctimeNs !== current.ctimeNs ||
        (await this.target(mount, input.path)) !== target
      )
        throw new NativeFileMutation.ConflictError()
      const version = `sha256:${hash.digest("hex")}`
      if (input.expectedVersion !== undefined && input.expectedVersion !== version)
        throw new NativeFileMutation.ConflictError()
      return { data: bytes.toString("base64"), version, size: position, mode: Number(after.mode & 0o777n) }
    } finally {
      await file.close()
    }
  }
  async list(reference: WorkspaceProtocol.Reference, relative: string) {
    const mount = await this.required(reference)
    const directory = await this.target(mount, relative)
    const names = await fs.readdir(directory)
    if (names.length > 100_000) throw new Error("Workspace directory exceeds its listing limit")
    const result: WorkspaceProtocol.Item[] = []
    for (const name of names.sort()) {
      const entry = await this.stat(reference, relative ? `${relative}/${name}` : name)
      if (entry) result.push(entry)
    }
    return result
  }

  async stat(
    reference: WorkspaceProtocol.Reference,
    relative: string,
    follow = false,
  ): Promise<WorkspaceProtocol.Item | undefined> {
    const mount = await this.required(reference)
    if (relative) WorkspaceTree.Path.parse(relative)
    const requested = path.join(mount.path, ...relative.split("/"))
    const target = relative
      ? follow
        ? await this.target(mount, relative)
        : await NativeFileEntry.canonical(requested)
      : mount.path
    if (!this.contains(mount.path, target))
      throw new NativeFileMutation.AccessDeniedError("Workspace path escapes its mount")
    const entry = await NativeFileEntry.inspect(target)
    if (!entry) return
    return {
      path: relative,
      entryVersion: entry.version,
      kind: entry.type,
      size: Number(entry.stat.size),
      mode: Number(entry.stat.mode & 0o777n),
      mtime: Number(entry.stat.mtimeNs) / 1e6,
      ctime: Number(entry.stat.ctimeNs) / 1e6,
    }
  }

  async write(raw: WorkspaceProtocol.WriteInput) {
    const input = WorkspaceProtocol.WriteInput.parse(raw)
    return this.checkpointOperation(
      input.id,
      input.mount,
      this.digest(input),
      undefined,
      async (mount, receipt, start) => {
        if (mount.readOnly) throw new Error("Workspace mount is read-only")
        const bytes = Buffer.from(input.data, "base64")
        if (bytes.toString("base64") !== input.data || bytes.length > WorkspaceProtocol.writeBytes)
          throw new Error("Invalid Workspace file bytes")
        const target = await this.target(mount, input.path)
        if (input.protectSensitive) this.protectedTarget(mount, target)
        const current = await NativeFileMutation.snapshot(target)
        if (receipt.effectStarted) {
          if (current?.version === `sha256:${WorkspaceTree.hash(bytes)}`) return
          throw new Error("Workspace write outcome is unknown; the mutation cannot be repeated")
        }
        if ((current?.version ?? null) !== input.expectedVersion) throw new NativeFileMutation.ConflictError()
        await NativeFileMutation.write(
          {
            path: path.join(mount.path, input.path),
            content: bytes,
            expectedVersion: input.expectedVersion,
            createParents: true,
            owner: this.options.owner,
            start,
            signal: this.shutdown.signal,
            validate: async () => {
              await this.required(input.mount)
              if ((await this.target(mount, input.path)) !== target) throw new Error("Workspace path changed")
              if (input.protectSensitive) this.protectedTarget(mount, target)
            },
          },
          target,
        )
      },
    )
  }
  async mutate(raw: WorkspaceProtocol.ChangeInput) {
    const input = WorkspaceProtocol.ChangeInput.parse(raw)
    return this.checkpointOperation(
      input.id,
      input.mount,
      this.digest(input),
      undefined,
      async (mount, receipt, start) => {
        if (mount.readOnly) throw new Error("Workspace mount is read-only")
        if (receipt.effectStarted)
          throw new Error("Workspace entry mutation outcome is unknown; the mutation cannot be repeated")
        const absolute = (relative: string) => path.join(mount.path, ...relative.split("/"))
        const options: NativeFileEntry.Options = {
          owner: this.options.owner,
          signal: this.shutdown.signal,
          start,
          validate: async (target) => {
            await this.required(input.mount)
            const canonical = await NativeFileEntry.canonical(target)
            if (input.protectSensitive) this.protectedTarget(mount, canonical)
            if (!this.contains(mount.path, canonical)) throw new Error("Workspace path escapes its mount")
          },
        }
        const change = input.change
        if (change.kind === "mkdir") {
          await NativeFileEntry.mkdir({ ...change, path: absolute(change.path), ...options })
        } else if (change.kind === "remove")
          await NativeFileEntry.remove({ ...change, path: absolute(change.path), ...options })
        else
          await NativeFileEntry[change.kind]({
            ...change,
            from: absolute(change.from),
            to: absolute(change.to),
            ...options,
          })
      },
    )
  }
  async checkpoint(raw: WorkspaceProtocol.CheckpointInput) {
    const input = WorkspaceProtocol.CheckpointInput.parse(raw)
    return this.checkpointOperation(input.id, input.mount, this.digest(input), input.executionID)
  }
  private async checkpointOperation(
    id: string,
    reference: WorkspaceProtocol.Reference,
    digest: string,
    executionID?: string,
    mutate?: (mount: WorkspaceProtocol.Mount, receipt: Receipt, start: () => Promise<void>) => Promise<void>,
  ) {
    return this.serial(`checkpoint:${id}`, async () => {
      let receipt = Receipt.optional().parse(await this.receipt("checkpoints", id))
      if (receipt && receipt.digest !== digest) throw new Error("Workspace operation already has different input")
      if (receipt?.failure) throw WorkspaceErrors.restore(receipt.failure)
      if (receipt?.error) throw new Error(receipt.error)
      if (receipt?.checkpoint) return receipt.checkpoint
      const mount = await this.required(reference)
      receipt ??= { id, digest, mount: reference, released: false, effectStarted: false, effectCompleted: false }
      await this.persist("checkpoints", id, receipt)
      if (executionID) {
        if (!this.options.executionWriter) throw new Error("Execution checkpoint is unavailable")
        await this.options.executionWriter(executionID, mount.path)
      } else if (!receipt.claim) {
        const lease = await this.options.coordinator
          .acquire({
            id: `checkpoint:${id}`,
            owner: id,
            ancestors: [],
            roots: [mount.path],
            kind: "process",
            retainAfterExit: true,
            durable: true,
            signal: this.shutdown.signal,
          })
          .catch(async (error: unknown) => {
            receipt.failure = WorkspaceErrors.failure(error)
            receipt.error = error instanceof Error ? error.message : "Workspace write admission failed"
            receipt.released = true
            await this.persist("checkpoints", id, receipt)
            throw error
          })
        receipt.claim = lease.recovery
        await this.persist("checkpoints", id, receipt)
      } else await this.options.coordinator.validateRetention(receipt.claim, mount.path)
      try {
        if (mutate && !receipt.effectCompleted) {
          await mutate(mount, receipt, async () => {
            if (receipt.effectStarted) return
            receipt.effectStarted = true
            await this.persist("checkpoints", id, receipt)
          })
          receipt.effectCompleted = true
          await this.persist("checkpoints", id, receipt)
        }
      } catch (error) {
        if (!receipt.effectStarted && receipt.claim) {
          await (await this.options.coordinator.recover(receipt.claim)).release()
          receipt.failure = WorkspaceErrors.failure(error)
          receipt.error = error instanceof Error ? error.message : "Workspace mutation rejected"
          receipt.released = true
          await this.persist("checkpoints", id, receipt)
        }
        throw error
      }
      const source = MountReceipt.parse(await this.receipt("mounts", reference.id)).input.source
      let manifest: string | null = null
      if (source.kind === "materialized") {
        const tree = await NativeWorkspaceTree.capture(mount.path, this.blobs(), this.shutdown.signal)
        const bytes = WorkspaceTree.encode(tree)
        manifest = WorkspaceTree.hash(bytes)
        await this.putBlob(manifest, bytes)
      }
      const checkpoint = { id, mount: reference, manifest }
      await this.persist("checkpoints", id, { ...receipt, checkpoint })
      return checkpoint
    })
  }
  async acknowledge(id: string) {
    await this.serial(`checkpoint:${id}`, async () => {
      const receipt = Receipt.parse(await this.receipt("checkpoints", id))
      if (receipt.released) return
      if (!receipt.checkpoint) throw new Error("Workspace checkpoint is incomplete")
      if (receipt.claim) await (await this.options.coordinator.recover(receipt.claim)).release()
      await this.persist("checkpoints", id, { ...receipt, released: true })
    })
  }

  async checkpointStatus(id: string): Promise<WorkspaceProtocol.CheckpointStatus | undefined> {
    const receipt = Receipt.optional().parse(await this.receipt("checkpoints", id))
    if (!receipt) return
    return {
      id,
      mount: receipt.mount,
      state: receipt.error ? "failed" : receipt.released ? "released" : receipt.checkpoint ? "saved" : "pending",
      checkpoint: receipt.checkpoint,
      error: receipt.error,
      failure: receipt.failure,
    }
  }

  async detach(reference: WorkspaceProtocol.Reference) {
    await this.serial(`mount:${reference.id}`, async () => {
      const receipt = MountReceipt.parse(await this.receipt("mounts", reference.id))
      if (receipt.detached) return
      const mount = await this.required(reference)
      const lease = await this.options.coordinator.acquire({
        id: `detach:${reference.id}`,
        owner: reference.id,
        ancestors: [],
        roots: [mount.path],
        kind: "exclusive",
        signal: this.shutdown.signal,
      })
      try {
        await this.required(reference)
        if (receipt.input.source.kind === "materialized") await fs.rm(mount.path, { recursive: true })
        await this.persist("mounts", reference.id, { ...receipt, detached: true })
      } finally {
        await lease.release()
      }
    })
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    WorkspaceTree.verify(hash, bytes, WorkspaceTree.manifestBytes)
    await AtomicFile.writeFileAtomic(this.filename("blobs", hash), bytes, { private: true, durable: true })
  }
  async getBlob(hash: string, maximumBytes: number) {
    WorkspaceTree.Hash.parse(hash)
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > WorkspaceTree.manifestBytes)
      throw new Error("Invalid Workspace object size")
    const file = Bun.file(this.filename("blobs", hash))
    if (file.size > maximumBytes) throw new Error("Workspace object exceeds its read limit")
    return WorkspaceTree.verify(hash, new Uint8Array(await file.arrayBuffer()), maximumBytes)
  }
  private blobs() {
    return {
      put: (hash: string, bytes: Uint8Array) => this.putBlob(hash, bytes),
      get: (hash: string, maximumBytes: number) => this.getBlob(hash, maximumBytes),
    }
  }

  async close() {
    this.shutdown.abort(new Error("Workspace file host is closing"))
    await Promise.allSettled(this.pending.values())
  }
}
