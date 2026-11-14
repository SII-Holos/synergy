import { randomBytes } from "node:crypto"
import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Protocol,
  OrganizationCommandProtocol as Command,
  OrganizationSyncProtocol as Sync,
  OrganizationReadProtocol as Read,
  OrganizationInteractionProtocol as Interactions,
  OrganizationHandoffProtocol as Handoff,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import { readRuntimeHome, type RuntimeHome, type RuntimeIdentity } from "./home"
import { readRuntimeRegistration } from "./registration"
import { readCredentials } from "./credentials"
import { MemberHomeError } from "./record"
import { OrganizationRuntimeError } from "./error"
import { connectionState } from "./connection-state"
import { createMemberResourceClient, type MemberResourceClient } from "./resource-client"

type Connected = z.infer<typeof Protocol.Connected>
export interface MemberConnectionClosed {
  kind: "closed" | "offline" | "replaced" | "rejected"
  error?: OrganizationProtocol.Error
}
export interface MemberConnection {
  readonly signal: AbortSignal
  connected: Connected
  resources: MemberResourceClient
  closed: Promise<MemberConnectionClosed>
  close(): Promise<void>
  syncState(sessionID: string, signal?: AbortSignal): Promise<Sync.Share>
  observeSync(sessionID: string, observation: Sync.StateObservation, signal?: AbortSignal): Promise<Sync.Share>
  syncBatchReceipt(query: Sync.BatchReceiptQuery, signal?: AbortSignal): Promise<Sync.BatchReceipt>
  sync(batch: Sync.Batch, signal?: AbortSignal): Promise<Sync.Ack>
  notify(notice: Notification.Observation): void
  uploadBlob(
    input: {
      sessionID: string
      shareGeneration: number
      hash: string
      offset: number
      totalBytes: number
      bytes: Uint8Array
    },
    signal?: AbortSignal,
  ): Promise<Sync.BlobStatus>
  [Symbol.asyncDispose](): Promise<void>
}
export interface MemberConnectionOptions {
  home: string
  identity: RuntimeIdentity
  buildVersion: string
  ca?: string | string[]
  signal?: AbortSignal
  connectTimeoutMs?: number
  commands?: (
    connection: Connected,
    signal: AbortSignal,
    resources: MemberResourceClient,
  ) => {
    create(delivery: Command.CreateDelivery): Promise<Command.CreatedResult>
    control(
      delivery: Command.ControlDelivery,
      received?: (result: Command.ControlResult) => void,
    ): Promise<Command.ControlResult>
    input(delivery: Command.InputDelivery): Promise<Command.Result>
    decision(delivery: Command.DecisionDelivery): Promise<Command.DecisionResult>
    query(authorization: Command.SignedPermit): Promise<Command.QueryResult>
    skip(authorization: Command.SignedSkip): Promise<Command.Result>
    close?(): void | Promise<void>
  }
  sync?: boolean
  syncVersion?: 1 | typeof Sync.observationVersion
  notifications?: boolean
  handoff?: (
    authorization: Handoff.SignedMachinePlan,
    connection: Connected,
    signal: AbortSignal,
    resources: MemberResourceClient,
  ) => Promise<Handoff.MachineExecution>
  handoffInspection?: (
    authorization: Handoff.SignedInspectionPlan,
    connection: Connected,
    signal: AbortSignal,
  ) => Promise<Handoff.InspectionResult>
  handoffVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | typeof Handoff.syncTransferBridge
  read?: (authorization: Read.SignedPermit, connection: Connected, signal: AbortSignal) => Promise<Read.Result>
  interactions?: (
    authorization: Interactions.SignedPermit,
    connection: Connected,
    signal: AbortSignal,
  ) => Promise<Interactions.Result>
  onConnected?: (
    connection: MemberConnection,
    signal: AbortSignal,
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}
const frameLimit = 64 * 1024
const syncFrameLimit = 1024 * 1024
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
  member: RuntimeHome
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
      runtimeKind: registration.runtimeKind,
      ...(registration.runtimeKind === "member"
        ? { accountID: registration.accountID, deviceID: registration.deviceID }
        : {}),
      connectionEpoch: epoch,
      buildVersion: options.buildVersion,
      capabilities: [
        "bridge",
        ...(options.commands ? ["commands"] : []),
        ...(options.sync ? ["sync"] : []),
        ...(options.notifications ? ["notifications"] : []),
        ...(options.read ? ["reads"] : []),
        ...(options.interactions ? ["interactions"] : []),
        ...(options.handoff ? ["handoffs"] : []),
      ],
      schemas: {
        bridge: 1,
        ...(options.commands ? { commands: 1 } : {}),
        ...(options.sync ? { sync: options.syncVersion ?? 1 } : {}),
        ...(options.notifications ? { notifications: Notification.Version } : {}),
        ...(options.handoff ? { handoffs: options.handoffVersion ?? 1 } : {}),
        ...(options.read ? { reads: 1 } : {}),
        ...(options.interactions ? { interactions: 1 } : {}),
      },
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
  let resources: ReturnType<typeof createMemberResourceClient> | undefined
  let pending = Promise.resolve()
  const executing = new Map<string, Promise<void>>()
  const windows = {
    command: { count: 0, bytes: 0 },
    reconciliation: { count: 0, bytes: 0 },
    read: { count: 0, bytes: 0 },
  }
  let queuedFrames = 0
  let queuedBytes = 0
  let sequence = 0
  let expectedSequence: number | undefined
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const chunks = new Map<
    string,
    { connectionEpoch: number; total: number; next: number; bytes: number; parts: Buffer[] }
  >()
  let chunkBytes = 0
  const pendingSync = new Map<
    string,
    {
      kind: "state" | "batch" | "receipt"
      resolve(value: Sync.Share | Sync.Ack | Sync.BatchReceipt): void
      reject(error: unknown): void
      timer: ReturnType<typeof setTimeout>
      signal?: AbortSignal
      cancel?: () => void
    }
  >()
  const pendingBlobs = new Map<
    string,
    {
      resolve(value: Sync.BlobStatus): void
      reject(error: unknown): void
      timer: ReturnType<typeof setTimeout>
      signal?: AbortSignal
      cancel?: () => void
    }
  >()

