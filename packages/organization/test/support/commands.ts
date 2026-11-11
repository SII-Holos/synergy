import { expect } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { directoryFixture } from "./session-directory"
import { connection, keys } from "./runtime"
import { createRuntimeConnections } from "../../src/runtime-connection"
import { initializeSigningIdentity, loadSigningAuthority } from "../../src/signing"
import { OrganizationStoragePath as Paths } from "../../src/storage/path"
import { OrganizationRecord as Record } from "../../src/storage/records"
import { OrganizationSessionDirectory } from "../../src/session-directory"
import { createCommandAdmissions } from "../../src/command-admission"
import { createCommandForwarder } from "../../src/command-forwarding"
import { createExecutionGrants } from "../../src/execution-grants"
import { organizationApp } from "../../src/http"
import { createGatewayCalls } from "../../src/gateway-calls"
import { createConnectionGateway, createModelGateway } from "../../src/gateway"

export async function commandFixture(options: { timeoutMs?: number } = {}) {
  const f = await directoryFixture()
  const key = await keys()
  const deployment = { schemaVersion: 1 as const, orgID: "org", deploymentIncarnation: "deployment", createdAt: 1 }
  const signing = await f.run(async () => {
    await Storage.write(Paths.deployment(), deployment)
    await initializeSigningIdentity()
    const record = (await Record.read(Record.RuntimeRegistration, Paths.runtime("runtime-alice")))!
    await Storage.write(Paths.runtime(record.runtimeID), { ...record, publicKey: key.publicKey, connectionEpoch: 0 })
    return loadSigningAuthority(deployment)
  })
  const connections = createRuntimeConnections({
    run: async (body) => f.run(body),
    signingIdentity: signing.identity,
    onResult: (lease, result) => commands.observe(lease, result),
  })
  const commands = createCommandAdmissions({ connections, signing })
  const forwarder = createCommandForwarder({ admissions: commands, connections, timeoutMs: options.timeoutMs })
  const gatewayCalls = createGatewayCalls({ connections, signing })
  const gateway = {
    calls: gatewayCalls,
    models: createModelGateway({ calls: gatewayCalls, run: async (body) => f.run(body) }),
    connections: createConnectionGateway({ calls: gatewayCalls, run: async (body) => f.run(body) }),
  }
  const execution = createExecutionGrants({
    admissions: commands,
    connections,
    assertResourcesDrained(grantID: string) {
      gateway.models.assertDrained(grantID)
      gateway.connections.assertDrained(grantID)
    },
  })
  const app = organizationApp(
    () => true,
    undefined,
    "https://organization.example",
    undefined,
    connections,
    undefined,
    forwarder,
    execution,
    gateway,
  )
  let wire: Parameters<NonNullable<typeof connections.websocket.open>>[0] | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      ...connections.websocket,
      open(socket) {
        wire = socket
        connections.websocket.open?.(socket)
      },
    },
    fetch(request, server) {
      if (new URL(request.url).pathname === "/" && server.upgrade(request, { data: connections.socket() })) return
      return f.run(() => app.fetch(request, { server }))
    },
  })
  const sockets: WebSocket[] = []
  const sessionID = "ses_admission"
  await f.run(() =>
    OrganizationSessionDirectory.reservePrivate(f.credentials.alice, {
      sessionID,
      projectID: "project",
      runtimeID: "runtime-alice",
    }),
  )
  return {
    ...f,
    baseUrl: server.url.toString(),
    wire() {
      return wire!
    },
    apiHeaders(id = "alice") {
      return { ...f.headers(id), origin: "https://organization.example", "x-csrf-token": "f".repeat(64) }
    },
    forwarder,
    gateway,
    execution,
    machineKeys: key,
    commands,
    connections,
    signing,
    sessionID,
    request(requestID = "request", text = "Private input stays out of service storage"): Command.InputRequest {
      return {
        schemaVersion: 1,
        orgID: "org",
        requestID,
        sessionID,
        projectID: "project",
        runtimeID: "runtime-alice",
        input: { operation: "input", mode: "context", parts: [{ type: "text", text }] },
      }
    },
    async connect(epoch = 1, capable = true, readable = false, interactions = false) {
      const socket = new WebSocket(server.url.toString().replace(/^http/, "ws"))
      sockets.push(socket)
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = reject
      })
      const frame = await f.run(async () => {
        const { schemaVersion: _, ...registration } = (await Record.read(
          Record.RuntimeRegistration,
          Paths.runtime("runtime-alice"),
        ))!
        const signed = await connection(registration, key.privateKey, epoch)
        if (capable) {
          signed.proof.handshake.capabilities.push("commands")
          signed.proof.handshake.schemas.commands = 1
          if (readable) {
            signed.proof.handshake.capabilities.push("reads")
            signed.proof.handshake.schemas.reads = 1
          }
          if (interactions) {
            signed.proof.handshake.capabilities.push("interactions")
            signed.proof.handshake.schemas.interactions = 1
          }
          signed.signature = await Runtime.sign(signed.proof, key.privateKey)
        }
        return signed
      })
      const received = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Handshake timed out")), 2000)
        socket.onmessage = (event) => {
          clearTimeout(timeout)
          resolve(JSON.parse(String(event.data)))
        }
      })
      socket.send(JSON.stringify(frame))
      expect(Runtime.Connected.parse(await received).connectionEpoch).toBe(epoch)
      return socket
    },
    async [Symbol.asyncDispose]() {
      connections.close()
      await gateway.models.close()
      await gateway.connections.close()
      for (const socket of sockets) socket.close()
      await server.stop(true)
      await f[Symbol.asyncDispose]()
    },
  }
}
