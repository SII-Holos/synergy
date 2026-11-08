import { randomBytes } from "node:crypto"
import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Protocol,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { readMemberHome, type MemberHome, type MemberIdentity } from "./home"
import { readMemberRegistration } from "./registration"
import { readCredentials } from "./credentials"
import { MemberHomeError } from "./record"
import { OrganizationRuntimeError } from "./error"
import { connectionState } from "./connection-state"

type Connected = z.infer<typeof Protocol.Connected>
export interface MemberConnectionClosed {
  kind: "closed" | "offline" | "replaced" | "rejected"
  error?: OrganizationProtocol.Error
}
export interface MemberConnection {
  connected: Connected
  closed: Promise<MemberConnectionClosed>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}
export interface MemberConnectionOptions {
  home: string
  identity: MemberIdentity
  buildVersion: string
  ca?: string | string[]
  signal?: AbortSignal
  connectTimeoutMs?: number
  commands?: (
    connection: Connected,
    signal: AbortSignal,
  ) => {
    input(delivery: Command.InputDelivery): Promise<Command.Result>
    query(authorization: Command.SignedPermit): Promise<Command.QueryResult>
    skip(authorization: Command.SignedSkip): Promise<Command.Result>
  }
}
const frameLimit = 64 * 1024
const timerLimit = 2 ** 31 - 1
const NativeWebSocket = globalThis.WebSocket as unknown as new (
  url: URL,
  options: Bun.WebSocketOptions,
) => WebSocket & Pick<Bun.WebSocket, "terminate">

function failure(code: OrganizationProtocol.Error["code"], message: string) {
  return new OrganizationRuntimeError({
    code,
    message,
    retryable: code === "RUNTIME_OFFLINE",
    outcome: "not_dispatched",
  })
}

