import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { withStorageQueueOptions } from "@ericsanchezok/synergy-harness/storage/queue"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceLocation } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { NativeWorkspacePortableTree as Tree } from "./portable-tree"

export namespace NativeWorkspacePortableTarget {
  const ID = z.string().min(1).max(4096)
  const Intent = z.strictObject({
    version: z.literal(1),
    handoffID: ID,
    scopeID: ID,
    sourceWorkspaceID: ID,
    workspaceID: ID,
    directory: ID,
    files: WorkspacePortableTree.Root,
  })
  export const Receipt = Intent.extend({ hostID: ID, physicalID: ID })
  export type Receipt = z.infer<typeof Receipt>
  const State = z.strictObject({
    version: z.literal(1),
    phase: z.enum(["preparing", "prepared"]),
    intent: Intent,
    receipt: Receipt.optional(),
  })
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const identity = (value: { handoffID: string; scopeID: string; sourceWorkspaceID: string }) =>
    digest([value.handoffID, value.scopeID, value.sourceWorkspaceID])
  const key = (value: Parameters<typeof identity>[0]) => ["workspace_portable_native", identity(value)]
  const frame = RuntimeContext.createAsyncContext<{
    assert(): void
    receipts: ReadonlyMap<string, Receipt>
    open: boolean
  }>()
  function fail(message: string): never {
    throw new Error("Native Workspace target " + message)
  }
  async function owner(signal: AbortSignal) {
    signal.throwIfAborted()
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const store = handle.store
    const directory = handle.artifactDirectory
    const objects = handle.artifactObjects
    const blobs = objects?.blobs
    const writerID = objects?.writerID
    const now = objects?.now
    const root = runtime.host.root
    const home = runtime.host.home
    const location = runtime.host.workspaceLocation
    const identify = location?.identify
    const hostID = location?.hostID
    const writer = await ServerProcessLock.currentOwnership()
    const assert = () => {
      signal.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage?.store !== store ||
        runtime.storage.artifactDirectory !== directory ||
        runtime.storage.artifactObjects !== objects ||
        current.store !== store ||
        current.artifactDirectory !== directory ||
        current.artifactObjects !== objects ||
        objects?.blobs !== blobs ||
        objects?.writerID !== writerID ||
        objects?.now !== now ||
        runtime.host.root !== root ||
        runtime.host.home !== home ||
        runtime.host.workspaceLocation !== location ||
        location?.identify !== identify ||
        location?.hostID !== hostID
      )
        fail("requires its original primary storage owner")
      ServerProcessLock.assertCurrent(writer)
    }
    assert()
    return assert
  }
  async function directory(value: Parameters<typeof identity>[0]) {
    const root = await fs.realpath(Global.Path.root)
    const base = path.join(root, "data", "received-workspaces")
    return path.join(base, identity(value))
  }
  async function saved(value: Parameters<typeof identity>[0]) {
    const [raw] = await Storage.readMany([key(value)])
    return raw === undefined ? undefined : State.parse(raw)
  }
  async function verify(receipt: Receipt, assert: () => void, signal: AbortSignal) {
    assert()
    const current = await saved(receipt)
    assert()
    if (current?.phase !== "prepared" || !current.receipt || digest(current.receipt) !== digest(receipt))
      fail("requires its exact prepared receipt")
    if (receipt.directory !== (await directory(receipt))) fail("has another native location")
    if ((await fs.realpath(path.dirname(receipt.directory))) !== path.dirname(receipt.directory))
      fail("requires its canonical private parent")
    assert()
    const source = WorkspaceLocation.source()
    const location = await source.identify(receipt.directory)
    assert()
    if (
      location.path !== receipt.directory ||
      location.physicalID !== receipt.physicalID ||
      (await source.hostID()) !== receipt.hostID
    )
      fail("native directory identity changed")
    assert()
    await Tree.verify({ root: receipt.directory, captured: receipt.files, directory: Global.Path.cache, signal })
    assert()
  }
  export function prepare(input: {
    handoffID: string
    scopeID: string
    workspaceID: string
    files: WorkspacePortableTree.Root
    store: BlobStore
    signal: AbortSignal
  }): Promise<Receipt> {
    const value = {
      handoffID: ID.parse(input.handoffID),
      scopeID: ID.parse(input.scopeID),
      sourceWorkspaceID: ID.parse(input.workspaceID),
    }
    const files = WorkspacePortableTree.Root.parse(input.files)
    const signal = input.signal
    const store = Object.freeze({ put: input.store.put.bind(input.store), get: input.store.get.bind(input.store) })
    return withStorageQueueOptions({ signal }, () => prepareNative(value, files, store, signal))
  }
  async function prepareNative(
    value: Parameters<typeof identity>[0],
    files: WorkspacePortableTree.Root,
    store: BlobStore,
    signal: AbortSignal,
  ): Promise<Receipt> {
    const assert = await owner(signal)
    using lock = await Lock.writeWithSignal("native-workspace-target:" + identity(value), signal)
    assert()
    if (!lock) fail("could not acquire preparation ownership")
    const root = await directory(value)
    assert()
    await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 })
    if ((await fs.realpath(path.dirname(root))) !== path.dirname(root)) fail("requires its canonical private parent")
    assert()
    const intent = Intent.parse({ version: 1, ...value, workspaceID: "wsp_" + identity(value), directory: root, files })
    const previous = await saved(value)
    assert()
    if (previous && digest(previous.intent) !== digest(intent)) fail("cannot replace its immutable preparation")
    return WorkspaceAccess.exclusive(
      [root],
      async () => {
        assert()
        if (previous?.phase === "prepared") {
          const receipt = Receipt.parse(previous.receipt)
          await verify(receipt, assert, signal)
          return receipt
        }
        const existing = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
        assert()
        if (existing && !previous) fail("private destination was already occupied")
        if (!previous) await Storage.write(key(value), State.parse({ version: 1, phase: "preparing", intent }))
        assert()
        if (!existing) await Tree.materialize({ root, captured: files, directory: Global.Path.cache, store, signal })
        assert()
        await Tree.verify({ root, captured: files, directory: Global.Path.cache, signal })
        assert()
        const source = WorkspaceLocation.source()
        const location = await source.identify(root)
        const hostID = await source.hostID()
        assert()
        if (location.path !== root || !location.physicalID) fail("requires a verified physical directory")
        const receipt = Receipt.parse({ ...intent, hostID, physicalID: location.physicalID })
        await Storage.transaction(
          async () => {
            assert()
            await Storage.write(key(value), State.parse({ version: 1, phase: "prepared", intent, receipt }))
          },
          { commitGuard: assert },
        )
        assert()
        return receipt
      },
      signal,
    )
  }
  export function validate(value: Receipt, signal: AbortSignal): Promise<void> {
    const receipt = Receipt.parse(value)
    return withStorageQueueOptions({ signal }, async () => {
      const assert = await owner(signal)
      await verify(receipt, assert, signal)
    })
  }
  export function withPublication<T>(
    values: readonly Receipt[],
    signal: AbortSignal,
    body: () => Promise<T>,
  ): Promise<T> {
    const receipts = values.map((value) => Receipt.parse(value))
    return withStorageQueueOptions({ signal }, async () => {
      const assert = await owner(signal)
      return WorkspaceAccess.exclusive(
        receipts.map((receipt) => receipt.directory),
        async () => {
          for (const receipt of receipts) await verify(receipt, assert, signal)
          assert()
          const current = {
            assert,
            receipts: new Map(receipts.map((receipt) => [identity(receipt), receipt])),
            open: true,
          }
          try {
            const result = await frame.run(current, body)
            assert()
            return result
          } finally {
            current.open = false
          }
        },
        signal,
      )
    })
  }
  export function assertPublication(value: Receipt): Receipt {
    const receipt = Receipt.parse(value)
    const current = frame.getStore()
    if (!current?.open) fail("requires its current native publication callback")
    current.assert()
    const expected = current.receipts.get(identity(receipt))
    if (!expected || digest(expected) !== digest(receipt)) fail("publication has another prepared Workspace")
    return Receipt.parse(expected)
  }
}
