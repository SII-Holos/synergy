import { createHash } from "node:crypto"
import { z } from "zod"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceBlobs, WorkspaceContent, type BlobStore } from "./content"
import { WorkspaceTree } from "./tree"
import { Storage } from "../storage/storage"
import { RuntimeContext } from "../lifecycle/context"

export namespace WorkspaceArchive {
  export class Invalid extends Error {}
  const Header = z.object({ kind: z.literal("manifest"), version: z.literal(1), tree: WorkspaceTree.Manifest }).strict()
  const Chunk = z
    .object({
      kind: z.literal("chunk"),
      hash: WorkspaceTree.Hash,
      data: z
        .string()
        .max(Math.ceil(WorkspaceTree.chunkBytes / 3) * 4)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict()
  const End = z.object({ kind: z.literal("end"), manifest: WorkspaceTree.Hash }).strict()
  function verified(hash: string, bytes: Uint8Array, maximum: number) {
    try {
      return WorkspaceTree.verify(hash, bytes, maximum)
    } catch {
      throw new Invalid("Workspace archive object integrity check failed")
    }
  }
  type Saved = { info: WorkspaceCatalog.Info; store: BlobStore; tree: WorkspaceTree.Manifest }

  export async function saved(input: {
    workspaceID: string
    scopeID: string
    expectedRevision: number
  }): Promise<Saved> {
    const { info, store } = await WorkspaceContent.resolve(input, true)
    if (info.revision !== input.expectedRevision)
      throw new WorkspaceCatalog.BindingChanged({
        workspaceID: info.id,
        message: "Workspace changed before saved-version export",
      })
    return { info, store, tree: await WorkspaceContent.manifest(info, store) }
  }

  function chunks(tree: WorkspaceTree.Manifest) {
    const result = new Map<string, number>()
    for (const entry of tree.entries)
      if (entry.kind === "file")
        for (const chunk of entry.chunks) {
          if (result.has(chunk.hash) && result.get(chunk.hash) !== chunk.size)
            throw new Invalid("Archive chunk size conflict")
          result.set(chunk.hash, chunk.size)
        }
    return result
  }

  async function verifyFiles(tree: WorkspaceTree.Manifest, store: BlobStore, signal?: AbortSignal) {
    for (const entry of tree.entries)
      if (entry.kind === "file") {
        const digest = createHash("sha256")
        for (const chunk of entry.chunks) {
          signal?.throwIfAborted()
          const bytes = verified(chunk.hash, await store.get(chunk.hash, chunk.size), chunk.size)
          if (bytes.length !== chunk.size) throw new Invalid("Archive chunk size mismatch")
          digest.update(bytes)
        }
        if (digest.digest("hex") !== entry.hash) throw new Invalid("Archive file integrity check failed")
      }
  }

  export async function* records(snapshot: Saved, signal?: AbortSignal): AsyncGenerator<unknown> {
    signal?.throwIfAborted()
    yield { kind: "manifest", version: 1, tree: snapshot.tree }
    for (const [hash, size] of chunks(snapshot.tree)) {
      signal?.throwIfAborted()
      const bytes = verified(hash, await snapshot.store.get(hash, size), size)
      if (bytes.length !== size) throw new Invalid("Archive chunk size mismatch")
      yield { kind: "chunk", hash, data: Buffer.from(bytes).toString("base64") }
    }
    await verifyFiles(snapshot.tree, snapshot.store, signal)
    yield { kind: "end", manifest: WorkspaceTree.hash(WorkspaceTree.encode(snapshot.tree)) }
  }

  export function stream(snapshot: Saved, signal?: AbortSignal) {
    const iterator = records(snapshot, signal)
    const runtime = RuntimeContext.current()
    return new ReadableStream<Uint8Array>({
      pull: runtime.bind(async (controller) => {
        try {
          const next = await iterator.next()
          if (next.done) controller.close()
          else controller.enqueue(new TextEncoder().encode(JSON.stringify(next.value) + "\n"))
        } catch (error) {
          controller.error(error)
        }
      }),
      cancel: runtime.bind(async () => {
        await iterator.return(undefined)
      }),
    })
  }

  export async function* parse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
    const reader = stream.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let pending = ""
    const limit = WorkspaceTree.manifestBytes + 1024
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        pending += decoder.decode(next.value, { stream: true })
        while (true) {
          const newline = pending.indexOf("\n")
          if (newline === -1) break
          if (newline > limit) throw new Invalid("Archive record exceeds its size limit")
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          try {
            yield JSON.parse(line)
          } catch {
            throw new Invalid("Workspace archive contains invalid JSON")
          }
        }
        if (pending.length > limit) throw new Invalid("Archive record exceeds its size limit")
      }
      pending += decoder.decode()
      if (pending.length) throw new Invalid("Workspace archive is truncated")
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }

  export async function restore(
    input: { scopeID: string; backend: WorkspaceCatalog.Info["backend"]; metadata?: Record<string, unknown> },
    source: AsyncIterable<unknown>,
    signal?: AbortSignal,
  ) {
    if (input.backend?.provider !== "objects") throw new Invalid("Archive restore requires object storage")
    const spec = WorkspaceContent.Spec.parse(input.backend.spec)
    const store = WorkspaceBlobs.get(spec.blobStore, spec.settings)
    let tree: WorkspaceTree.Manifest | undefined
    let remaining = new Map<string, number>()
    let finished = false
    let manifest: string | undefined
    for await (const value of source) {
      signal?.throwIfAborted()
      if (finished) throw new Invalid("Workspace archive has trailing records")
      if (!tree) {
        tree = Header.parse(value).tree
        manifest = WorkspaceTree.hash(WorkspaceTree.encode(tree))
        remaining = chunks(tree)
        continue
      }
      if (End.safeParse(value).success) {
        if (remaining.size || End.parse(value).manifest !== manifest)
          throw new Invalid("Workspace archive is incomplete")
        finished = true
        continue
      }
      const chunk = Chunk.parse(value)
      const size = remaining.get(chunk.hash)
      if (size === undefined) throw new Invalid("Unexpected or duplicate archive chunk")
      const bytes = verified(chunk.hash, Buffer.from(chunk.data, "base64"), size)
      if (bytes.length !== size) throw new Invalid("Archive chunk size mismatch")
      await store.put(chunk.hash, bytes)
      remaining.delete(chunk.hash)
    }
    if (!finished || !tree || !manifest) throw new Invalid("Workspace archive is incomplete")
    await verifyFiles(tree, store, signal)
    await store.put(manifest, WorkspaceTree.encode(tree))
    signal?.throwIfAborted()
    return Storage.transaction(async () => {
      const workspace = await WorkspaceCatalog.create({ ...input, backend: input.backend! })
      return WorkspaceCatalog.publishContent(workspace, manifest!)
    })
  }
}
