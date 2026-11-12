import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { JsonValue } from "@ericsanchezok/synergy-util/json-value"
import { RuntimeContext } from "./context"
import { HomeOwnershipFile } from "./home-ownership-file"
import { Storage } from "../storage/storage"
import { StorageMutationGuard } from "../storage/mutation-guard"
import { ServerProcessLock } from "../util/server-process-lock"

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Request = z.strictObject({
  restoreID: ID,
  owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  sourceHash: Hash,
  payload: JsonValue,
})
const Physical = z.strictObject({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
const Artifacts = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("present"), directory: z.string(), identity: Physical }),
  z.strictObject({
    kind: z.literal("future"),
    directory: z.string(),
    parent: z.string(),
    parentIdentity: Physical,
  }),
])
type Artifacts = z.infer<typeof Artifacts>
const Disk = z.strictObject({
  schemaVersion: z.literal(1),
  restoreID: ID,
  owner: Request.shape.owner,
  sourceHash: Hash,
  requestHash: Hash,
  installationID: z.uuid(),
  incarnation: z.uuid(),
  phase: z.literal("staging"),
  target: z.strictObject({
    home: z.string(),
    root: z.string(),
    homeIdentity: Physical,
    rootIdentity: Physical,
    storageHash: Hash,
    artifacts: Artifacts,
  }),
})
type Disk = z.infer<typeof Disk>
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const filename = (root: string) => path.join(root, "home-restoration.json")
const lockDirectory = (root: string) => path.join(root, "state", ".locks")
class RestorationError extends Error {
  override readonly name = "HomeRestorationBlocked"
}
interface Binding {
  runtime: RuntimeContext.Instance
  handle: Storage.Handle
  store: Storage.Handle["store"]
  artifacts: string
  storeConfigHash: string
  writer: ServerProcessLock.Ownership
  record: Disk
}
interface Frame {
  binding: Binding
  signal?: AbortSignal
  open: boolean
}
const targets = new WeakMap<HomeRestoration.Target, Binding>()
const permits = new WeakMap<HomeRestoration.InstallPermit, Frame>()
const current = RuntimeContext.createAsyncContext<Frame>()
const state = RuntimeContext.state(() => ({ installed: false, blocked: false, pending: 0 }))

