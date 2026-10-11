import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { HostIdentity } from "./identity"
import { getRuntimeEndpoint } from "../util/runtime-endpoint"
import { RuntimeContext } from "../lifecycle/context"
import { AsyncLocalStorage } from "node:async_hooks"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export namespace HostConnection {
  const active = RuntimeContext.state(() => new Set<string>())
  const remote = new AsyncLocalStorage<string>()
  const watchers = RuntimeContext.state(() => new Map<string, Set<() => void>>())
  const cleanup = RuntimeContext.state(() => ({ after: 0 }))
  export function watch(hostID: string, close: () => void) {
    const state = watchers()
    const callbacks = state.get(hostID) ?? new Set<() => void>()
    callbacks.add(close)
    state.set(hostID, callbacks)
    return () => {
      callbacks.delete(close)
      if (!callbacks.size) state.delete(hostID)
    }
  }
  function disconnect(hostID?: string) {
    for (const [id, callbacks] of watchers())
      if (!hostID || id === hostID) for (const callback of [...callbacks]) callback()
  }
  export const remoteRequester = () => remote.getStore()
  export const withRemote = <T>(hostID: string, fn: () => T) => remote.run(hostID, fn)
  export const Descriptor = HostIdentity.Info.extend({
    name: z.string().min(1).max(80),
    publicKey: z.string().min(40).max(200),
    url: z.string().url().optional(),
  })
    .strict()
    .meta({ ref: "HostConnectionDescriptor" })
  export const Peer = Descriptor.extend({ pairedAt: z.number(), connectionPath: z.string() }).strict()
  export const Configure = z
    .object({ enabled: z.boolean(), name: z.string().min(1).max(80), url: z.string().optional() })
    .strict()
  export const Invitation = z.object({ code: z.string(), expiresAt: z.number() }).strict()
  const RequestBody = z
    .object({
      requestID: z.string().uuid(),
      pairID: z.string().uuid(),
      requester: Descriptor,
      targetID: z.string(),
      code: z.string().min(1).max(32),
      expiresAt: z.number(),
    })
    .strict()
  const Attempt = RequestBody.omit({ code: true })
  export const PairRequest = RequestBody.extend({ signature: z.string().max(128) }).strict()
  const ReceiptBody = z
    .object({
      requestID: z.string().uuid(),
      pairID: z.string().uuid(),
      requester: Descriptor,
      target: Descriptor,
      phase: z.enum(["pending", "approved"]),
      expiresAt: z.number(),
    })
    .strict()
  export const Receipt = ReceiptBody.extend({ signature: z.string().max(128) }).strict()
  export const Pending = z
    .object({
      requestID: z.string().uuid(),
      direction: z.enum(["incoming", "outgoing"]),
      device: Descriptor,
      expiresAt: z.number(),
      phase: z.enum(["pending", "approved"]),
    })
    .strict()
  export const Packet = z
    .object({
      hostID: z.string(),
      pairID: z.string().uuid(),
      time: z.number().int(),
      nonce: z.string().uuid(),
      signature: z.string().max(128),
    })
    .strict()
  const Identity = z.object({ version: z.literal(1), privateKey: z.string(), publicKey: z.string() }).strict()
  const Configuration = Configure.extend({ version: z.literal(1), pluginID: z.string() }).strict()
  const StoredPeer = z
    .object({ version: z.literal(1), descriptor: Descriptor, pairID: z.string().uuid(), pairedAt: z.number() })
    .strict()
  const key = (...parts: string[]) => ["host_connection", ...parts]
  const hash = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")
  const optional = <T>(read: Promise<T>) =>
    read.catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
  export const Rejected = NamedError.create("HostConnectionRejected", z.object({ message: z.string() }))
  const reject = (message: string) => new Rejected({ message })

  async function identity() {
    using claim = await Lock.write("host-connection-identity")
    const previous = await optional(Storage.read(key("identity")))
    if (previous) return Identity.parse(previous)
    const pair = generateKeyPairSync("ed25519")
    const value = Identity.parse({
      version: 1,
      privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    })
    await Storage.write(key("identity"), value)
    return value
  }

  async function signature(value: unknown) {
    const keys = await identity()
    return sign(
      null,
      Buffer.from(JSON.stringify(value)),
      createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), format: "der", type: "pkcs8" }),
    ).toString("base64url")
  }

  function valid(publicKey: string, value: unknown, signature: string) {
    try {
      const publicObject = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
      return (
        publicObject.asymmetricKeyType === "ed25519" &&
        verify(null, Buffer.from(JSON.stringify(value)), publicObject, Buffer.from(signature, "base64url"))
      )
    } catch {
      return false
    }
  }

  async function configuration() {
    const config = await optional(Storage.read(key("gateway")))
    if (!config || !Configuration.parse(config).enabled || !active().has(Configuration.parse(config).pluginID))
      throw reject("Remote gateway is disabled")
    return Configuration.parse(config)
  }

  export async function configure(pluginID: string, input: z.infer<typeof Configure>) {
    input = Configure.parse(input)
    if (input.url) input.url = address(input.url)
    using claim = await Lock.write("host-connection-configuration")
    const previous = await optional(Storage.read(key("gateway")))
    if (previous && Configuration.parse(previous).enabled && Configuration.parse(previous).pluginID !== pluginID)
      throw reject("Remote gateway belongs to another plugin")
    await Storage.write(key("gateway"), { version: 1, pluginID, ...input })
    if (input.enabled) active().add(pluginID)
    else {
      active().delete(pluginID)
      disconnect()
    }
    return descriptor(input.name, input.url)
  }

  async function descriptor(name: string, url?: string) {
    const keys = await identity()
    return Descriptor.parse({ ...(await HostIdentity.describe()), name, publicKey: keys.publicKey, url })
  }

  export async function describe() {
    const config = await configuration()
    return descriptor(config.name, config.url)
  }

  export async function disableOwner(pluginID: string) {
    using claim = await Lock.write("host-connection-configuration")
    const stored = await optional(Storage.read(key("gateway")))
    if (!stored) return
    const config = Configuration.parse(stored)
    if (config.pluginID !== pluginID) return
    await Storage.write(key("gateway"), { ...config, enabled: false })
    active().delete(pluginID)
    disconnect()
  }

  export async function endpoint() {
    const endpoint = getRuntimeEndpoint()
    return { ...endpoint, url: `${endpoint.url}/host-connection/gateway` }
  }

  export async function invite() {
    await configuration()
    for (const direction of ["incoming", "outgoing"] as const)
      for await (const record of Storage.records<{ request: z.infer<typeof Attempt> }>({ prefix: key(direction) }))
        if (record.value.request.expiresAt < Date.now()) await Storage.remove(record.key)
    const code = randomBytes(6).toString("hex").toUpperCase()
    const expiresAt = Date.now() + 5 * 60_000
    await Storage.write(key("invitation"), { version: 1, digest: hash(code), expiresAt, attempts: 0 })
    return Invitation.parse({ code, expiresAt })
  }

  export async function pairRequest(target: z.infer<typeof Descriptor>, code: string) {
    target = Descriptor.parse(target)
    const requester = await describe()
    if (requester.id === target.id) throw reject("Cannot pair a Host with itself")
    const body = RequestBody.parse({
      requestID: randomUUID(),
      pairID: randomUUID(),
      requester,
      targetID: target.id,
      code: code.replace(/[\s-]/g, "").toUpperCase(),
      expiresAt: Date.now() + 5 * 60_000,
    })
    const request = PairRequest.parse({ ...body, signature: await signature(body) })
    await Storage.write(key("outgoing", request.requestID), {
      version: 1,
      target,
      request: Attempt.strip().parse(body),
    })
    return request
  }

  export async function receivePair(input: z.infer<typeof PairRequest>) {
    input = PairRequest.parse(input)
    const target = await describe()
    const { signature: proof, ...body } = input
    if (
      input.targetID !== target.id ||
      input.requester.id === target.id ||
      input.expiresAt < Date.now() ||
      input.expiresAt > Date.now() + 5 * 60_000 + 30_000 ||
      !valid(input.requester.publicKey, body, proof)
    )
      throw reject("Invalid pairing request signature")
    using claim = await Lock.write("host-connection-invitation")
    const accepted = await Storage.transaction(async () => {
      const invitation = await optional(
        Storage.read<{ digest: string; expiresAt: number; attempts: number }>(key("invitation")),
      )
      if (!invitation || invitation.expiresAt < Date.now() || invitation.attempts >= 5) return false
      const matches = timingSafeEqual(Buffer.from(invitation.digest, "hex"), Buffer.from(hash(input.code), "hex"))
      if (!matches) {
        await Storage.write(key("invitation"), { ...invitation, attempts: invitation.attempts + 1 })
        return false
      }
      await Storage.remove(key("invitation"))
      await Storage.write(key("incoming", input.requestID), {
        version: 1,
        request: Attempt.strip().parse(body),
        phase: "pending",
      })
      return true
    })
    if (!accepted) throw reject("Pairing code is invalid, expired or already used")
    return receipt(input, target, "pending")
  }

  async function receipt(
    request: z.infer<typeof Attempt>,
    target: z.infer<typeof Descriptor>,
    phase: "pending" | "approved",
  ) {
    const body = ReceiptBody.parse({
      requestID: request.requestID,
      pairID: request.pairID,
      requester: request.requester,
      target,
      phase,
      expiresAt: request.expiresAt,
    })
    return Receipt.parse({ ...body, signature: await signature(body) })
  }

  export async function approve(requestID: string) {
    const target = await describe()
    using claim = await Lock.write(`host-connection-pair:${z.string().uuid().parse(requestID)}`)
    const stored = await Storage.read<{ request: z.infer<typeof Attempt>; phase: "pending" | "approved" }>(
      key("incoming", requestID),
    )
    const request = Attempt.parse(stored.request)
    if (request.expiresAt < Date.now()) throw reject("Pairing request expired")
    if (stored.phase === "approved") {
      const peer = await optional(Storage.read(key("peers", request.requester.id)))
      if (!peer || StoredPeer.parse(peer).pairID !== request.pairID) throw reject("Pairing was revoked or replaced")
      return receipt(request, target, "approved")
    }
    await Storage.transaction(async () => {
      await Storage.write(key("peers", request.requester.id), {
        version: 1,
        descriptor: request.requester,
        pairID: request.pairID,
        pairedAt: Date.now(),
      })
      await Storage.write(key("incoming", requestID), { ...stored, phase: "approved" })
    })
    disconnect(request.requester.id)
    return receipt(request, target, "approved")
  }

  export async function pairingStatus(input: { requestID: string; signature: string }) {
    const stored = await Storage.read<{ request: z.infer<typeof Attempt>; phase: "pending" | "approved" }>(
      key("incoming", z.string().uuid().parse(input.requestID)),
    )
    if (!valid(stored.request.requester.publicKey, ["pair-status", input.requestID], input.signature))
      throw reject("Invalid pairing status signature")
    if (stored.request.expiresAt < Date.now()) throw reject("Pairing request expired")
    return receipt(stored.request, await describe(), stored.phase)
  }

  export async function acceptPair(target: z.infer<typeof Descriptor>, input: z.infer<typeof Receipt>) {
    target = Descriptor.parse(target)
    input = Receipt.parse(input)
    const { signature: proof, ...body } = input
    const stored = await Storage.read<{ target: z.infer<typeof Descriptor>; request: z.infer<typeof Attempt> }>(
      key("outgoing", input.requestID),
    )
    const own = await describe()
    if (input.phase !== "approved") throw reject("Pairing has not been approved on the target")
    if (
      input.expiresAt < Date.now() ||
      input.target.id !== target.id ||
      input.target.publicKey !== target.publicKey ||
      stored.target.publicKey !== target.publicKey ||
      input.requester.id !== own.id ||
      input.requester.publicKey !== own.publicKey ||
      input.pairID !== stored.request.pairID ||
      !valid(target.publicKey, body, proof)
    )
      throw reject("Invalid approved pairing signature")
    await Storage.transaction(async () => {
      await Storage.write(key("peers", target.id), {
        version: 1,
        descriptor: target,
        pairID: input.pairID,
        pairedAt: Date.now(),
      })
      await Storage.remove(key("outgoing", input.requestID))
    })
    disconnect(target.id)
    return getPeer(target.id)
  }

  export async function pending() {
    const result: z.infer<typeof Pending>[] = []
    for (const direction of ["incoming", "outgoing"] as const) {
      for await (const { value } of Storage.records<{
        request: z.infer<typeof Attempt>
        target?: z.infer<typeof Descriptor>
        phase?: "pending" | "approved"
      }>({ prefix: key(direction) })) {
        if (value.request.expiresAt < Date.now()) continue
        result.push(
          Pending.parse({
            requestID: value.request.requestID,
            direction,
            device: direction === "incoming" ? value.request.requester : value.target,
            expiresAt: value.request.expiresAt,
            phase: value.phase ?? "pending",
          }),
        )
      }
    }
    return result
  }

  export async function getPeer(hostID: string) {
    const stored = StoredPeer.parse(await Storage.read(key("peers", hostID)))
    return Peer.parse({
      ...stored.descriptor,
      pairedAt: stored.pairedAt,
      connectionPath: `/host-connection/peers/${encodeURIComponent(hostID)}/proxy`,
    })
  }

  export async function peers() {
    const result: z.infer<typeof Peer>[] = []
    for await (const { value } of Storage.records({ prefix: key("peers") }))
      result.push(await getPeer(StoredPeer.parse(value).descriptor.id))
    return result
  }

  export async function revoke(hostID: string) {
    await Storage.remove(key("peers", hostID))
    disconnect(hostID)
  }

  function requestBody(
    packet: Omit<z.infer<typeof Packet>, "signature">,
    targetID: string,
    method: string,
    path: string,
    contentType: string,
    bytes: Uint8Array,
  ) {
    return [
      "synergy-host-request-v1",
      packet.hostID,
      targetID,
      packet.pairID,
      packet.time,
      packet.nonce,
      method,
      path,
      contentType,
      hash(bytes),
    ]
  }

  export async function signRequest(
    hostID: string,
    method: string,
    path: string,
    contentType: string,
    bytes: Uint8Array,
  ) {
    await configuration()
    const stored = await optional(Storage.read(key("peers", hostID)))
    if (!stored) throw reject("Destination Host is not paired")
    const peer = StoredPeer.parse(stored)
    const packet = { hostID: (await describe()).id, pairID: peer.pairID, time: Date.now(), nonce: randomUUID() }
    return Packet.parse({
      ...packet,
      signature: await signature(requestBody(packet, hostID, method, path, contentType, bytes)),
    })
  }

  export async function authorize(
    input: z.infer<typeof Packet>,
    method: string,
    path: string,
    contentType: string,
    bytes: Uint8Array,
  ) {
    const packet = Packet.parse(input)
    const own = await describe()
    if (Math.abs(Date.now() - packet.time) > 30_000) throw reject("Remote request expired")
    const result = await Storage.transaction(async () => {
      const stored = await optional(Storage.read(key("peers", packet.hostID)))
      if (!stored) throw reject("Requester Host is not paired")
      const peer = StoredPeer.parse(stored)
      if (
        peer.pairID !== packet.pairID ||
        !valid(
          peer.descriptor.publicKey,
          requestBody(packet, own.id, method, path, contentType, bytes),
          packet.signature,
        )
      )
        throw reject("Remote request signature is invalid")
      const nonce = key("nonces", packet.hostID, packet.nonce)
      if (await optional(Storage.read(nonce))) throw reject("Remote request was replayed")
      await Storage.write(nonce, { version: 1, expiresAt: packet.time + 30_000 })
      return peer.descriptor
    })
    if (Date.now() >= cleanup().after) {
      using claim = await Lock.write("host-connection-nonce-cleanup")
      if (Date.now() >= cleanup().after) {
        await Storage.transaction(async () => {
          for await (const record of Storage.records<{ expiresAt: number }>({ prefix: key("nonces") }))
            if (record.value.expiresAt < Date.now()) await Storage.remove(record.key)
        })
        cleanup().after = Date.now() + 30_000
      }
    }
    return result
  }

  export function address(value: string) {
    const url = new URL(value)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw reject("A remote Host requires an HTTPS origin")
    return url.origin
  }

  export async function readBody(request: Request | Response, limit: number) {
    const length = Number(request.headers.get("content-length"))
    if (length > limit) throw reject("Remote request or response is oversized")
    if (!request.body) return new Uint8Array()
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > limit) throw reject("Remote request or response is oversized")
        chunks.push(item.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  async function remoteJSON(url: string, path: string, body?: unknown) {
    const response = await fetch(`${address(url)}/${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw reject(`Remote Host rejected the request (${response.status})`)
    return JSON.parse(new TextDecoder().decode(await readBody(response, 32768))) as unknown
  }

  function validateReceipt(
    target: z.infer<typeof Descriptor>,
    request: z.infer<typeof Attempt>,
    input: z.infer<typeof Receipt>,
  ) {
    const { signature: proof, ...body } = input
    if (
      input.target.id !== target.id ||
      input.target.publicKey !== target.publicKey ||
      input.requestID !== request.requestID ||
      input.pairID !== request.pairID ||
      input.requester.id !== request.requester.id ||
      input.requester.publicKey !== request.requester.publicKey ||
      input.expiresAt !== request.expiresAt ||
      !valid(target.publicKey, body, proof)
    )
      throw reject("Pairing target changed or signature is invalid")
  }

  export async function probe(url: string) {
    return Descriptor.parse({ ...Descriptor.parse(await remoteJSON(url, "descriptor")), url: address(url) })
  }

  export async function pair(target: z.infer<typeof Descriptor>, code: string) {
    if (!target.url) throw reject("Destination address is unavailable")
    const request = await pairRequest(target, code)
    const result = Receipt.parse(await remoteJSON(target.url, "pair", request))
    validateReceipt(target, request, result)
    return result
  }

  export async function finish(requestID: string) {
    const stored = await Storage.read<{ target: z.infer<typeof Descriptor>; request: z.infer<typeof Attempt> }>(
      key("outgoing", z.string().uuid().parse(requestID)),
    )
    if (!stored.target.url) throw reject("Destination address is unavailable")
    const result = Receipt.parse(
      await remoteJSON(stored.target.url, "pair/status", {
        requestID,
        signature: await signature(["pair-status", requestID]),
      }),
    )
    validateReceipt(stored.target, stored.request, result)
    if (result.phase === "approved") await acceptPair(stored.target, result)
    return result
  }
}
