import { z } from "zod"
import { createHash } from "node:crypto"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import type { SessionTransferWorkspaces as Files } from "@ericsanchezok/synergy-harness/session/transfer"

export namespace NativeWorkspaceAdoption {
  export const Receipt = z.strictObject({
    kind: z.literal("native-adoption"),
    request: WorkspaceMove.NativeRequest,
    receipt: WorkspaceMove.NativeReceipt,
  })
  export type Receipt = z.infer<typeof Receipt>
  type Host = Parameters<typeof Files.registerTargetHost>[0]
  interface Input {
    request: WorkspaceMove.NativeRequest
    snapshot: WorkspaceArchive.Subtree
    consent: z.infer<typeof WorkspaceMove.NativeConsent>
    store: BlobStore
    signal: AbortSignal
    assert(): void
    recheck(): Promise<void>
    commit(): Promise<void>
  }
  interface Frame extends Input {
    pending: Set<Promise<unknown>>
    accepting: boolean
  }
  const frames = RuntimeContext.createAsyncContext<Frame>()
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  function current(admit = false) {
    const frame = frames.getStore()
    if (!frame) throw new Error("Native adoption requires its original target controller")
    frame.assert()
    if (admit && !frame.accepting) throw new Error("Native adoption callback is draining")
    return frame
  }
  export async function run<T>(value: Input, body: () => Promise<T>): Promise<T> {
    const owner = WorkspaceContent.captureOwner(value.signal),
      check = value.assert.bind(value)
    let open = true
    const frame: Frame = {
      accepting: true,
      pending: new Set(),
      request: WorkspaceMove.NativeRequest.parse(value.request),
      snapshot: WorkspaceArchive.Subtree.parse(value.snapshot),
      consent: WorkspaceMove.NativeConsent.parse(value.consent),
      store: { get: value.store.get.bind(value.store), put: value.store.put.bind(value.store) },
      signal: value.signal,
      recheck: value.recheck.bind(value),
      commit: value.commit.bind(value),
      assert() {
        owner()
        check()
        if (!open || frames.getStore() !== frame) throw new Error("Native adoption callback has ended or changed")
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
  export function parse(value: z.infer<typeof JsonValue>): Receipt | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value
      ? Receipt.parse(value)
      : undefined
  }
  function track<T>(frame: Frame, body: () => Promise<T>) {
    const promise = body()
    frame.pending.add(promise)
    void promise.finally(() => frame.pending.delete(promise)).catch(() => {})
    return promise
  }
  export function prepare(input: Parameters<Host["prepare"]>[0]) {
    const frame = current(true)
    return track(frame, () => prepareNative(input, frame))
  }
  async function prepareNative(input: Parameters<Host["prepare"]>[0], frame: Frame) {
    const captured = input.captured
    if (
      input.mode !== "existing" ||
      captured.workspaceID !== frame.request.source.workspaceID ||
      captured.scopeID !== frame.request.source.scopeID ||
      captured.generation !== frame.request.source.generation ||
      hash(captured.files) !== frame.snapshot.manifest
    )
      throw new Error("Native adoption differs from its verified source graph")
    const receipt = await WorkspaceMove.prepareNative(frame.request, {
      source: { snapshot: frame.snapshot, store: input.store, assert: frame.assert, recheck: frame.recheck },
      store: frame.store,
      signal: frame.signal,
      consent: frame.consent,
    })
    frame.assert()
    const catalog = await WorkspaceCatalog.get(frame.request.target.workspaceID, frame.request.target.scopeID)
    frame.assert()
    if (hash(catalog) !== receipt.target.catalogueHash || !catalog.binding.path || !catalog.binding.physicalID)
      throw new Error("Native adoption catalogue changed after its complete receipt")
    return {
      version: 1 as const,
      workspaceID: catalog.id,
      scopeID: catalog.scopeID,
      hostID: catalog.binding.hostID,
      path: catalog.binding.path,
      physicalID: catalog.binding.physicalID,
      catalog,
      receipt: JsonValue.parse({ kind: "native-adoption", request: frame.request, receipt }),
    }
  }
  function expected(value: Receipt) {
    const receipt = Receipt.parse(value),
      frame = current()
    if (
      hash(receipt.request) !== hash(frame.request) ||
      receipt.receipt.sourceSnapshotHash !== frame.request.sourceSnapshotHash ||
      receipt.receipt.acceptedDiffHash !== frame.consent.diffHash
    )
      throw new Error("Native adoption cannot replace its original consent or receipt")
    return { receipt, frame }
  }
  export function selection(value: Parameters<Host["validate"]>[0]): Receipt {
    const receipt = Receipt.parse(value.receipt)
    expected(receipt)
    const catalog = value.catalog
    if (
      !catalog ||
      hash(catalog) !== receipt.receipt.target.catalogueHash ||
      value.workspaceID !== catalog.id ||
      value.scopeID !== catalog.scopeID ||
      value.hostID !== catalog.binding.hostID ||
      value.path !== catalog.binding.path ||
      value.physicalID !== catalog.binding.physicalID
    )
      throw new Error("Native adoption changed its exact catalogue or physical selection")
    return receipt
  }
  export async function validate(value: Receipt, signal: AbortSignal) {
    const { receipt, frame } = expected(value)
    const work = AbortSignal.any([frame.signal, signal])
    work.throwIfAborted()
    await frame.recheck()
    const status = await WorkspaceMove.inspect(receipt.request)
    frame.assert()
    if (
      !status ||
      !("nativeReceipt" in status) ||
      !status.nativeReceipt ||
      hash(status.nativeReceipt) !== hash(receipt.receipt)
    )
      throw new Error("Native adoption has no retained prepared receipt")
    await WorkspaceMove.withNativePublication(
      receipt.request,
      receipt.receipt,
      async () => {
        await frame.recheck()
        frame.assert()
        work.throwIfAborted()
      },
      work,
    )
  }
  export function withPublication<T>(
    values: readonly Receipt[],
    signal: AbortSignal,
    body: () => Promise<T>,
  ): Promise<T> {
    const frame = current(true)
    const receipts = values.map((value) => Receipt.parse(value))
    return track(frame, () => publish(receipts, signal, body))
  }
  async function publish<T>(values: readonly Receipt[], signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    if (values.length !== 1) throw new Error("Native adoption requires one exact Working location")
    const { receipt, frame } = expected(values[0]!)
    const work = AbortSignal.any([frame.signal, signal])
    work.throwIfAborted()
    await frame.recheck()
    frame.assert()
    return WorkspaceMove.withNativePublication(
      receipt.request,
      receipt.receipt,
      async () => {
        await frame.recheck()
        frame.assert()
        work.throwIfAborted()
        return body()
      },
      work,
    )
  }
  export function assertPublication(value: Receipt) {
    const { receipt } = expected(value)
    WorkspaceMove.assertNativePublication(receipt.request, receipt.receipt)
  }
  export async function publishFact(value: Receipt) {
    const { receipt, frame } = expected(value)
    await frame.commit()
    await WorkspaceMove.publishNative(receipt.request, receipt.receipt)
  }
}
