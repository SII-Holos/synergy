import { createHash } from "node:crypto"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import type { SessionTransferWorkspaces as Files } from "@ericsanchezok/synergy-harness/session/transfer"
import { NativeWorkspacePortableTarget as Native } from "./portable-target"

export namespace NativeWorkspaceDownload {
  export async function request(input: Omit<WorkspaceMove.DownloadRequest, "target" | "kind">, signal: AbortSignal) {
    const selected = await Native.selection(
      { handoffID: input.handoffID, scopeID: input.source.scopeID, sourceWorkspaceID: input.source.workspaceID },
      signal,
    )
    return WorkspaceMove.DownloadRequest.parse({
      ...input,
      kind: "native-download",
      target: {
        workspaceID: selected.workspaceID,
        scopeID: selected.scopeID,
        generation: selected.generation,
        path: "",
        expectedRevision: 1,
      },
    })
  }
  type Host = Parameters<typeof Files.registerTargetHost>[0]
  interface Input {
    request: WorkspaceMove.DownloadRequest
    snapshot: WorkspaceArchive.Subtree
    sourceStore: BlobStore
    store: BlobStore
    signal: AbortSignal
    assert(): void
    recheck(): Promise<void>
  }
  interface Frame extends Input {
    accepting: boolean
    pending: Set<Promise<unknown>>
  }
  const frames = RuntimeContext.createAsyncContext<Frame>()
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  function current(admit = false) {
    const frame = frames.getStore()
    if (!frame) throw new Error("Native download requires its original target controller")
    frame.assert()
    if (admit && !frame.accepting) throw new Error("Native download callback is draining")
    return frame
  }
  function track<T>(frame: Frame, body: () => Promise<T>) {
    const promise = body()
    frame.pending.add(promise)
    void promise.finally(() => frame.pending.delete(promise)).catch(() => {})
    return promise
  }
  export async function run<T>(input: Input, body: () => Promise<T>) {
    const owner = WorkspaceContent.captureOwner(input.signal),
      check = input.assert.bind(input)
    let open = true
    const frame: Frame = {
      request: WorkspaceMove.DownloadRequest.parse(input.request),
      snapshot: WorkspaceArchive.Subtree.parse(input.snapshot),
      sourceStore: {
        get: input.sourceStore.get.bind(input.sourceStore),
        put: input.sourceStore.put.bind(input.sourceStore),
      },
      store: { get: input.store.get.bind(input.store), put: input.store.put.bind(input.store) },
      signal: input.signal,
      recheck: input.recheck.bind(input),
      pending: new Set(),
      accepting: true,
      assert() {
        owner()
        check()
        if (!open || frames.getStore() !== frame) throw new Error("Native download callback has ended or changed")
      },
    }
    try {
      return await frames.run(frame, body)
    } finally {
      frame.accepting = false
      await Promise.allSettled([...frame.pending])
      open = false
    }
  }
  function expected(value: Parameters<Host["validate"]>[0]) {
    const frame = current()
    if (
      value.version !== 2 ||
      hash(value.download.request) !== hash(frame.request) ||
      value.download.receipt.sourceSnapshotHash !== frame.request.sourceSnapshotHash
    )
      throw new Error("Native download has another original move or final snapshot")
    const native = Native.Receipt.parse(value.receipt),
      receipt = WorkspaceMove.DownloadReceipt.parse(value.download.receipt)
    if (
      receipt.nativeReceiptHash !== hash(native) ||
      value.workspaceID !== receipt.target.workspaceID ||
      value.scopeID !== receipt.target.scopeID ||
      value.hostID !== receipt.target.hostID ||
      value.physicalID !== receipt.target.physicalID ||
      value.path !== native.directory ||
      value.workspaceID !== native.workspaceID ||
      hash(native.files) !== frame.snapshot.manifest
    )
      throw new Error("Native download changed its actual private preparation")
    return { frame, native, receipt }
  }
  export function prepare(input: Parameters<Host["prepare"]>[0]) {
    const frame = current(true)
    return track(frame, async () => {
      const captured = input.captured
      if (
        input.mode !== "download" ||
        input.handoffID !== frame.request.handoffID ||
        captured.workspaceID !== frame.request.source.workspaceID ||
        captured.scopeID !== frame.request.source.scopeID ||
        captured.generation !== frame.request.source.generation ||
        hash(captured.files) !== frame.snapshot.manifest
      )
        throw new Error("Native download differs from its complete frozen source graph")
      const receipt = await WorkspaceMove.prepareDownload(frame.request, {
        source: { snapshot: frame.snapshot, store: frame.sourceStore, assert: frame.assert, recheck: frame.recheck },
        store: frame.store,
        signal: frame.signal,
      })
      frame.assert()
      const native = await Native.prepare({
        handoffID: input.handoffID,
        scopeID: captured.scopeID,
        workspaceID: captured.workspaceID,
        files: captured.files,
        store: input.store,
        signal: frame.signal,
      })
      if (hash(native) !== receipt.nativeReceiptHash)
        throw new Error("Native download lost its original private receipt")
      return {
        version: 2 as const,
        workspaceID: native.workspaceID,
        scopeID: native.scopeID,
        path: native.directory,
        hostID: native.hostID,
        physicalID: native.physicalID,
        receipt: JsonValue.parse(native),
        download: { request: frame.request, receipt },
      }
    })
  }
  export async function validate(value: Parameters<Host["validate"]>[0], signal: AbortSignal) {
    const { frame, receipt } = expected(value),
      work = AbortSignal.any([frame.signal, signal])
    await frame.recheck()
    await WorkspaceMove.withDownloadPublication(
      frame.request,
      receipt,
      async () => {
        frame.assert()
        work.throwIfAborted()
      },
      work,
    )
  }
  export function withPublication<T>(
    values: readonly Parameters<Host["validate"]>[0][],
    signal: AbortSignal,
    body: () => Promise<T>,
  ): Promise<T> {
    const frame = current(true)
    return track(frame, async () => {
      if (values.length !== 1) throw new Error("Native download requires one exact Working location")
      const { receipt } = expected(values[0]!),
        work = AbortSignal.any([frame.signal, signal])
      await frame.recheck()
      return WorkspaceMove.withDownloadPublication(
        frame.request,
        receipt,
        async () => {
          await frame.recheck()
          frame.assert()
          work.throwIfAborted()
          return body()
        },
        work,
      )
    })
  }
  export function assertPublication(value: Parameters<Host["validate"]>[0]) {
    const { frame, receipt } = expected(value)
    WorkspaceMove.assertDownloadPublication(frame.request, receipt)
  }
  export async function publishFact(value: Parameters<Host["validate"]>[0]) {
    const { frame, receipt } = expected(value)
    await WorkspaceMove.publishDownload(frame.request, receipt)
  }
}
