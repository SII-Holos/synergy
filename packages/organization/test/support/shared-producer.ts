import {
  OrganizationProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationError } from "../../src/error"
import { createRuntimeConnections } from "../../src/runtime-connection"
import { OrganizationSharing as Sharing } from "../../src/sharing"
import { initializeSigningIdentity, loadSigningAuthority } from "../../src/signing"
import { OrganizationServiceMaintenance as Admission } from "../../src/service-maintenance"
import { OrganizationRecord as Record } from "../../src/storage/records"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { connection, keys } from "./runtime"
import { directoryFixture } from "./session-directory"

function receive(socket: WebSocket) {
  return new Promise<Runtime.ServerFrame>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Shared producer did not reply")), 2_000)
    const message = (event: MessageEvent) => {
      try {
        const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
        finish(frame.type === "error" ? new OrganizationError(frame.error) : undefined, frame)
      } catch (error) {
        finish(error)
      }
    }
    const close = () => finish(new Error("Shared producer closed before its reply"))
    function finish(error?: unknown, frame?: Runtime.ServerFrame) {
      clearTimeout(timer)
      socket.removeEventListener("message", message)
      socket.removeEventListener("close", close)
      if (error) reject(error)
      else resolve(frame!)
    }
    socket.addEventListener("message", message)
    socket.addEventListener("close", close)
  })
}

export async function sharedProducerFixture(maintained = false) {
  const f = await directoryFixture()
  const key = await keys()
  const signing = await f.run(async () => {
    await initializeSigningIdentity()
    const deployment = Protocol.Deployment.parse(await Storage.read(Keys.deployment()))
    const registration = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-alice")))!
    await Storage.write(Keys.runtime(registration.runtimeID), { ...registration, publicKey: key.publicKey })
    return loadSigningAuthority(deployment)
  })
  const connections = createRuntimeConnections({
    run: async (body) => f.run(() => (maintained ? Admission.run(body) : body())),
    signingIdentity: signing.identity,
    onSyncBatch: (lease, batch) => Sharing.applyBatchFromRuntime(lease.handshake, batch),
  })
  const sockets = new Set<WebSocket>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: connections.websocket,
    fetch(request, server) {
      if (server.upgrade(request, { data: connections.socket() })) return
      return new Response(null, { status: 404 })
    },
  })
  return {
    ...f,
    async sync(batch: Sync.Batch) {
      const frame = await f.run(async () => {
        const { schemaVersion: _, ...registration } = (await Record.read(
          Record.RuntimeRegistration,
          Keys.runtime("runtime-alice"),
        ))!
        const value = await connection(registration, key.privateKey, registration.connectionEpoch + 1)
        value.proof.handshake.capabilities.push("sync")
        value.proof.handshake.schemas.sync = 1
        value.signature = await Runtime.sign(value.proof, key.privateKey)
        return value
      })
      const socket = new WebSocket(server.url.toString().replace(/^http/, "ws"))
      sockets.add(socket)
      try {
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve()
          socket.onerror = reject
        })
        const connected = receive(socket)
        socket.send(JSON.stringify(frame))
        Runtime.Connected.parse(await connected)
        const pending = receive(socket)
        socket.send(
          JSON.stringify(
            Runtime.SyncBatch.parse({
              type: "sync-batch",
              connectionEpoch: frame.proof.handshake.connectionEpoch,
              exchangeID: crypto.randomUUID(),
              batch,
            }),
          ),
        )
        const result = await pending
        if (result.type !== "sync-ack") throw new Error("Expected a shared producer acknowledgement")
        return result.ack
      } finally {
        socket.close()
        sockets.delete(socket)
      }
    },
    async [Symbol.asyncDispose]() {
      connections.close()
      for (const socket of sockets) socket.close()
      await server.stop(true)
      await f[Symbol.asyncDispose]()
    },
  }
}
