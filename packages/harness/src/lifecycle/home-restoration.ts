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
const RestorationRequest = z.strictObject({
  restoreID: ID,
  owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  sourceHash: Hash,
  payload: JsonValue,
})
const FenceRequest = HomeOwnershipFile.FencedInfo.omit({ schemaVersion: true, owner: true })
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
const StagingDisk = z.strictObject({
  schemaVersion: z.literal(1),
  restoreID: ID,
  owner: RestorationRequest.shape.owner,
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
const Completion = z.strictObject({
  schemaVersion: z.literal(2),
  phase: z.literal("completed"),
  intentHash: Hash,
  publicationHash: Hash,
})
const CompletedDisk = StagingDisk.extend({
  schemaVersion: z.literal(2),
  phase: z.literal("completed"),
  publicationHash: Hash,
})
const Disk = z.discriminatedUnion("schemaVersion", [StagingDisk, CompletedDisk])
const StagingInfo = StagingDisk.omit({ target: true })
const CompletedInfo = CompletedDisk.omit({ target: true })
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
  publicationHash?: string
}
interface Frame {
  binding: Binding
  signal?: AbortSignal
  open: boolean
}
const targets = new WeakMap<HomeRestoration.Target, Binding>()
const permits = new WeakMap<HomeRestoration.InstallPermit, Frame>()
const publications = new WeakMap<HomeRestoration.PublicationPermit, { frame: Frame; hash: string }>()
const installedOwners = new WeakMap<
  HomeRestoration.InstallPermit,
  { frame: Frame; ownership: Readonly<HomeOwnershipFile.RestorationInfo> }
>()
const current = RuntimeContext.createAsyncContext<Frame>()
const state = RuntimeContext.state(() => ({
  installed: false,
  blocked: false,
  pending: 0,
  publicationOwners: new Map<string, HomeRestoration.PublicationOwner>(),
}))

function staging(record: Disk) {
  const { publicationHash: _, ...base } = { publicationHash: undefined, ...record }
  return StagingDisk.parse({ ...base, schemaVersion: 1, phase: "staging" })
}
function completion(record: Disk, publicationHash: string) {
  return (
    JSON.stringify(
      Completion.parse({
        schemaVersion: 2,
        phase: "completed",
        intentHash: digest(staging(record)),
        publicationHash,
      }),
    ) + "\n"
  )
}
function decode(bytes: Uint8Array, publicationHash?: string, baseOnly = false): Disk {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  try {
    return StagingDisk.parse(JSON.parse(text))
  } catch {}
  const boundary = text.indexOf("\n")
  const base = StagingDisk.parse(JSON.parse(text.slice(0, boundary)))
  if (boundary < 0 || text.slice(0, boundary + 1) !== JSON.stringify(base) + "\n")
    throw new RestorationError("Native restoration intent has no canonical original frame")
  const tail = text.slice(boundary + 1)
  try {
    const committed = Completion.parse(JSON.parse(tail))
    if (committed.intentHash !== digest(base) || tail !== completion(base, committed.publicationHash))
      throw new RestorationError("Native restoration completion belongs to another original intent")
    return CompletedDisk.parse({
      ...base,
      schemaVersion: 2,
      phase: "completed",
      publicationHash: committed.publicationHash,
    })
  } catch (error) {
    if (baseOnly || (publicationHash && completion(base, publicationHash).startsWith(tail))) return base
    throw error
  }
}

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
async function read(root: string, publicationHash?: string, baseOnly = false): Promise<Disk | undefined> {
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
        return decode(bytes.subarray(0, used), publicationHash, baseOnly)
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
  const retained = await read(binding.record.target.root, binding.publicationHash)
  if (!retained || digest(retained) !== digest(binding.record))
    throw new RestorationError("Installation intent changed or is unavailable")
  signal?.throwIfAborted()
  assertPrimary(binding)
}

export namespace HomeRestoration {
  export const Request = RestorationRequest
  export type Request = z.infer<typeof Request>
  export const Info = z.discriminatedUnion("schemaVersion", [StagingInfo, CompletedInfo])
  export type Info = z.infer<typeof Info>
  export interface Target {
    readonly kind: "home-restoration-target"
  }
  export interface InstallPermit {
    readonly kind: "home-installation"
  }
  export interface PublicationPermit {
    readonly kind: "home-publication"
  }
  export const PublicationStatus = z.strictObject({
    publicationHash: Hash,
    nativeReady: z.boolean(),
    released: z.boolean(),
  })
  export interface PublicationOwner {
    read(info: Info): Promise<z.infer<typeof PublicationStatus>>
  }
  export function registerPublicationOwner(owner: string, contribution: PublicationOwner) {
    RuntimeContext.assertCompositionOpen("native Home publication owner")
    const id = RestorationRequest.shape.owner.parse(owner)
    if (state().publicationOwners.has(id))
      throw new RestorationError("Native Home publication owner is already registered")
    state().publicationOwners.set(id, { read: contribution.read.bind(contribution) })
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
  export function describe(permit: InstallPermit): Info {
    assertCurrent(permit)
    const { target: _, ...info } = permits.get(permit)!.binding.record
    return Info.parse(info)
  }
  export function assertRequest(permit: InstallPermit, value: Request) {
    assertCurrent(permit)
    const request = Request.parse(value)
    if (digest(request) !== permits.get(permit)!.binding.record.requestHash)
      throw new RestorationError("Installation belongs to a different original request")
    assertCurrent(permit)
  }
  export async function verifyCurrent(permit: InstallPermit) {
    assertCurrent(permit)
    const frame = permits.get(permit)!
    await verify(frame.binding, frame.signal)
    assertCurrent(permit)
  }
  export function assertInstalledOwner(permit: InstallPermit): Readonly<HomeOwnershipFile.RestorationInfo> {
    assertCurrent(permit)
    const frame = permits.get(permit)!
    const proof = installedOwners.get(permit)
    if (!proof || proof.frame !== frame)
      throw new RestorationError("Installation requires its freshly verified native Home owner")
    return proof.ownership
  }
  export async function verifyInstalledOwner(
    permit: InstallPermit,
  ): Promise<Readonly<HomeOwnershipFile.RestorationInfo>> {
    assertCurrent(permit)
    installedOwners.delete(permit)
    await verifyCurrent(permit)
    const frame = permits.get(permit)!
    const record = frame.binding.record
    const file = HomeOwnershipFile.open({ root: record.target.root, env: frame.binding.runtime.host.env })
    const ownership = HomeOwnershipFile.RestorationInfo.parse(await file.read())
    assertCurrent(permit)
    if (
      ownership.owner !== record.owner ||
      ownership.installationID !== record.installationID ||
      ownership.incarnation !== record.incarnation
    )
      throw new RestorationError("Native Home owner belongs to another installation")
    const retained = await HomeOwnershipFile.open({
      root: record.target.root,
      env: frame.binding.runtime.host.env,
      selected: ownership,
    }).assert({ required: true })
    await verifyCurrent(permit)
    assertCurrent(permit)
    if (digest(retained) !== digest(ownership)) throw new RestorationError("Native installation ownership changed")
    const proof = Object.freeze({ ...ownership })
    installedOwners.set(permit, { frame, ownership: proof })
    return proof
  }
  export async function installOwner(
    permit: InstallPermit,
    input: z.infer<typeof FenceRequest>,
  ): Promise<HomeOwnershipFile.RestorationInfo> {
    assertCurrent(permit)
    installedOwners.delete(permit)
    const selected = FenceRequest.parse(input)
    const frame = permits.get(permit)!
    const record = frame.binding.record
    const ownership = HomeOwnershipFile.RestorationInfo.parse({
      ...selected,
      schemaVersion: 3,
      owner: record.owner,
      installationID: record.installationID,
      incarnation: record.incarnation,
    })
    await verifyCurrent(permit)
    const files = HomeOwnershipFile.open({
      root: record.target.root,
      env: frame.binding.runtime.host.env,
      selected: ownership,
    })
    await files.persist({ signal: frame.signal })
    await verifyCurrent(permit)
    const retained = await files.assert({ required: true })
    assertCurrent(permit)
    if (digest(retained) !== digest(ownership)) throw new RestorationError("Native installation ownership changed")
    return verifyInstalledOwner(permit)
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
    if (record.phase !== "completed")
      throw new RestorationError("Native Home restoration is incomplete; use its restricted recovery owner")
    await withPublication(
      { installationID: record.installationID, publicationHash: record.publicationHash },
      async (permit) => {
        const status = await verifyPublication(permit)
        if (!status.nativeReady || !status.released)
          throw new RestorationError("Native Home restoration publication is not ready and released")
      },
    )
    state().blocked = false
  }
  function publication(permit: PublicationPermit) {
    const proof = publications.get(permit)
    if (!proof || !proof.frame.open || current.getStore() !== proof.frame)
      throw new RestorationError("Publication requires its original native callback")
    assertPrimary(proof.frame.binding)
    return proof
  }
  export function assertPublication(permit: PublicationPermit) {
    publication(permit)
  }
  export function describePublication(permit: PublicationPermit) {
    const proof = publication(permit)
    const { target: _, ...info } = proof.frame.binding.record
    return { installation: Info.parse(info), publicationHash: proof.hash }
  }
  async function verifyPublicationOwner(binding: Binding) {
    await verify(binding)
    const record = binding.record
    const ownership = HomeOwnershipFile.RestorationInfo.parse(
      await HomeOwnershipFile.open({
        root: record.target.root,
        env: binding.runtime.host.env,
      }).read(),
    )
    if (
      ownership.owner !== record.owner ||
      ownership.installationID !== record.installationID ||
      ownership.incarnation !== record.incarnation
    )
      throw new RestorationError("Publication belongs to another native installation owner")
    await HomeOwnershipFile.open({
      root: record.target.root,
      env: binding.runtime.host.env,
      selected: ownership,
    }).assert({ required: true })
    await verify(binding)
  }
  export async function verifyPublication(permit: PublicationPermit) {
    const proof = publication(permit)
    const binding = proof.frame.binding
    await verifyPublicationOwner(binding)
    const owner = state().publicationOwners.get(binding.record.owner)
    if (!owner) throw new RestorationError("Publication requires its registered native domain owner")
    const status = PublicationStatus.parse(await owner.read(describePublication(permit).installation))
    publication(permit)
    if (status.publicationHash !== proof.hash)
      throw new RestorationError("Native publication differs from its actual committed domain receipt")
    return status
  }
  export async function withPublication<T>(
    input: { installationID: string; publicationHash: string },
    body: (permit: PublicationPermit) => Promise<T>,
  ): Promise<T> {
    requireRegistered()
    if (Storage.inTransaction())
      throw new RestorationError("Publication requires an already committed domain receipt outside SQL")
    const installationID = z.uuid().parse(input.installationID)
    const hash = Hash.parse(input.publicationHash)
    const runtime = RuntimeContext.current()
    const handle = runtime.storage
    if (!handle || Storage.current() !== handle || handle.artifactObjects)
      throw new RestorationError("Publication requires its original primary native Store")
    const record = await read(runtime.host.root, hash)
    if (
      !record ||
      record.installationID !== installationID ||
      (record.phase === "completed" && record.publicationHash !== hash)
    )
      throw new RestorationError("Publication belongs to another native installation")
    state().blocked = true
    const binding: Binding = {
      runtime,
      handle,
      store: handle.store,
      artifacts: handle.artifactDirectory,
      storeConfigHash: digest(handle.store.options),
      writer: await ServerProcessLock.currentOwnership(),
      record,
      publicationHash: hash,
    }
    return withFileLock({ directory: lockDirectory(record.target.root), key: "home-restoration" }, async () => {
      await verifyPublicationOwner(binding)
      const frame: Frame = { binding, open: true }
      const permit = Object.freeze({ kind: "home-publication" as const })
      publications.set(permit, { frame, hash })
      try {
        return await current.run(frame, async () => {
          await verifyPublication(permit)
          const result = await body(permit)
          await verify(binding)
          return result
        })
      } finally {
        frame.open = false
      }
    })
  }
  export async function inspectCompleted() {
    requireRegistered()
    const runtime = RuntimeContext.current()
    const record = await read(runtime.host.root)
    if (!record || record.phase !== "completed") throw new RestorationError("Native Home restoration is incomplete")
    const ownership = HomeOwnershipFile.RestorationInfo.parse(
      await HomeOwnershipFile.open({
        root: runtime.host.root,
        env: runtime.host.env,
      }).read(),
    )
    await assertPendingOwner(ownership)
    const retained = await read(runtime.host.root)
    if (RuntimeContext.current() !== runtime || digest(retained) !== digest(record))
      throw new RestorationError("Native Home completion changed during inspection")
    const { target: _, ...info } = record
    return CompletedInfo.parse(info)
  }
  export async function completePublication(permit: PublicationPermit) {
    const status = await verifyPublication(permit)
    if (!status.nativeReady) throw new RestorationError("Publication requires confirmed current native settings")
    const proof = publication(permit)
    const binding = proof.frame.binding
    if (binding.record.phase === "completed") return describePublication(permit).installation
    const base = JSON.stringify(staging(binding.record)) + "\n"
    const tail = Buffer.from(completion(binding.record, proof.hash))
    const size = Buffer.byteLength(base)
    if (size + tail.byteLength > 8192) throw new RestorationError("Native publication intent exceeds its format")
    const file = filename(binding.record.target.root)
    const before = await fs.lstat(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw new RestorationError("Native publication requires its original independent intent file")
    const held = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const original = await held.stat({ bigint: true })
      if (
        original.dev !== before.dev ||
        original.ino !== before.ino ||
        original.nlink !== 1n ||
        original.size !== before.size
      )
        throw new RestorationError("Native publication intent changed while opening")
      const bytes = new Uint8Array(Number(original.size))
      const read = await held.read(bytes, 0, bytes.byteLength, 0)
      if (
        read.bytesRead !== bytes.byteLength ||
        !Buffer.from(bytes.subarray(0, size)).equals(Buffer.from(base)) ||
        digest(decode(bytes, proof.hash)) !== digest(binding.record)
      )
        throw new RestorationError("Native publication intent changed before completion")
      await verifyPublicationOwner(binding)
      let offset = 0
      while (offset < tail.byteLength) {
        publication(permit)
        const wrote = await held.write(tail, offset, tail.byteLength - offset, size + offset)
        if (!wrote.bytesWritten) throw new RestorationError("Native publication completion write made no progress")
        offset += wrote.bytesWritten
      }
      await held.truncate(size + tail.byteLength)
      await held.sync()
      const retained = await fs.lstat(file, { bigint: true })
      if (retained.dev !== original.dev || retained.ino !== original.ino || retained.nlink !== 1n)
        throw new RestorationError("Native publication intent changed during completion")
      binding.record = CompletedDisk.parse({
        ...binding.record,
        schemaVersion: 2,
        phase: "completed",
        publicationHash: proof.hash,
      })
      await verifyPublicationOwner(binding)
      return describePublication(permit).installation
    } finally {
      await held.close()
    }
  }
  export async function assertPendingOwner(value: HomeOwnershipFile.RestorationInfo) {
    requireRegistered()
    const ownership = HomeOwnershipFile.RestorationInfo.parse(value)
    const runtime = RuntimeContext.current()
    const { home, root } = runtime.host
    const record = await read(root, undefined, true)
    if (
      !record ||
      record.owner !== ownership.owner ||
      record.installationID !== ownership.installationID ||
      record.incarnation !== ownership.incarnation ||
      (await fs.realpath(home)) !== record.target.home ||
      (await fs.realpath(root)) !== record.target.root ||
      digest(await physical(home)) !== digest(record.target.homeIdentity) ||
      digest(await physical(root)) !== digest(record.target.rootIdentity)
    )
      throw new RestorationError("Restored Home ownership requires its actual native installation intent")
    await HomeOwnershipFile.open({ root, env: runtime.host.env, selected: ownership }).assert({ required: true })
    if (RuntimeContext.current() !== runtime)
      throw new RestorationError("Restored Home ownership belongs to another Runtime")
    state().blocked = true
  }
}
