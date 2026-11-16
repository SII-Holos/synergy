import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SessionTransferStream as Stream } from "@ericsanchezok/synergy-harness/session/transfer"
import {
  SessionTransferCore as Core,
  SessionTransferSource as Source,
  SessionTransferStaging as Staging,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationHandoffObjects as Objects } from "../src/handoff-objects"
import { OrganizationHandoffReceive as Receive } from "../src/handoff-receive"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("the receiver stages a real frozen package between isolated native object owners and never retries corrupt retained bytes remotely", async () => {
  await using source = await testRuntime({ register: Core.register })
  await using target = await testRuntime({ register: Core.register })
  const signal = new AbortController().signal
  const captured = await source.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, environmentID: null })
        const identity: Objects.Identity = {
          orgID: "receive-org",
          deploymentIncarnation: "deployment",
          role: "source",
          binding: {
            sessionID: session.id,
            scopeID: session.scope.id,
            handoffID: "native-object-receive",
            sourceID: "runtime-a",
            targetID: "runtime-b",
            fromEpoch: 1,
            toEpoch: 2,
          },
        }
        const objects = await Objects.open(identity, signal)
        const prepared = await Source.prepare({
          binding: identity.binding,
          store: objects.store,
          signal,
          async verify() {},
        })
        await objects.sealSource()
        return { identity, objects, prepared }
      },
    }),
  )
  await target.run(async () => {
    const objects = await Objects.open({ ...captured.identity, role: "target" }, signal)
    let reads = 0
    const receive = Receive.open({
      manifestHash: captured.prepared.manifestHash,
      signal,
      cache: { store: objects.store, contains: objects.contains },
      read(request) {
        reads++
        return source.run(() =>
          captured.objects.range({
            manifestHash: request.manifestHash,
            hash: request.hash,
            offset: request.offset,
            limit: request.length,
          }),
        )
      },
    })
    const root = await receive.root()
    expect(root).toEqual(captured.prepared.root)
    const staged = await Staging.receive({
      handoffID: captured.identity.binding.handoffID,
      root,
      store: receive.store,
      signal,
    })
    expect(staged.phase).toBe("verified")
    expect(reads).toBeGreaterThan(1)
    await expect(Session.get(captured.identity.binding.sessionID)).rejects.toBeInstanceOf(Storage.NotFoundError)
    const before = reads
    expect(await receive.root()).toEqual(root)
    expect(reads).toBe(before)
    const references = await Storage.artifactReferences({ prefix: ["organization_handoff_objects"], limit: 100 })
    const reference = references.find((value) => value.key.at(-1) === captured.prepared.manifestHash)
    if (!reference) throw new Error("Expected retained native root")
    await Storage.writeBinary(reference.key, new Uint8Array([0]))
    await expect(receive.root()).rejects.toThrow("checksum")
    expect(reads).toBe(before)
    expect((await Staging.inspect(captured.identity.binding.handoffID)).phase).toBe("verified")
  })
}, 15000)

test("handoff receiver verifies bounded contiguous ranges before caching and preserves corrupt or incomplete outcomes", async () => {
  const bytes = Uint8Array.from({ length: 400_007 }, (_, index) => index % 251)
  const objectHash = hash(bytes)
  const manifestHash = "a".repeat(64)
  const cached = new Map<string, Uint8Array>()
  const requests: Array<{ hash: string; manifestHash: string; offset: number; length: number }> = []
  let mode: "valid" | "wrong-window" | "wrong-body" | "changing-size" | "abort" = "valid"
  const controller = new AbortController()
  const reason = new Error("Connection owner stopped receiving")
  const receive = Receive.open({
    manifestHash,
    signal: controller.signal,
    cache: {
      async contains(key) {
        return cached.has(key)
      },
      store: {
        async put(key, value) {
          cached.set(key, value.slice())
        },
        async get(key) {
          const value = cached.get(key)
          if (!value) throw new Error("Missing fixture cache")
          return value.slice()
        },
      },
    },
    async read(request) {
      requests.push(request)
      const nextOffset = Math.min(bytes.length, request.offset + request.length)
      if (mode === "abort") controller.abort(reason)
      return {
        hash: objectHash,
        offset: mode === "wrong-window" ? request.offset + 1 : request.offset,
        nextOffset,
        totalBytes: mode === "changing-size" && request.offset > 0 ? bytes.length + 1 : bytes.length,
        data: Buffer.from(
          mode === "wrong-body"
            ? new Uint8Array(nextOffset - request.offset)
            : bytes.subarray(request.offset, nextOffset),
        ).toString("base64url"),
        complete: nextOffset === bytes.length,
      }
    },
  })
  for (const fault of ["wrong-window", "wrong-body", "changing-size"] as const) {
    mode = fault
    await expect(receive.store.get(objectHash, bytes.length)).rejects.toThrow()
    expect(cached.size).toBe(0)
  }
  mode = "valid"
  requests.length = 0
  expect(await receive.store.get(objectHash, bytes.length)).toEqual(bytes)
  expect(requests.map((request) => request.offset)).toEqual([0, 131072, 262144, 393216])
  expect(
    requests.every(
      (request) => request.manifestHash === manifestHash && request.hash === objectHash && request.length <= 128 * 1024,
    ),
  ).toBe(true)
  requests.length = 0
  expect(await receive.store.get(objectHash, bytes.length)).toEqual(bytes)
  expect(requests).toEqual([])
  cached.set(objectHash, new Uint8Array([0]))
  await expect(receive.store.get(objectHash, bytes.length)).rejects.toThrow("checksum")
  expect(requests).toEqual([])
  cached.clear()
  mode = "abort"
  await expect(receive.store.get(objectHash, bytes.length)).rejects.toBe(reason)
  expect(cached.size).toBe(0)
})

test("handoff root decoding preserves the native root hash and refuses oversized frames before reading", async () => {
  const root = Stream.Root.parse({
    format: "synergy-portable-session",
    version: 2,
    complete: true,
    entries: 0,
    bytes: 0,
    pages: 0,
    head: null,
    owners: { "session-core": 2 },
  })
  const bytes = new TextEncoder().encode(JSON.stringify(root))
  let reads = 0
  const receive = Receive.open({
    manifestHash: Stream.digest(root),
    signal: new AbortController().signal,
    cache: {
      async contains() {
        return false
      },
      store: {
        async put() {},
        async get() {
          throw new Error("No fixture cache")
        },
      },
    },
    async read(request) {
      reads++
      return {
        hash: request.hash,
        offset: 0,
        nextOffset: bytes.length,
        totalBytes: bytes.length,
        data: Buffer.from(bytes).toString("base64url"),
        complete: true,
      }
    },
  })
  await expect(receive.store.get(hash(bytes), Stream.chunkBytes + 1)).rejects.toThrow("frame")
  expect(reads).toBe(0)
  expect(await receive.root()).toEqual(root)
  expect(reads).toBe(1)
})
