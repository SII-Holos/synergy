import { RuntimeConnectionSettings } from "./config-schema"
import type { ServerWebSocket, WebSocketHandler } from "bun"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationCommandProtocol as Command,
  OrganizationSyncProtocol as Sync,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { fail, OrganizationError } from "./error"
import type { OrganizationServiceMaintenance } from "./service-maintenance"
import { createCommandTransport, type RuntimeConnectionLease } from "./command-transport"
export type { RuntimeConnectionLease } from "./command-transport"

export interface RuntimeSocket {
  closed: boolean
  pending: Promise<void>
  frames: number
  bytes: number
  deadline: number
  timer?: ReturnType<typeof setTimeout>
  handshake?: Protocol.Handshake
}
type Socket = ServerWebSocket<RuntimeSocket>
const frameLimit = 64 * 1024
const syncFrameLimit = 1024 * 1024

function stale(epoch: number): never {
  throw new OrganizationError({
    code: "STALE_CONNECTION",
    message: "Reconnect using the next connection epoch",
    currentConnectionEpoch: epoch,
    retryable: false,
    outcome: "not_dispatched",
  })
}

export function createRuntimeConnections(input: {
  run: <T>(body: () => T | Promise<T>) => Promise<T>
  captureTail?(): OrganizationServiceMaintenance.Tail
  signingIdentity: Command.SigningIdentity
  settings?: RuntimeConnectionSettings
  onResult?: (connection: RuntimeConnectionLease, result: Command.Result) => Promise<unknown>
  onSyncState?: (connection: RuntimeConnectionLease, sessionID: string) => Promise<Sync.Share>
  onSyncBatch?: (connection: RuntimeConnectionLease, batch: Sync.Batch) => Promise<Sync.Ack>
  onNotification?: (connection: RuntimeConnectionLease, notice: Notification.Observation) => Promise<void>
  onBlobChunk?: (
    connection: RuntimeConnectionLease,
    input: {
      sessionID: string
      shareGeneration: number
      hash: string
      offset: number
      totalBytes: number
      bytes: Uint8Array
    },
  ) => Promise<Sync.BlobStatus>
}) {
  const settings = RuntimeConnectionSettings.parse(input.settings ?? {})
  const sockets = new Set<Socket>()
  const active = new Map<string, Socket>()
  const transports = new WeakMap<Socket, ReturnType<typeof createCommandTransport>>()
  const blobTransfers = new WeakMap<
    Socket,
    Map<string, { frame: Runtime.BlobChunk; next: number; bytes: number; parts: Buffer[] }>
  >()
  let closed = false

  function remove(socket: Socket) {
    socket.data.closed = true
    clearTimeout(socket.data.timer)
    sockets.delete(socket)
    transports.get(socket)?.close()
    blobTransfers.get(socket)?.clear()
    const id = socket.data.handshake?.runtimeID
    if (id && active.get(id) === socket) active.delete(id)
  }
  function close(socket: Socket, code: number, reason: string) {
    remove(socket)
    socket.close(code, reason)
  }
  function live(socket: Socket) {
    if (closed || socket.data.closed || socket.readyState !== 1 || socket.data.deadline <= Date.now())
      fail("RUNTIME_OFFLINE", "Runtime connection is no longer available")
  }
  function lease(socket: Socket, duration: number) {
    clearTimeout(socket.data.timer)
    socket.data.deadline = Date.now() + duration
    socket.data.timer = setTimeout(() => close(socket, 4008, "Runtime connection timed out"), duration)
    socket.data.timer.unref()
  }
  function send(socket: Socket, frame: Runtime.ServerFrame) {
    live(socket)
    const encoded = JSON.stringify(frame)
    const limit = frame.type === "sync-state" || frame.type === "sync-ack" ? syncFrameLimit : frameLimit
    if (Buffer.byteLength(encoded) > limit || socket.getBufferedAmount() > limit || socket.send(encoded) === 0) {
      close(socket, 1013, "Runtime connection is not receiving frames")
      fail("RUNTIME_OFFLINE", "Runtime connection is not receiving frames")
    }
  }
  function reject(socket: Socket, error: unknown) {
    if (socket.data.closed) return
    const data =
      error instanceof OrganizationError
        ? error.data
        : {
            code: "SERVICE_UNAVAILABLE" as const,
            message: "Runtime connection failed",
            outcome: "unknown" as const,
            retryable: false,
          }
    try {
      send(socket, { type: "error", error: data })
    } catch {}
    close(socket, data.code === "STALE_CONNECTION" ? 4001 : 4003, "Runtime connection rejected")
  }
  function current(socket: Socket) {
    live(socket)
    const handshake = socket.data.handshake
    if (!handshake || active.get(handshake.runtimeID) !== socket)
      fail("AUTHENTICATION_REQUIRED", "Authenticate the Runtime connection first")
    return handshake
  }
  function captureSocket(
    socket: Socket,
    requireCommands: boolean | "handoffs" | "notifications" = true,
  ): RuntimeConnectionLease {
    const handshake = structuredClone(current(socket))
    if (requireCommands === true && (!handshake.capabilities.includes("commands") || handshake.schemas.commands !== 1))
      fail("PROTOCOL_MISMATCH", "Runtime does not support organization command intake")
    if (requireCommands === false && (!handshake.capabilities.includes("sync") || handshake.schemas.sync !== 1))
      fail("PROTOCOL_MISMATCH", "Runtime does not support shared Session sync")
    if (
      requireCommands === "notifications" &&
      (!handshake.capabilities.includes("notifications") || handshake.schemas.notifications !== Notification.Version)
    )
      fail("PROTOCOL_MISMATCH", "Runtime does not support live work notifications")
    if (
      requireCommands === "handoffs" &&
      (!handshake.capabilities.includes("handoffs") ||
        ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(handshake.schemas.handoffs))
    )
      fail("PROTOCOL_MISMATCH", "Runtime does not support the native handoff reader contract")
    Object.freeze(handshake.capabilities)
    Object.freeze(handshake.schemas)
    Object.freeze(handshake)
    let transport = transports.get(socket)
    if (!transport) {
      transport = createCommandTransport({
        current: () => current(socket),
        buffered: () => socket.getBufferedAmount(),
        send: (frame) => socket.send(JSON.stringify(frame)),
        captureTail: input.captureTail,
      })
      transports.set(socket, transport)
    }
    return Object.freeze({
      handshake,
      assertCurrent() {
        const value = current(socket)
        if (value.connectionEpoch !== handshake.connectionEpoch) stale(value.connectionEpoch)
      },
      exchange: transport.exchange,
    })
  }
  async function authenticate(socket: Socket, frame: Runtime.Connect) {
    const handshake = frame.proof.handshake
    await Storage.transaction(
      async () => {
        live(socket)
        const deployment = Protocol.Deployment.parse(await Storage.read(Keys.deployment()))
        if (
          input.signingIdentity.orgID !== deployment.orgID ||
          input.signingIdentity.deploymentIncarnation !== deployment.deploymentIncarnation
        )
          fail("SERVICE_UNAVAILABLE", "The organization signing authority changed")
        const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(handshake.runtimeID))
        if (
          !runtime ||
          handshake.runtimeKind !== runtime.runtimeKind ||
          handshake.orgID !== deployment.orgID ||
          handshake.deploymentIncarnation !== deployment.deploymentIncarnation ||
          runtime.orgID !== deployment.orgID ||
          runtime.deploymentIncarnation !== deployment.deploymentIncarnation ||
          (handshake.runtimeKind === "member" &&
            runtime.runtimeKind === "member" &&
            (handshake.accountID !== runtime.accountID || handshake.deviceID !== runtime.deviceID)) ||
          Math.abs(Date.now() - frame.proof.issuedAt) > settings.proofAgeMs ||
          !(await Runtime.verify(frame.proof, frame.signature, runtime.publicKey))
        )
          fail("AUTHENTICATION_REQUIRED", "Invalid Runtime connection proof")
        const member =
          runtime.runtimeKind === "member"
            ? await Record.read(Record.Account, Keys.account(runtime.accountID))
            : undefined
        if (
          runtime.state !== "active" ||
          (runtime.runtimeKind === "member" && (!member || member.state !== "active" || member.orgID !== runtime.orgID))
        )
          fail("PERMISSION_DENIED", "Runtime registration is not active")
        if (handshake.schemas.bridge !== 1 || !handshake.capabilities.includes("bridge"))
          fail("PROTOCOL_MISMATCH", "This Runtime does not support the organization bridge protocol")
        if (handshake.capabilities.includes("sync") !== (handshake.schemas.sync === 1))
          fail("PROTOCOL_MISMATCH", "Runtime sync capabilities and schema are inconsistent")
        if (
          handshake.capabilities.includes("notifications") !==
          (handshake.schemas.notifications === Notification.Version)
        )
          fail("PROTOCOL_MISMATCH", "Runtime notification capabilities and schema are inconsistent")
        if (handshake.connectionEpoch !== runtime.connectionEpoch + 1) stale(runtime.connectionEpoch)
        const now = Date.now()
        await Storage.write(Keys.runtime(runtime.runtimeID), {
          ...runtime,
          connectionEpoch: handshake.connectionEpoch,
          lastSeen: now,
        })
        await Storage.write(
          Keys.runtimeConnection(runtime.runtimeID),
          Record.RuntimeConnection.parse({ schemaVersion: 1, handshake, connectedAt: now, lastSeen: now }),
        )
        Storage.afterCommit(() => {
          if (closed || socket.data.closed || socket.data.deadline <= Date.now()) return
          const previous = active.get(runtime.runtimeID)
          if (previous && previous.data.handshake!.connectionEpoch >= handshake.connectionEpoch)
            return reject(
              socket,
              new OrganizationError({
                code: "STALE_CONNECTION",
                message: "Runtime connection was replaced",
                currentConnectionEpoch: previous.data.handshake!.connectionEpoch,
                outcome: "not_dispatched",
                retryable: false,
              }),
            )
          if (previous) close(previous, 4001, "Runtime connection replaced")
          socket.data.handshake = handshake
          active.set(runtime.runtimeID, socket)
          lease(socket, settings.offlineMs)
        })
      },
      {
        commitGuard: () => {
          live(socket)
          if (Math.abs(Date.now() - frame.proof.issuedAt) > settings.proofAgeMs)
            fail("AUTHENTICATION_REQUIRED", "Runtime connection proof expired")
        },
      },
    )
    current(socket)
    send(socket, {
      type: "handshake",
      protocolVersion: Protocol.version,
      orgID: handshake.orgID,
      deploymentIncarnation: handshake.deploymentIncarnation,
      runtimeID: handshake.runtimeID,
      connectionEpoch: handshake.connectionEpoch,
      signingIdentity: input.signingIdentity,
      heartbeatMs: settings.heartbeatMs,
      offlineMs: settings.offlineMs,
      ...(input.onNotification &&
      handshake.capabilities.includes("notifications") &&
      handshake.schemas.notifications === Notification.Version
        ? { notifications: Notification.Version }
        : {}),
    })
  }
  async function receive(socket: Socket, message: string) {
    live(socket)
    let raw: unknown
    try {
      raw = JSON.parse(message)
    } catch {
      fail("INVALID_REQUEST", "Invalid Runtime frame")
    }
    const frame = Runtime.ClientFrame.safeParse(raw)
    if (!frame.success) fail("PROTOCOL_MISMATCH", "Unsupported Runtime frame or protocol version")
    if (!socket.data.handshake) {
      if (frame.data.type !== "handshake") fail("AUTHENTICATION_REQUIRED", "Authenticate the Runtime connection first")
      return authenticate(socket, frame.data)
    }
    if (frame.data.type === "notification") {
      const connection = captureSocket(socket, "notifications")
      if (frame.data.connectionEpoch !== connection.handshake.connectionEpoch)
        stale(connection.handshake.connectionEpoch)
      if (!input.onNotification) fail("SERVICE_UNAVAILABLE", "Notifications are unavailable")
      await input.onNotification(connection, frame.data.notice)
      connection.assertCurrent()
      return
    }
    if (frame.data.type === "receipt") {
      const connection = captureSocket(
        socket,
        frame.data.reply.kind === "handoff" || frame.data.reply.kind === "handoff-inspection" ? "handoffs" : true,
      )
      if (frame.data.connectionEpoch !== connection.handshake.connectionEpoch)
        stale(connection.handshake.connectionEpoch)
      const transport = transports.get(socket)!
      transport.validate(frame.data.exchangeID, frame.data.reply)
      const reply = frame.data.reply
      const result = reply.kind === "result" ? reply.result : reply.kind === "query" ? reply.query.result : undefined
      if (result) await input.onResult?.(connection, result)
      connection.assertCurrent()
      transport.resolve(frame.data.exchangeID, reply)
      return
    }
    if (frame.data.type === "sync-state") {
      const connection = captureSocket(socket, false)
      if (frame.data.connectionEpoch !== connection.handshake.connectionEpoch)
        stale(connection.handshake.connectionEpoch)
      if (!input.onSyncState) fail("SERVICE_UNAVAILABLE", "Shared Session sync is unavailable")
      const share = await input.onSyncState(connection, frame.data.sessionID)
      connection.assertCurrent()
      send(socket, {
        type: "sync-state",
        connectionEpoch: connection.handshake.connectionEpoch,
        exchangeID: frame.data.exchangeID,
        share: Sync.Share.parse(share),
      })
      return
    }
    if (frame.data.type === "sync-batch") {
      const connection = captureSocket(socket, false)
      if (frame.data.connectionEpoch !== connection.handshake.connectionEpoch)
        stale(connection.handshake.connectionEpoch)
      if (!input.onSyncBatch) fail("SERVICE_UNAVAILABLE", "Shared Session sync is unavailable")
      const ack = await input.onSyncBatch(connection, frame.data.batch)
      connection.assertCurrent()
      send(socket, {
        type: "sync-ack",
        connectionEpoch: connection.handshake.connectionEpoch,
        exchangeID: frame.data.exchangeID,
        ack: Sync.Ack.parse(ack),
      })
      return
    }
    if (frame.data.type === "blob-chunk") {
      const connection = captureSocket(socket, false)
      if (frame.data.connectionEpoch !== connection.handshake.connectionEpoch)
        stale(connection.handshake.connectionEpoch)
      lease(socket, settings.offlineMs)
      if (!input.onBlobChunk) fail("SERVICE_UNAVAILABLE", "Shared Session blobs are unavailable")
      if (frame.data.index >= frame.data.total) fail("PROTOCOL_MISMATCH", "Blob chunk index is out of range")
      const encoded = Buffer.from(frame.data.data, "base64url")
      if (encoded.toString("base64url") !== frame.data.data || (!encoded.length && frame.data.totalBytes !== 0))
        fail("PROTOCOL_MISMATCH", "Blob chunk encoding is invalid")
      const transfers = blobTransfers.get(socket) ?? new Map()
      blobTransfers.set(socket, transfers)
      let transfer = transfers.get(frame.data.exchangeID)
      if (!transfer) {
        if (frame.data.index !== 0) fail("PROTOCOL_MISMATCH", "Blob chunks must start at index zero")
        transfer = { frame: frame.data, next: 0, bytes: 0, parts: [] }
        transfers.set(frame.data.exchangeID, transfer)
      }
      if (
        transfer.frame.sessionID !== frame.data.sessionID ||
        transfer.frame.shareGeneration !== frame.data.shareGeneration ||
        transfer.frame.hash !== frame.data.hash ||
        transfer.frame.offset !== frame.data.offset ||
        transfer.frame.totalBytes !== frame.data.totalBytes ||
        transfer.frame.total !== frame.data.total ||
        transfer.next !== frame.data.index
      )
        fail("PROTOCOL_MISMATCH", "Blob chunks are not contiguous")
      transfer.parts.push(encoded)
      transfer.bytes += encoded.byteLength
      if (transfer.bytes > 4 * 1024 * 1024) fail("SERVICE_UNAVAILABLE", "Blob chunk buffer is full")
      transfer.next++
      if (transfer.next !== transfer.frame.total) return
      transfers.delete(frame.data.exchangeID)
      const status = await input.onBlobChunk(connection, {
        sessionID: transfer.frame.sessionID,
        shareGeneration: transfer.frame.shareGeneration,
        hash: transfer.frame.hash,
        offset: transfer.frame.offset,
        totalBytes: transfer.frame.totalBytes,
        bytes: Buffer.concat(transfer.parts),
      })
      connection.assertCurrent()
      send(socket, {
        type: "blob-ack",
        connectionEpoch: connection.handshake.connectionEpoch,
        exchangeID: frame.data.exchangeID,
        status: Sync.BlobStatus.parse(status),
      })
      return
    }
    if (frame.data.type !== "heartbeat") fail("INVALID_REQUEST", "Runtime connection is already authenticated")
    const heartbeat = frame.data
    const handshake = current(socket)
    if (heartbeat.connectionEpoch !== handshake.connectionEpoch) stale(handshake.connectionEpoch)
    await Storage.transaction(
      async () => {
        current(socket)
        const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(handshake.runtimeID))
        const member =
          handshake.runtimeKind === "member"
            ? await Record.read(Record.Account, Keys.account(handshake.accountID))
            : undefined
        const deployment = Protocol.Deployment.parse(await Storage.read(Keys.deployment()))
        if (
          !runtime ||
          runtime.state !== "active" ||
          (handshake.runtimeKind === "member" && (!member || member.state !== "active")) ||
          deployment.orgID !== handshake.orgID ||
          deployment.deploymentIncarnation !== handshake.deploymentIncarnation
        )
          fail("PERMISSION_DENIED", "Runtime registration is not active")
        if (runtime.connectionEpoch !== handshake.connectionEpoch) stale(runtime.connectionEpoch)
        const connection = await Record.read(Record.RuntimeConnection, Keys.runtimeConnection(runtime.runtimeID))
        if (!connection || connection.handshake.connectionEpoch !== handshake.connectionEpoch)
          stale(runtime.connectionEpoch)
        const now = Date.now()
        await Storage.write(Keys.runtime(runtime.runtimeID), { ...runtime, lastSeen: now })
        await Storage.write(Keys.runtimeConnection(runtime.runtimeID), { ...connection, lastSeen: now })
      },
      {
        commitGuard: () => {
          current(socket)
        },
      },
    )
    current(socket)
    lease(socket, settings.offlineMs)
    send(socket, heartbeat)
  }
  const websocket: WebSocketHandler<RuntimeSocket> = {
    maxPayloadLength: syncFrameLimit,
    backpressureLimit: syncFrameLimit * 2,
    closeOnBackpressureLimit: true,
    idleTimeout: 0,
    open(socket) {
      if (closed) return close(socket, 1001, "Organization service closed")
      sockets.add(socket)
      lease(socket, settings.authenticateMs)
    },
    close(socket) {
      remove(socket)
    },
    message(socket, message) {
      if (socket.data.closed) return
      if (typeof message !== "string")
        return reject(
          socket,
          new OrganizationError({
            code: "INVALID_REQUEST",
            message: "Expected a JSON Runtime frame",
            outcome: "not_dispatched",
            retryable: false,
          }),
        )
      const size = Buffer.byteLength(message)
      if (++socket.data.frames > 16 || (socket.data.bytes += size) > syncFrameLimit * 4)
        return close(socket, 1013, "Runtime receive window is full")
      const prior = socket.data.pending
      const body = async () => {
        await prior
        if (!socket.data.closed) await receive(socket, message)
      }
      let retained: Promise<void> | undefined
      let raw: unknown
      try {
        raw = JSON.parse(message)
      } catch {}
      const frame = Runtime.ClientFrame.safeParse(raw)
      try {
        if (frame.success && frame.data.type === "receipt")
          retained = transports.get(socket)?.resume(frame.data.exchangeID, frame.data.reply, body)
      } catch (error) {
        return reject(socket, error)
      }
      socket.data.pending = (retained ?? input.run(body))
        .catch((error: unknown) => reject(socket, error))
        .finally(() => {
          socket.data.frames--
          socket.data.bytes -= size
        })
    },
  }
  async function availability(runtime: Record.RuntimeRegistration) {
    const member =
      runtime.runtimeKind === "member" ? await Record.read(Record.Account, Keys.account(runtime.accountID)) : undefined
    const socket = active.get(runtime.runtimeID)
    const online =
      !closed &&
      runtime.state === "active" &&
      (runtime.runtimeKind === "hosted" || member?.state === "active") &&
      socket &&
      socket.readyState === 1 &&
      !socket.data.closed &&
      socket.data.deadline > Date.now() &&
      socket.data.handshake?.connectionEpoch === runtime.connectionEpoch
    return Runtime.ConnectionStatus.parse({
      runtimeID: runtime.runtimeID,
      state: online ? "online" : "offline",
      connectionEpoch: runtime.connectionEpoch,
      lastSeen: runtime.lastSeen,
    })
  }

  return {
    websocket,
    async availability(runtimeID: string) {
      const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(runtimeID))
      if (!runtime) fail("NOT_FOUND", "Runtime not found")
      return availability(runtime)
    },
    capture(runtimeID: string) {
      const socket = active.get(runtimeID)
      if (!socket) fail("RUNTIME_OFFLINE", "Runtime is not connected")
      return captureSocket(socket)
    },
    captureHandoff(runtimeID: string) {
      const socket = active.get(runtimeID)
      if (!socket) fail("RUNTIME_OFFLINE", "Runtime is not connected")
      return captureSocket(socket, "handoffs")
    },
    socket(): RuntimeSocket {
      if (closed) fail("SERVICE_UNAVAILABLE", "Organization service is closed")
      return {
        closed: false,
        pending: Promise.resolve(),
        frames: 0,
        bytes: 0,
        deadline: Date.now() + settings.authenticateMs,
      }
    },
    async status(credentials: Credentials, runtimeID: string) {
      return Storage.snapshot(async () => {
        const { runtime } = await authorize(credentials, "runtime.read", { runtimeID })
        return availability(runtime)
      })
    },
    revoke(runtimeID: string) {
      const socket = active.get(runtimeID)
      if (socket) close(socket, 4003, "Runtime registration revoked")
    },
    removeAccount(accountID: string) {
      for (const socket of active.values()) {
        const handshake = socket.data.handshake
        if (handshake?.runtimeKind === "member" && handshake.accountID === accountID)
          close(socket, 4003, "Organization account removed")
      }
    },
    close() {
      closed = true
      for (const socket of sockets) close(socket, 1001, "Organization service closed")
    },
  }
}
export type RuntimeConnections = ReturnType<typeof createRuntimeConnections>