async function attempt(input: {
  options: MemberConnectionOptions
  member: MemberHome
  registration: Protocol.Registration
  epoch: number
  key: CryptoKey
  checkpoint: ReturnType<typeof connectionState>
}): Promise<MemberConnection> {
  const { options, member, registration, epoch } = input
  const proof = Protocol.ConnectionProof.parse({
    purpose: "runtime-connect",
    handshake: {
      type: "handshake",
      protocolVersion: OrganizationProtocol.version,
      orgID: member.identity.orgID,
      deploymentIncarnation: registration.deploymentIncarnation,
      runtimeID: registration.runtimeID,
      runtimeKind: "member",
      accountID: member.identity.accountID,
      deviceID: member.identity.deviceID,
      connectionEpoch: epoch,
      buildVersion: options.buildVersion,
      capabilities: options.commands ? ["bridge", "commands"] : ["bridge"],
      schemas: options.commands ? { bridge: 1, commands: 1 } : { bridge: 1 },
    },
    nonce: randomBytes(32).toString("hex"),
    issuedAt: Date.now(),
  })
  const signature = await Protocol.sign(proof, input.key)
  if (options.signal?.aborted) throw failure("RUNTIME_OFFLINE", "Runtime connection was cancelled")
  const url = new URL("/runtime/v1/connect", member.origin)
  url.protocol = "wss:"
  // Provenance: https://bun.sh/docs/runtime/http/websockets#connect-to-a-websocket-server
  // Local adaptation: a Bun-native TLS client without browser cookies, Origin or compression; no ambient personal client is reused.
  const socket = new NativeWebSocket(url, {
    tls: { ca: options.ca, rejectUnauthorized: true },
    perMessageDeflate: false,
  })
  const ready = Promise.withResolvers<Connected>()
  const closed = Promise.withResolvers<MemberConnectionClosed>()
  const work = new AbortController()
  let stopped = false
  let transportClosed = false
  let transportEndKind: MemberConnectionClosed["kind"] = "offline"
  let connected: Connected | undefined
  let commands: ReturnType<NonNullable<MemberConnectionOptions["commands"]>> | undefined
  let pending = Promise.resolve()
  let queuedFrames = 0
  let queuedBytes = 0
  let sequence = 0
  let expectedSequence: number | undefined
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined

  function stop(result: MemberConnectionClosed) {
    if (stopped) return
    stopped = true
    work.abort()
    clearTimeout(heartbeatTimer)
    clearTimeout(deadline)
    options.signal?.removeEventListener("abort", cancel)
    ready.reject(
      result.error
        ? new OrganizationRuntimeError(result.error)
        : failure("RUNTIME_OFFLINE", "Runtime connection closed"),
    )
    socket.terminate()
    closed.resolve(result)
  }
  function reject(error: unknown) {
    if (stopped) return
    if (work.signal.aborted && !(error instanceof OrganizationRuntimeError)) return stop({ kind: transportEndKind })
    const failure =
      error instanceof OrganizationRuntimeError
        ? error
        : new OrganizationRuntimeError({
            code: "SERVICE_UNAVAILABLE",
            message: "Member Runtime connection failed",
            retryable: false,
            outcome: "unknown",
          })
    stop({ kind: "rejected", error: failure.data })
  }
  function cancel() {
    stop({ kind: "closed" })
  }
  function lease(ms: number) {
    if (stopped || transportClosed) return
    clearTimeout(deadline)
    deadline = setTimeout(() => stop({ kind: "offline" }), ms)
    deadline.unref()
  }
  function send(frame: Protocol.ClientFrame) {
    if (stopped) return
    try {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > frameLimit)
        throw failure("RUNTIME_OFFLINE", "Runtime connection is not receiving frames")
      socket.send(JSON.stringify(frame))
    } catch (error) {
      reject(error)
    }
  }
  function scheduleHeartbeat() {
    if (stopped || transportClosed || !connected) return
    clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => {
      if (stopped || transportClosed) return
      expectedSequence = ++sequence
      send({ type: "heartbeat", connectionEpoch: epoch, sequence })
    }, connected.heartbeatMs)
    heartbeatTimer.unref()
  }
  async function receive(raw: string) {
    if (stopped) return
    let frame: Protocol.ServerFrame
    try {
      frame = Protocol.ServerFrame.parse(JSON.parse(raw))
    } catch {
      throw failure("PROTOCOL_MISMATCH", "Invalid Runtime bridge frame")
    }
    if (frame.type === "error") throw new OrganizationRuntimeError(frame.error)
    if (frame.type === "handshake") {
      if (
        connected ||
        frame.orgID !== member.identity.orgID ||
        frame.deploymentIncarnation !== registration.deploymentIncarnation ||
        frame.signingIdentity.orgID !== frame.orgID ||
        frame.signingIdentity.deploymentIncarnation !== frame.deploymentIncarnation ||
        frame.runtimeID !== registration.runtimeID ||
        frame.connectionEpoch !== epoch ||
        frame.offlineMs <= frame.heartbeatMs ||
        frame.offlineMs > timerLimit
      )
        throw failure("PROTOCOL_MISMATCH", "Runtime handshake does not match this connection")
      await input.checkpoint.save(epoch, work.signal)
      if (stopped || transportClosed) return
      connected = frame
      commands = options.commands?.(frame, work.signal)
      lease(frame.offlineMs)
      scheduleHeartbeat()
      ready.resolve(frame)
      return
    }
    if (frame.type === "command") {
      if (!connected || !commands || frame.connectionEpoch !== epoch)
        throw failure("PROTOCOL_MISMATCH", "Command does not match an active intake connection")
      let reply: Command.Reply
      try {
        const command = frame.command
        reply =
          command.kind === "input"
            ? { kind: "result", result: await commands.input(command.delivery) }
            : command.kind === "skip"
              ? { kind: "result", result: await commands.skip(command.authorization) }
              : { kind: "query", query: await commands.query(command.authorization) }
        reply = Command.Reply.parse(reply)
      } catch (error) {
        reply = {
          kind: "error",
          error:
            error instanceof OrganizationRuntimeError
              ? error.data
              : {
                  code: "SERVICE_UNAVAILABLE",
                  message: "Runtime command receipt is unavailable",
                  outcome: "unknown",
                  retryable: false,
                },
        }
      }
      if (!work.signal.aborted) send({ type: "receipt", connectionEpoch: epoch, exchangeID: frame.exchangeID, reply })
      return
    }
    if (!connected || frame.connectionEpoch !== epoch || frame.sequence !== expectedSequence)
      throw failure("PROTOCOL_MISMATCH", "Heartbeat does not match this connection")
    expectedSequence = undefined
    lease(connected.offlineMs)
    scheduleHeartbeat()
  }
  function disconnected(kind: MemberConnectionClosed["kind"]) {
    transportClosed = true
    transportEndKind = kind
    work.abort()
    clearTimeout(heartbeatTimer)
    clearTimeout(deadline)
    void pending.then(() => stop({ kind }))
  }
  socket.addEventListener("open", () => send({ type: "handshake", proof, signature }))
  socket.addEventListener("error", () => disconnected("offline"))
  socket.addEventListener("close", (event) =>
    disconnected(event.code === 4001 ? "replaced" : event.code === 4003 ? "rejected" : "offline"),
  )
  socket.addEventListener("message", (event) => {
    if (stopped) return
    const raw: unknown = event.data
    if (typeof raw !== "string" || Buffer.byteLength(raw) > frameLimit)
      return reject(failure("PROTOCOL_MISMATCH", "Unsupported Runtime bridge frame"))
    const size = Buffer.byteLength(raw)
    queuedFrames++
    queuedBytes += size
    if (queuedFrames > 16 || queuedBytes > frameLimit * 4)
      return reject(failure("PROTOCOL_MISMATCH", "Runtime bridge receive window exceeded"))
    pending = pending
      .then(() => receive(raw))
      .catch(reject)
      .finally(() => {
        queuedFrames--
        queuedBytes -= size
      })
  })
  options.signal?.addEventListener("abort", cancel, { once: true })
  if (options.signal?.aborted) cancel()
  lease(options.connectTimeoutMs!)
  try {
    const handshake = await ready.promise
    async function close() {
      stop({ kind: "closed" })
      await pending
    }
    return {
      connected: handshake,
      closed: closed.promise.then(async (result) => {
        await pending
        return result
      }),
      close,
      [Symbol.asyncDispose]: close,
    }
  } catch (error) {
    stop({ kind: "rejected" })
    await pending
    throw error
  }
}

