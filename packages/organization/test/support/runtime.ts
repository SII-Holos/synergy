import { expect } from "bun:test"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { fixture } from "./organization"
import { digest } from "../../src/auth/secret"

export async function keys() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  return { privateKey: pair.privateKey, publicKey: await Runtime.publicKey(pair.publicKey) }
}
export async function proof(ticket: ReturnType<typeof Runtime.Ticket.parse>, privateKey: CryptoKey) {
  const proof = Runtime.RegistrationProof.parse({
    purpose: "runtime-register",
    protocolVersion: 1,
    orgID: ticket.runtime.orgID,
    deploymentIncarnation: ticket.runtime.deploymentIncarnation,
    runtimeID: ticket.runtime.runtimeID,
    ticketHash: digest(ticket.token),
  })
  return { token: ticket.token, proof, signature: await Runtime.sign(proof, privateKey) }
}
export async function consume(f: Awaited<ReturnType<typeof fixture>>, input: unknown) {
  return f.service.fetch(
    new Request("https://organization.example/runtime/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  )
}
export async function register(
  client: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["initialize"]>>,
  deviceID: string,
  publicKey: string,
) {
  const response = await client.request("POST", "/runtimes/member", { deviceID, publicKey })
  expect(response.status).toBe(200)
  return Runtime.Ticket.parse(await response.json())
}
export async function connection(runtime: Runtime.Registration, privateKey: CryptoKey, epoch: number) {
  const proof = Runtime.ConnectionProof.parse({
    purpose: "runtime-connect",
    nonce: digest(crypto.randomUUID()),
    issuedAt: Date.now(),
    handshake: {
      type: "handshake",
      protocolVersion: 1,
      runtimeKind: "member",
      orgID: runtime.orgID,
      deploymentIncarnation: runtime.deploymentIncarnation,
      runtimeID: runtime.runtimeID,
      accountID: runtime.accountID,
      deviceID: runtime.deviceID,
      buildVersion: "test",
      connectionEpoch: epoch,
      capabilities: ["bridge"],
      schemas: { bridge: 1 },
    },
  })
  return { type: "handshake" as const, proof, signature: await Runtime.sign(proof, privateKey) }
}