  function stop(result: MemberConnectionClosed) {
    if (stopped) return
    stopped = true
    work.abort()
    chunks.clear()
    chunkBytes = 0
    clearTimeout(heartbeatTimer)
    clearTimeout(deadline)
    options.signal?.removeEventListener("abort", cancel)
    const error = result.error
      ? new OrganizationRuntimeError(result.error)
      : failure("RUNTIME_OFFLINE", "Runtime connection closed")
    for (const [exchangeID, request] of pendingSync) {
      pendingSync.delete(exchangeID)
      clearTimeout(request.timer)
      request.signal?.removeEventListener("abort", request.cancel!)
      request.reject(error)
    }
    for (const [exchangeID, request] of pendingBlobs) {
      pendingBlobs.delete(exchangeID)
      clearTimeout(request.timer)
      request.signal?.removeEventListener("abort", request.cancel!)
      request.reject(error)
    }
    ready.reject(error)
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
      const encoded = JSON.stringify(frame)
      const limit =
        frame.type === "sync-batch" ||
        frame.type === "blob-chunk" ||
        (frame.type === "receipt" &&
          (frame.reply.kind === "read" || frame.reply.kind === "interactions" || frame.reply.kind === "handoff"))
          ? syncFrameLimit
          : frameLimit
      if (
        Buffer.byteLength(encoded) > limit ||
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > syncFrameLimit
      ) {
        throw failure("RUNTIME_OFFLINE", "Runtime connection is not receiving frames")
      }
      socket.send(encoded)
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
  function dispatchCommand(frame: Extract<Protocol.ServerFrame, { type: "command" }>, bytes: number) {
    if (
      !connected ||
      (!commands && frame.command.kind !== "handoff" && frame.command.kind !== "handoff-inspection") ||
      frame.connectionEpoch !== epoch
    )
      throw failure("PROTOCOL_MISMATCH", "Command does not match an active intake connection")
    if (work.signal.aborted) return
    if (executing.has(frame.exchangeID)) throw failure("PROTOCOL_MISMATCH", "Duplicate active command exchange")
    const window =
      frame.command.kind === "query" || frame.command.kind === "skip"
        ? windows.reconciliation
        : frame.command.kind === "read" ||
            frame.command.kind === "interactions" ||
            frame.command.kind === "handoff" ||
            frame.command.kind === "handoff-inspection"
          ? windows.read
          : windows.command
    if (
      window.count >=
        (frame.command.kind === "read" ||
        frame.command.kind === "interactions" ||
        frame.command.kind === "handoff" ||
        frame.command.kind === "handoff-inspection"
          ? 4
          : 16) ||
      window.bytes + bytes > frameLimit * 4
    ) {
      send({
        type: "receipt",
        connectionEpoch: epoch,
        exchangeID: frame.exchangeID,
        reply: {
          kind: "error",
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Runtime command window is busy",
            outcome: "not_dispatched",
            retryable: true,
          },
        },
      })
      return
    }
    window.count++
    window.bytes += bytes
    const task = execute(frame, commands)
      .catch(reject)
      .finally(() => {
        executing.delete(frame.exchangeID)
        window.count--
        window.bytes -= bytes
      })
    executing.set(frame.exchangeID, task)
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
        frame.offlineMs > timerLimit ||
        frame.syncVersion !==
          (options.sync && options.syncVersion === Sync.observationVersion ? Sync.observationVersion : undefined)
      )
        throw failure("PROTOCOL_MISMATCH", "Runtime handshake does not match this connection")
      await input.checkpoint.save(epoch, work.signal)
      if (stopped || transportClosed) return
      connected = frame
      resources = createMemberResourceClient({
        origin: member.origin,
        connection: frame,
        key: input.key,
        ca: options.ca,
        signal: work.signal,
      })
      commands = options.commands?.(frame, work.signal, resources.resources)
      lease(frame.offlineMs)
      scheduleHeartbeat()
      ready.resolve(frame)
      return
    }
    if (frame.type === "command") {
      dispatchCommand(frame, Buffer.byteLength(raw))
      return
    }
    if (frame.type === "command-chunk") {
      if (!connected || !commands || frame.connectionEpoch !== epoch)
        throw failure("PROTOCOL_MISMATCH", "Command chunk does not match an active intake connection")
      if (frame.index >= frame.total) throw failure("PROTOCOL_MISMATCH", "Command chunk index is out of range")
      let transfer = chunks.get(frame.exchangeID)
      if (!transfer) {
        if (frame.index !== 0) throw failure("PROTOCOL_MISMATCH", "Command chunks must start at index zero")
        transfer = { connectionEpoch: frame.connectionEpoch, total: frame.total, next: 0, bytes: 0, parts: [] }
        chunks.set(frame.exchangeID, transfer)
      }
      if (
        transfer.connectionEpoch !== frame.connectionEpoch ||
        transfer.total !== frame.total ||
        transfer.next !== frame.index
      )
        throw failure("PROTOCOL_MISMATCH", "Command chunks are not contiguous")
      const bytes = Buffer.from(frame.data, "base64url")
      if (bytes.length === 0 || bytes.toString("base64url") !== frame.data)
        throw failure("PROTOCOL_MISMATCH", "Command chunk encoding is invalid")
      if (chunkBytes + bytes.byteLength > 64 * 1024 * 1024)
        throw failure("SERVICE_UNAVAILABLE", "Runtime command chunk buffer is full")
      transfer.parts.push(bytes)
      transfer.bytes += bytes.byteLength
      transfer.next++
      chunkBytes += bytes.byteLength
      if (transfer.next !== transfer.total) return
      chunks.delete(frame.exchangeID)
      chunkBytes -= transfer.bytes
      let command: Command.Delivery
      try {
        command = Command.Delivery.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(transfer.parts))),
        )
      } catch {
        throw failure("PROTOCOL_MISMATCH", "Chunked command payload is invalid")
      }
      dispatchCommand(
        { type: "command", connectionEpoch: frame.connectionEpoch, exchangeID: frame.exchangeID, command },
        frameLimit,
      )
      return
    }
    if (frame.type === "sync-state" || frame.type === "sync-ack" || frame.type === "sync-batch-receipt") {
      if (!connected || frame.connectionEpoch !== epoch)
        throw failure("PROTOCOL_MISMATCH", "Sync response does not match an active connection")
      const request = pendingSync.get(frame.exchangeID)
      if (
        !request ||
        request.kind !== (frame.type === "sync-state" ? "state" : frame.type === "sync-ack" ? "batch" : "receipt")
      )
        throw failure("PROTOCOL_MISMATCH", "Unknown Runtime sync exchange")
      pendingSync.delete(frame.exchangeID)
      clearTimeout(request.timer)
      request.signal?.removeEventListener("abort", request.cancel!)
      request.resolve(
        frame.type === "sync-state"
          ? Sync.Share.parse(frame.share)
          : frame.type === "sync-ack"
            ? Sync.Ack.parse(frame.ack)
            : Sync.BatchReceipt.parse(frame.receipt),
      )
      lease(connected.offlineMs)
      return
    }
    if (frame.type === "blob-ack") {
      if (!connected || frame.connectionEpoch !== epoch)
        throw failure("PROTOCOL_MISMATCH", "Blob response does not match an active connection")
      const request = pendingBlobs.get(frame.exchangeID)
      if (!request) throw failure("PROTOCOL_MISMATCH", "Unknown Runtime blob exchange")
      pendingBlobs.delete(frame.exchangeID)
      clearTimeout(request.timer)
      request.signal?.removeEventListener("abort", request.cancel!)
      request.resolve(Sync.BlobStatus.parse(frame.status))
      lease(connected.offlineMs)
      return
    }
    if (!connected || frame.connectionEpoch !== epoch || frame.sequence !== expectedSequence)
      throw failure("PROTOCOL_MISMATCH", "Heartbeat does not match this connection")
    expectedSequence = undefined
    lease(connected.offlineMs)
    scheduleHeartbeat()
  }
  async function execute(frame: Extract<Protocol.ServerFrame, { type: "command" }>, receiver: typeof commands) {
    let replied = false
    function respond(reply: Command.Reply) {
      if (replied) return
      reply = Command.Reply.parse(reply)
      replied = true
      if (!work.signal.aborted) send({ type: "receipt", connectionEpoch: epoch, exchangeID: frame.exchangeID, reply })
    }
    let reply: Command.Reply
    try {
      const command = frame.command
      if (command.kind === "handoff-inspection") {
        if (!options.handoffInspection || !connected)
          throw failure("PROTOCOL_MISMATCH", "Handoff inspection is unavailable")
        const { plan, signature } = command.authorization
        if (
          plan.orgID !== connected.orgID ||
          plan.deploymentIncarnation !== connected.deploymentIncarnation ||
          plan.keyID !== connected.signingIdentity.keyID ||
          plan.runtimeID !== connected.runtimeID ||
          plan.connectionEpoch !== connected.connectionEpoch ||
          plan.issuedAt > Date.now() ||
          plan.expiresAt <= Date.now() ||
          !(await Handoff.verifyInspection(plan, signature, connected.signingIdentity.publicKey))
        )
          throw failure("PERMISSION_DENIED", "Handoff inspection does not match this finite connection")
        const result = Handoff.InspectionResult.parse(
          await options.handoffInspection(command.authorization, connected, work.signal),
        )
        if (!Handoff.matchesInspection(plan, result))
          throw failure("PROTOCOL_MISMATCH", "Handoff inspection returned another participant")
        respond({ kind: "handoff-inspection", authorization: command.authorization, result })
        return
      }
      if (command.kind === "handoff") {
        if (!options.handoff || !connected || !resources)
          throw failure("PROTOCOL_MISMATCH", "Native handoff control is unavailable")
        const { plan, signature } = command.authorization
        if (
          plan.orgID !== connected.orgID ||
          plan.deploymentIncarnation !== connected.deploymentIncarnation ||
          plan.keyID !== connected.signingIdentity.keyID ||
          plan.runtimeID !== connected.runtimeID ||
          plan.connectionEpoch !== connected.connectionEpoch ||
          plan.issuedAt > Date.now() ||
          plan.expiresAt <= Date.now() ||
          !(await Handoff.verifyMachinePlan(plan, signature, connected.signingIdentity.publicKey))
        )
          throw failure("PERMISSION_DENIED", "Handoff machine plan is invalid for this connection")
        const execution = Handoff.MachineExecution.parse(
          await options.handoff(command.authorization, connected, work.signal, resources.resources),
        )
        const result = Handoff.MachineResult.parse({
          ...execution,
          facts: await Promise.all(
            execution.facts.map(async (proof) => ({ proof, signature: await Handoff.signProof(proof, input.key) })),
          ),
        })
        if (!Handoff.matchesMachine(plan, result))
          throw failure("PROTOCOL_MISMATCH", "Native handoff returned another operation or binding")
        respond({ kind: "handoff", authorization: command.authorization, result })
        return
      }
      if (command.kind === "interactions") {
        if (!options.interactions || !connected)
          throw failure("PROTOCOL_MISMATCH", "Native interaction reads are unavailable")
        const result = await options.interactions(command.authorization, connected, work.signal)
        if (!Interactions.matches(command.authorization.permit.query, result, command.authorization.permit.binding))
          throw failure("PROTOCOL_MISMATCH", "Native interaction read returned another target")
        respond({ kind: "interactions", authorization: command.authorization, result })
        return
      }
      if (command.kind === "read") {
        if (!options.read || !connected) throw failure("PROTOCOL_MISMATCH", "Private native reads are unavailable")
        const result = await options.read(command.authorization, connected, work.signal)
        if (!Read.matches(command.authorization.permit.query, result, Read.bindingFor(command.authorization.permit)))
          throw failure("PROTOCOL_MISMATCH", "Private native read returned another target")
        respond({ kind: "read", authorization: command.authorization, result })
        return
      }
      if (!receiver) throw failure("PROTOCOL_MISMATCH", "Native command intake is unavailable")
      reply =
        command.kind === "create"
          ? { kind: "result", result: await receiver.create(command.delivery) }
          : command.kind === "control"
            ? {
                kind: "result",
                result: await receiver.control(command.delivery, (result) =>
                  respond({ kind: "result", result: Command.ControlResult.parse(result) }),
                ),
              }
            : command.kind === "input"
              ? { kind: "result", result: await receiver.input(command.delivery) }
              : command.kind === "decision"
                ? { kind: "result", result: await receiver.decision(command.delivery) }
                : command.kind === "skip"
                  ? { kind: "result", result: await receiver.skip(command.authorization) }
                  : { kind: "query", query: await receiver.query(command.authorization) }
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
    respond(reply)
  }
  let draining: Promise<void> | undefined
  function drain() {
    return (draining ??= (async () => {
      const errors: unknown[] = []
      for (const task of [
        () => pending,
        () => Promise.all(executing.values()),
        () => commands?.close?.(),
        () => resources?.close(),
      ]) {
        try {
          await task()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, "Member connection owners could not drain")
    })())
  }
  function syncRequest<T extends "state" | "batch" | "receipt">(
    kind: T,
    frame: T extends "state"
      ? Protocol.SyncStateRequest
      : T extends "batch"
        ? Protocol.SyncBatch
        : Protocol.SyncBatchReceipt,
    signal?: AbortSignal,
  ): Promise<T extends "state" ? Sync.Share : T extends "batch" ? Sync.Ack : Sync.BatchReceipt> {
    if (!connected || !options.sync)
      return Promise.reject(failure("PROTOCOL_MISMATCH", "Shared Session sync is not enabled"))
    if (signal?.aborted) return Promise.reject(failure("RUNTIME_OFFLINE", "Sync request was cancelled"))
    const exchangeID = frame.exchangeID
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const request = pendingSync.get(exchangeID)
          if (!request) return
          pendingSync.delete(exchangeID)
          signal?.removeEventListener("abort", request.cancel!)
          reject(failure("SERVICE_UNAVAILABLE", "Runtime sync response was not observed"))
        },
        Math.min(30_000, Math.max(5_000, connected!.offlineMs * 4)),
      )
      timer.unref()
      const request = {
        kind,
        resolve: resolve as (value: Sync.Share | Sync.Ack | Sync.BatchReceipt) => void,
        reject,
        timer,
        signal,
        cancel: () => {
          if (!pendingSync.has(exchangeID)) return
          signal?.removeEventListener("abort", request.cancel)
          reject(failure("RUNTIME_OFFLINE", "Sync request was cancelled"))
        },
      }
      pendingSync.set(exchangeID, request)
      signal?.addEventListener("abort", request.cancel, { once: true })
      send(frame)
    }) as Promise<T extends "state" ? Sync.Share : T extends "batch" ? Sync.Ack : Sync.BatchReceipt>
  }
  function uploadBlob(
    input: {
      sessionID: string
      shareGeneration: number
      hash: string
      offset: number
      totalBytes: number
      bytes: Uint8Array
    },
    signal?: AbortSignal,
  ): Promise<Sync.BlobStatus> {
    if (!connected || !options.sync)
      return Promise.reject(failure("PROTOCOL_MISMATCH", "Shared Session sync is not enabled"))
    if (signal?.aborted) return Promise.reject(failure("RUNTIME_OFFLINE", "Blob upload was cancelled"))
    const bytes = Buffer.from(input.bytes)
    if (
      !Number.isSafeInteger(input.totalBytes) ||
      input.totalBytes < 0 ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset % (4 * 1024 * 1024) !== 0 ||
      bytes.byteLength !== Math.min(4 * 1024 * 1024, input.totalBytes - input.offset) ||
      (!bytes.byteLength && (input.totalBytes !== 0 || input.offset !== 0))
    )
      return Promise.reject(failure("INVALID_REQUEST", "Blob upload must cover its complete declared aligned range"))
    const fragmentBytes = 45_000
    const total = Math.max(1, Math.ceil(bytes.byteLength / fragmentBytes))
    if (total > 128) return Promise.reject(failure("INVALID_REQUEST", "Blob upload has too many transport fragments"))
    const exchangeID = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const request = pendingBlobs.get(exchangeID)
          if (!request) return
          pendingBlobs.delete(exchangeID)
          signal?.removeEventListener("abort", request.cancel!)
          reject(failure("SERVICE_UNAVAILABLE", "Blob upload acknowledgement was not observed"))
        },
        Math.min(30_000, Math.max(1, connected!.offlineMs)),
      )
      timer.unref()
      const request = {
        resolve,
        reject,
        timer,
        signal,
        cancel: () => {
          if (!pendingBlobs.delete(exchangeID)) return
          clearTimeout(timer)
          reject(failure("RUNTIME_OFFLINE", "Blob upload was cancelled"))
        },
      }
      pendingBlobs.set(exchangeID, request)
      signal?.addEventListener("abort", request.cancel, { once: true })
      void (async () => {
        for (let index = 0; index < total; index++) {
          while (!stopped && socket.bufferedAmount > syncFrameLimit - frameLimit) await Bun.sleep(1)
          if (stopped) return
          const part = bytes.subarray(index * fragmentBytes, Math.min(bytes.byteLength, (index + 1) * fragmentBytes))
          send(
            Protocol.BlobChunk.parse({
              type: "blob-chunk",
              connectionEpoch: epoch,
              exchangeID,
              sessionID: input.sessionID,
              shareGeneration: input.shareGeneration,
              hash: input.hash,
              offset: input.offset,
              totalBytes: input.totalBytes,
              index,
              total,
              data: part.toString("base64url"),
            }),
          )
        }
      })()
    })
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
    if (typeof raw !== "string" || Buffer.byteLength(raw) > syncFrameLimit)
      return reject(failure("PROTOCOL_MISMATCH", "Unsupported Runtime bridge frame"))
    const size = Buffer.byteLength(raw)
    queuedFrames++
    queuedBytes += size
    if (queuedFrames > 16 || queuedBytes > syncFrameLimit * 4)
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
      await drain()
    }
    return {
      signal: work.signal,
      connected: handshake,
      resources: resources!.resources,
      notify(notice) {
        if (work.signal.aborted || handshake.notifications !== Notification.Version) return
        send({ type: "notification", connectionEpoch: epoch, notice: Notification.Observation.parse(notice) })
      },
      closed: closed.promise.then(async (result) => {
        await drain()
        return result
      }),
      close,
      syncState(sessionID: string, signal?: AbortSignal) {
        return syncRequest(
          "state",
          {
            type: "sync-state",
            connectionEpoch: epoch,
            exchangeID: crypto.randomUUID(),
            sessionID,
          },
          signal,
        )
      },
      async observeSync(sessionID: string, input: Sync.StateObservation, signal?: AbortSignal) {
        const observation = Sync.StateObservation.parse(input)
        if (options.syncVersion !== Sync.observationVersion || handshake.syncVersion !== Sync.observationVersion)
          throw failure("PROTOCOL_MISMATCH", "Runtime sync storage observations were not negotiated")
        if (stopped || work.signal.aborted) throw failure("RUNTIME_OFFLINE", "Runtime connection closed")
        if (signal?.aborted) throw failure("RUNTIME_OFFLINE", "Sync request was cancelled")
        const share = await syncRequest(
          "state",
          { type: "sync-state", connectionEpoch: epoch, exchangeID: crypto.randomUUID(), sessionID, observation },
          signal,
        )
        if (stopped || work.signal.aborted) throw failure("RUNTIME_OFFLINE", "Runtime connection closed")
        if (signal?.aborted) throw failure("RUNTIME_OFFLINE", "Sync request was cancelled")
        if (
          share.sessionID !== sessionID ||
          share.shareState !== "shared" ||
          share.bindingEpoch !== observation.bindingEpoch ||
          share.shareGeneration !== observation.shareGeneration ||
          share.nextSeq !== observation.nextSeq ||
          share.syncState !== observation.state
        )
          throw failure(
            "PROTOCOL_MISMATCH",
            "Runtime sync storage observation response changed its original checkpoint",
          )
        return share
      },
      async syncBatchReceipt(input: Sync.BatchReceiptQuery, signal?: AbortSignal) {
        const query = Sync.BatchReceiptQuery.parse(input)
        if (options.syncVersion !== Sync.observationVersion || handshake.syncVersion !== Sync.observationVersion)
          throw failure("PROTOCOL_MISMATCH", "Runtime exact batch receipts were not negotiated")
        if (stopped || work.signal.aborted) throw failure("RUNTIME_OFFLINE", "Runtime connection closed")
        if (signal?.aborted) throw failure("RUNTIME_OFFLINE", "Sync request was cancelled")
        const receipt = await syncRequest(
          "receipt",
          { type: "sync-batch-receipt", connectionEpoch: epoch, exchangeID: crypto.randomUUID(), query },
          signal,
        )
        if (stopped || work.signal.aborted) throw failure("RUNTIME_OFFLINE", "Runtime connection closed")
        if (signal?.aborted) throw failure("RUNTIME_OFFLINE", "Sync request was cancelled")
        if (JSON.stringify(Sync.BatchIdentity.parse(receipt.batch)) !== JSON.stringify(query.batch))
          throw failure("PROTOCOL_MISMATCH", "Runtime exact batch receipt changed its original immutable identity")
        return receipt
      },
      sync(batch: Sync.Batch, signal?: AbortSignal) {
        return syncRequest(
          "batch",
          {
            type: "sync-batch",
            connectionEpoch: epoch,
            exchangeID: crypto.randomUUID(),
            batch: Sync.Batch.parse(batch),
          },
          signal,
        )
      },
      uploadBlob,
      [Symbol.asyncDispose]: close,
    }
  } catch (error) {
    stop({ kind: "rejected" })
    await drain()
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
  const member = await readRuntimeHome(options.home, options.identity)
  const registration = await readRuntimeRegistration(member.home, member.identity)
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
