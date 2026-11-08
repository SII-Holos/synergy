import type { ServerWebSocket, WebSocketHandler } from "bun"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { fail, OrganizationError } from "./error"

export const RuntimeConnectionSettings = z
  .strictObject({
    authenticateMs: z.number().int().positive().default(5_000),
    heartbeatMs: z.number().int().positive().default(10_000),
    offlineMs: z.number().int().positive().default(30_000),
    proofAgeMs: z.number().int().positive().default(30_000),
  })
  .refine((value) => value.offlineMs > value.heartbeatMs, "The offline interval must exceed the heartbeat interval")
export type RuntimeConnectionSettings = z.input<typeof RuntimeConnectionSettings>

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
  settings?: RuntimeConnectionSettings
}) {
  const settings = RuntimeConnectionSettings.parse(input.settings ?? {})
  const sockets = new Set<Socket>()
  const active = new Map<string, Socket>()
  let closed = false

  function remove(socket: Socket) {
    socket.data.closed = true
    clearTimeout(socket.data.timer)
    sockets.delete(socket)
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
    if (socket.getBufferedAmount() > frameLimit || socket.send(JSON.stringify(frame)) === 0) {
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
  async function authenticate(socket: Socket, frame: Runtime.Connect) {
    const handshake = frame.proof.handshake
    await Storage.transaction(
      async () => {
        live(socket)
        const deployment = Protocol.Deployment.parse(await Storage.read(Keys.deployment()))
        const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(handshake.runtimeID))
        if (
          !runtime ||
          handshake.runtimeKind !== "member" ||
          handshake.orgID !== deployment.orgID ||
          handshake.deploymentIncarnation !== deployment.deploymentIncarnation ||
          runtime.orgID !== deployment.orgID ||
          runtime.deploymentIncarnation !== deployment.deploymentIncarnation ||
          handshake.accountID !== runtime.accountID ||
          handshake.deviceID !== runtime.deviceID ||
          Math.abs(Date.now() - frame.proof.issuedAt) > settings.proofAgeMs ||
          !(await Runtime.verify(frame.proof, frame.signature, runtime.publicKey))
        )
          fail("AUTHENTICATION_REQUIRED", "Invalid Runtime connection proof")
        const member = await Record.read(Record.Account, Keys.account(runtime.accountID))
        if (runtime.state !== "active" || !member || member.state !== "active" || member.orgID !== runtime.orgID)
          fail("PERMISSION_DENIED", "Runtime registration is not active")
        if (handshake.schemas.bridge !== 1 || !handshake.capabilities.includes("bridge"))
          fail("PROTOCOL_MISMATCH", "This Runtime does not support the organization bridge protocol")
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
      heartbeatMs: settings.heartbeatMs,
      offlineMs: settings.offlineMs,
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
          !member ||
          member.state !== "active" ||
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
    maxPayloadLength: frameLimit,
    backpressureLimit: frameLimit * 2,
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
      if (++socket.data.frames > 16 || (socket.data.bytes += size) > frameLimit * 4)
        return close(socket, 1013, "Runtime receive window is full")
      socket.data.pending = socket.data.pending
        .then(() => {
          if (socket.data.closed) return
          return input.run(() => receive(socket, message))
        })
        .catch((error: unknown) => reject(socket, error))
        .finally(() => {
          socket.data.frames--
          socket.data.bytes -= size
        })
    },
  }
  return {
    websocket,
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
        const member = await Record.read(Record.Account, Keys.account(runtime.accountID))
        const socket = active.get(runtimeID)
        const online =
          runtime.state === "active" &&
          member?.state === "active" &&
          socket &&
          !socket.data.closed &&
          socket.data.deadline > Date.now() &&
          socket.data.handshake?.connectionEpoch === runtime.connectionEpoch
        return Runtime.ConnectionStatus.parse({
          runtimeID,
          state: online ? "online" : "offline",
          connectionEpoch: runtime.connectionEpoch,
          lastSeen: runtime.lastSeen,
        })
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
