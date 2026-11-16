import { z } from "zod"
import { RuntimeContext } from "./context"
import { HomeOwnership } from "./home-ownership"
import { Storage } from "../storage/storage"
import { ServerProcessLock } from "../util/server-process-lock"

export namespace NativeNamespaceIdentity {
  export const Descriptor = z.strictObject({
    owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    identity: z
      .record(z.string().min(1).max(128), z.string().min(1).max(4096))
      .refine((value) => Object.keys(value).length <= 32),
  })
  export type Descriptor = z.infer<typeof Descriptor>
  export interface Evidence {
    readonly kind: "native-namespace-identity"
  }
  interface Source {
    owner: string
    read(): Promise<Record<string, string>>
  }
  interface Binding {
    runtime: RuntimeContext.Instance
    source: Source
    handle: Storage.Handle
    store: Storage.Handle["store"]
    directory: string
    objects: Storage.Handle["artifactObjects"]
    objectConfig?: Pick<NonNullable<Storage.Handle["artifactObjects"]>, "blobs" | "writerID" | "now">
    home: string
    root: string
  }
  interface Captured extends Binding {
    descriptor: Descriptor
    fence: HomeOwnership.Info
    writer: ServerProcessLock.Ownership
  }
  const state = RuntimeContext.state(() => ({ source: undefined as Source | undefined }))
  const evidence = new WeakMap<Evidence, Captured>()

  export class Error extends globalThis.Error {
    override readonly name = "NativeNamespaceIdentityError"
  }
  function assertPrimary(binding: Binding) {
    if (binding.runtime !== RuntimeContext.current() || state().source !== binding.source)
      throw new Error("Namespace identity requires its original Runtime source")
    const handle = Storage.current()
    const primary = binding.runtime.storage
    if (
      primary !== binding.handle ||
      primary.store !== binding.store ||
      handle.store !== binding.store ||
      primary.artifactDirectory !== binding.directory ||
      handle.artifactDirectory !== binding.directory ||
      primary.artifactObjects !== binding.objects ||
      handle.artifactObjects !== binding.objects ||
      binding.objects?.blobs !== binding.objectConfig?.blobs ||
      binding.objects?.writerID !== binding.objectConfig?.writerID ||
      binding.objects?.now !== binding.objectConfig?.now ||
      binding.runtime.host.home !== binding.home ||
      binding.runtime.host.root !== binding.root
    )
      throw new Error("Namespace identity requires its original primary Store and artifact configuration")
  }
  function selected(): Binding {
    const source = state().source
    if (!source) throw new Error("Native namespace identity is unavailable")
    const runtime = RuntimeContext.current()
    const handle = runtime.storage
    if (!handle) throw new Error("Namespace identity requires its primary Store")
    const objects = handle.artifactObjects
    const binding: Binding = {
      runtime,
      source,
      handle,
      store: handle.store,
      directory: handle.artifactDirectory,
      objects,
      objectConfig: objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now },
      home: runtime.host.home,
      root: runtime.host.root,
    }
    assertPrimary(binding)
    return binding
  }
  function value(binding: Binding, identity: Record<string, string>): Descriptor {
    const parsed = Descriptor.parse({ owner: binding.source.owner, identity })
    return Object.freeze({
      owner: parsed.owner,
      identity: Object.freeze(
        Object.fromEntries(Object.entries(parsed.identity).sort(([a], [b]) => a.localeCompare(b))),
      ),
    })
  }
  async function fence(binding: Binding) {
    assertPrimary(binding)
    const selected = await HomeOwnership.assert({ required: true })
    assertPrimary(binding)
    if (!selected || selected.owner !== binding.source.owner)
      throw new Error("Namespace identity requires its owning Home reader")
    return selected
  }
  function original(proof: Evidence) {
    const captured = evidence.get(proof)
    if (!captured) throw new Error("Namespace identity has no native evidence")
    assertPrimary(captured)
    ServerProcessLock.assertCurrent(captured.writer)
    return captured
  }
  export function register(source: Source): void {
    RuntimeContext.assertCompositionOpen("native namespace identity")
    if (state().source) throw new Error("Native namespace identity is already registered")
    const owner = Descriptor.shape.owner.parse(source.owner)
    if (typeof source.read !== "function") throw new Error("Namespace identity requires its owning reader")
    state().source = Object.freeze({ owner, read: source.read.bind(source) })
  }
  export async function capture(): Promise<Evidence> {
    const binding = selected()
    const writer = await ServerProcessLock.currentOwnership()
    const home = await fence(binding)
    const descriptor = value(binding, await binding.source.read())
    assertPrimary(binding)
    if (JSON.stringify(await fence(binding)) !== JSON.stringify(home)) throw new Error("Namespace Home reader changed")
    await ServerProcessLock.verifyOwnership(writer)
    assertPrimary(binding)
    const proof = Object.freeze({ kind: "native-namespace-identity" as const })
    evidence.set(proof, { ...binding, descriptor, fence: home, writer })
    return proof
  }
  export function inspect(proof: Evidence): Descriptor {
    return Descriptor.parse(original(proof).descriptor)
  }
  export async function verify(proof: Evidence): Promise<void> {
    const captured = original(proof)
    if (JSON.stringify(await fence(captured)) !== JSON.stringify(captured.fence))
      throw new Error("Namespace Home reader changed")
    const descriptor = value(captured, await captured.source.read())
    assertPrimary(captured)
    if (JSON.stringify(descriptor) !== JSON.stringify(captured.descriptor))
      throw new Error("Namespace identity changed")
    if (JSON.stringify(await fence(captured)) !== JSON.stringify(captured.fence))
      throw new Error("Namespace Home reader changed")
    await ServerProcessLock.verifyOwnership(captured.writer)
    assertPrimary(captured)
  }
}