function assertPrimary(binding: Binding) {
  if (RuntimeContext.current() !== binding.runtime)
    throw new RestorationError("Installation belongs to another Runtime")
  const handle = Storage.current()
  if (
    binding.runtime.storage !== binding.handle ||
    digest(binding.store.options) !== binding.storeConfigHash ||
    handle.store !== binding.store ||
    handle.artifactDirectory !== binding.artifacts ||
    handle.artifactObjects !== undefined ||
    binding.handle.store !== binding.store ||
    binding.handle.artifactDirectory !== binding.artifacts ||
    binding.handle.artifactObjects !== undefined
  )
    throw new RestorationError("Installation requires its original primary Store and artifact configuration")
  ServerProcessLock.assertCurrent(binding.writer)
}
async function physical(directory: string) {
  const info = await fs.lstat(directory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RestorationError("Installation requires an independent canonical native target")
  return Physical.parse({ device: info.dev.toString(), inode: info.ino.toString() })
}
async function artifacts(expected?: Artifacts): Promise<Artifacts> {
  const requested = path.resolve(Storage.current().artifactDirectory)
  let anchor = requested
  for (;;) {
    const info = await fs.lstat(anchor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new RestorationError("Installation artifact identity requires ordinary native directories")
      break
    }
    const parent = path.dirname(anchor)
    if (parent === anchor) throw new RestorationError("Installation artifact identity is unavailable")
    anchor = parent
  }
  const canonical = await fs.realpath(anchor)
  const directory = path.join(canonical, path.relative(anchor, requested))
  if (expected) {
    if (expected.directory !== directory) throw new RestorationError("Installation artifact identity changed")
    const root = expected.kind === "present" ? expected.directory : expected.parent
    const retained = await physical(root)
    const original = expected.kind === "present" ? expected.identity : expected.parentIdentity
    if ((await fs.realpath(root)) !== root || digest(retained) !== digest(original))
      throw new RestorationError("Installation artifact identity changed")
    return expected
  }
  return anchor === requested
    ? { kind: "present", directory, identity: await physical(anchor) }
    : { kind: "future", directory, parent: canonical, parentIdentity: await physical(anchor) }
}
async function targetIdentity(expectedArtifacts?: Artifacts) {
  const { home, root } = RuntimeContext.current().host
  const handle = Storage.current()
  const options = handle.store.options
  if (root !== path.join(home, ".synergy") || !path.isAbsolute(home))
    throw new RestorationError("Installation requires the owning Runtime's canonical Home")
  const homeIdentity = await physical(home)
  const rootIdentity = await physical(root)
  const database =
    options.backend === "sqlite"
      ? { filename: await fs.realpath(options.filename), identity: await fs.stat(options.filename, { bigint: true }) }
      : undefined
  const storageHash = digest({
    options,
    ...(database
      ? {
          file: database.filename,
          device: database.identity.dev.toString(),
          inode: database.identity.ino.toString(),
        }
      : {}),
  })
  return {
    home: await fs.realpath(home),
    root: await fs.realpath(root),
    homeIdentity,
    rootIdentity,
    storageHash,
    artifacts: await artifacts(expectedArtifacts),
  }
}
async function target(expectedArtifacts?: Artifacts) {
  try {
    return await targetIdentity(expectedArtifacts)
  } catch (error) {
    if (error instanceof RestorationError) throw error
    throw new RestorationError("Installation target native identity is unavailable")
  }
}
async function read(root: string): Promise<Disk | undefined> {
  let file: Awaited<ReturnType<typeof fs.open>>
  try {
    const before = await fs.lstat(filename(root))
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8192)
      throw new RestorationError("Native restoration intent is invalid or unsupported")
    file = await fs.open(filename(root), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const initial = await file.stat()
      if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size)
        throw new RestorationError("Native restoration intent changed while opening")
      const bytes = new Uint8Array(initial.size + 1)
      let used = 0
      for (;;) {
        const next = await file.read(bytes, used, bytes.byteLength - used, used)
        if (!next.bytesRead) break
        used += next.bytesRead
        if (used > initial.size) throw new RestorationError("Native restoration intent changed while reading")
      }
      const final = await file.stat()
      const retained = await fs.lstat(filename(root))
      if (
        used !== initial.size ||
        final.mtimeMs !== initial.mtimeMs ||
        final.ctimeMs !== initial.ctimeMs ||
        retained.dev !== initial.dev ||
        retained.ino !== initial.ino
      )
        throw new RestorationError("Native restoration intent changed while reading")
      try {
        return Disk.parse(JSON.parse(Buffer.from(bytes.subarray(0, used)).toString("utf8")))
      } catch {
        throw new RestorationError("Native restoration intent is invalid or unsupported")
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
function install() {
  if (state().installed) return
  StorageMutationGuard.register("home-restoration", async () => {
    if (!state().blocked && !state().pending) return
    const frame = current.getStore()
    if (!frame?.open) throw new RestorationError("Native Home restoration blocks ordinary namespace mutations")
    frame.signal?.throwIfAborted()
    assertPrimary(frame.binding)
  })
  state().installed = true
}
async function verify(binding: Binding, signal?: AbortSignal) {
  signal?.throwIfAborted()
  assertPrimary(binding)
  if (digest(await target(binding.record.target.artifacts)) !== digest(binding.record.target))
    throw new RestorationError("Installation target native identity changed")
  await ServerProcessLock.verifyOwnership(binding.writer)
  const retained = await read(binding.record.target.root)
  if (!retained || digest(retained) !== digest(binding.record))
    throw new RestorationError("Installation intent changed or is unavailable")
  signal?.throwIfAborted()
  assertPrimary(binding)
}

export namespace HomeRestoration {
  export const Info = Disk.omit({ target: true })
  export type Info = z.infer<typeof Info>
  export interface Target {
    readonly kind: "home-restoration-target"
  }
  export interface InstallPermit {
    readonly kind: "home-installation"
  }
  export function register() {
    RuntimeContext.assertCompositionOpen("native Home restoration")
    install()
  }
  function requireRegistered() {
    if (!state().installed) throw new RestorationError("Register native Home restoration during composition")
  }
  export async function begin(value: z.infer<typeof Request>, options: { signal?: AbortSignal } = {}): Promise<Target> {
    const request = Request.parse(value)
    const requestHash = digest(request)
    const { restoreID, owner, sourceHash } = request
    const signal = options.signal
    signal?.throwIfAborted()
    requireRegistered()
    const runtime = RuntimeContext.current()
    const handle = runtime.storage
    if (!handle || Storage.current() !== handle)
      throw new RestorationError("Installation requires the Runtime's primary Store")
    const objects = handle.artifactObjects
    if (objects) throw new RestorationError("Object artifact installation requires its owning reconstruction port")
    const store = handle.store
    const storeConfigHash = digest(store.options)
    const artifacts = handle.artifactDirectory
    const assertSelection = () => {
      signal?.throwIfAborted()
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage !== handle ||
        Storage.current() !== handle ||
        handle.store !== store ||
        digest(store.options) !== storeConfigHash ||
        handle.artifactDirectory !== artifacts ||
        handle.artifactObjects !== undefined
      )
        throw new RestorationError("Installation requires its original primary Store and artifact configuration")
    }
    const writer = await ServerProcessLock.currentOwnership()
    assertSelection()
    const selected = await target()
    assertSelection()
    return withFileLock({ directory: lockDirectory(selected.root), key: "home-restoration", signal }, async () => {
      signal?.throwIfAborted()
      await ServerProcessLock.verifyOwnership(writer)
      if (digest(await target()) !== digest(selected))
        throw new RestorationError("Installation target identity changed")
      assertSelection()
      let record = await read(selected.root)
      assertSelection()
      if (record) {
        state().blocked = true
        const actual = await target(record.target.artifacts)
        assertSelection()
        if (record.requestHash !== requestHash || digest(record.target) !== digest(actual))
          throw new RestorationError("Native target belongs to a different restoration request")
      } else {
        if (await HomeOwnershipFile.open({ root: selected.root, env: runtime.host.env }).read())
          throw new RestorationError("Fresh restoration requires an empty unowned target Home")
        state().pending++
        try {
          await handle.store.transaction(async (tx) => {
            for await (const _entry of tx.exportEntries())
              throw new RestorationError("Fresh restoration requires an independent empty namespace")
          })
          assertSelection()
          record = Disk.parse({
            schemaVersion: 1,
            restoreID,
            owner,
            sourceHash,
            requestHash,
            installationID: randomUUID(),
            incarnation: randomUUID(),
            phase: "staging",
            target: selected,
          })
          state().blocked = true
          await AtomicFile.writeJsonAtomic(filename(selected.root), JSON.stringify(record) + "\n", {
            private: true,
            durable: true,
          })
        } finally {
          state().pending--
        }
      }
      const binding: Binding = {
        runtime,
        handle,
        store,
        artifacts,
        storeConfigHash,
        writer,
        record,
      }
      await verify(binding, signal)
      const result = Object.freeze({ kind: "home-restoration-target" as const })
      targets.set(result, binding)
      return result
    })
  }
  export async function inspect(selected: Target): Promise<Info> {
    const binding = targets.get(selected)
    if (!binding) throw new RestorationError("Installation requires original native target evidence")
    await verify(binding)
    const { target: _, ...info } = binding.record
    return Info.parse(info)
  }
  export function assertCurrent(permit: InstallPermit) {
    const frame = permits.get(permit)
    if (!frame) throw new RestorationError("Installation requires original native callback evidence")
    if (!frame.open || current.getStore() !== frame)
      throw new RestorationError("Installation callback has ended or is unavailable")
    frame.signal?.throwIfAborted()
    assertPrimary(frame.binding)
  }
  export async function verifyCurrent(permit: InstallPermit) {
    assertCurrent(permit)
    const frame = permits.get(permit)!
    await verify(frame.binding, frame.signal)
    assertCurrent(permit)
  }
  export async function withTarget<T>(
    selected: Target,
    body: (permit: InstallPermit) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const binding = targets.get(selected)
    if (!binding) throw new RestorationError("Installation requires original native target evidence")
    const signal = options.signal
    await verify(binding, signal)
    return withFileLock(
      { directory: lockDirectory(binding.record.target.root), key: "home-restoration", signal },
      async () => {
        await verify(binding, signal)
        const frame: Frame = { binding, signal, open: true }
        const permit = Object.freeze({ kind: "home-installation" as const })
        permits.set(permit, frame)
        try {
          return await current.run(frame, async () => {
            const result = await body(permit)
            await verifyCurrent(permit)
            return result
          })
        } finally {
          frame.open = false
        }
      },
    )
  }
  export async function assertOrdinaryStartup() {
    requireRegistered()
    const record = await read(RuntimeContext.current().host.root)
    if (!record) return
    state().blocked = true
    throw new RestorationError("Native Home restoration is incomplete; use its restricted recovery owner")
  }
}