export async function openMemberConnection(options: MemberConnectionOptions): Promise<MemberConnection> {
  z.string().min(1).max(256).parse(options.buildVersion)
  const connectTimeoutMs = z
    .number()
    .int()
    .positive()
    .max(timerLimit)
    .parse(options.connectTimeoutMs ?? 5_000)
  const member = await readMemberHome(options.home, options.identity)
  const registration = await readMemberRegistration(member.home, member.identity)
  if (!registration) throw new MemberHomeError("Member Runtime registration is missing")
  const credentials = await readCredentials(member.root)
  if (!credentials || credentials.publicKey !== member.publicKey)
    throw new MemberHomeError("Member Runtime credentials are missing or changed")
  const checkpoint = connectionState(member, registration)
  const current = await checkpoint.read()
  try {
    return await attempt({
      options: { ...options, connectTimeoutMs },
      member,
      registration,
      epoch: current + 1,
      key: credentials.privateKey,
      checkpoint,
    })
  } catch (error) {
    if (
      !(error instanceof OrganizationRuntimeError) ||
      error.data.code !== "STALE_CONNECTION" ||
      error.data.currentConnectionEpoch === undefined ||
      error.data.currentConnectionEpoch <= current
    )
      throw error
    await checkpoint.save(error.data.currentConnectionEpoch, options.signal)
    return attempt({
      options: { ...options, connectTimeoutMs },
      member,
      registration,
      epoch: error.data.currentConnectionEpoch + 1,
      key: credentials.privateKey,
      checkpoint,
    })
  }
}
