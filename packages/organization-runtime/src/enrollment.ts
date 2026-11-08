import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { readMemberHome, type MemberHome, type MemberIdentity } from "./home"
import { readCredentials } from "./credentials"
import { MemberHomeError, readRecord, writeRecord } from "./record"
import { OrganizationRuntimeError } from "./error"

const Enrollment = z.strictObject({ schemaVersion: z.literal(1), registration: Protocol.Registration })
function filename(root: string) {
  return path.join(root, "organization-registration.json")
}

function checkIdentity(member: MemberHome, registration: Protocol.Registration) {
  if (
    registration.orgID !== member.identity.orgID ||
    registration.accountID !== member.identity.accountID ||
    registration.deviceID !== member.identity.deviceID ||
    registration.publicKey !== member.publicKey
  )
    throw new MemberHomeError("Runtime registration does not match this Home identity")
}

export async function readMemberRegistration(home: string, identity: MemberIdentity) {
  const member = await readMemberHome(home, identity)
  const stored = await readRecord(filename(member.root), Enrollment, "registration records")
  if (!stored) return
  checkIdentity(member, stored.registration)
  return stored.registration
}

export async function enrollMemberRuntime(input: {
  home: string
  identity: MemberIdentity
  ticket: z.infer<typeof Protocol.Ticket>
  ca?: string | string[]
  signal?: AbortSignal
}) {
  const member = await readMemberHome(input.home, input.identity)
  const ticket = Protocol.Ticket.parse(input.ticket)
  checkIdentity(member, ticket.runtime)
  return withFileLock(
    { directory: path.join(member.root, "state", ".locks"), key: "organization-enrollment", signal: input.signal },
    async () => {
      const existing = await readMemberRegistration(member.home, member.identity)
      if (
        existing &&
        (existing.runtimeID !== ticket.runtime.runtimeID ||
          existing.deploymentIncarnation !== ticket.runtime.deploymentIncarnation)
      )
        throw new MemberHomeError("Runtime registration identity changed; explicit recovery is required")
      const credentials = await readCredentials(member.root)
      if (!credentials || credentials.publicKey !== member.publicKey)
        throw new MemberHomeError("Member Runtime credentials are missing or changed")
      const proof = Protocol.RegistrationProof.parse({
        purpose: "runtime-register",
        protocolVersion: OrganizationProtocol.version,
        orgID: member.identity.orgID,
        deploymentIncarnation: ticket.runtime.deploymentIncarnation,
        runtimeID: ticket.runtime.runtimeID,
        ticketHash: createHash("sha256").update(ticket.token).digest("hex"),
      })
      // Provenance: https://bun.sh/docs/runtime/networking/fetch#fetch-sessions
      // Local adaptation: each machine enrollment owns a verified-TLS pool, with no ambient proxy or browser credentials.
      const transport = new Bun.FetchSession({ tls: { ca: input.ca, rejectUnauthorized: true }, proxy: false })
      try {
        const client = createOrganizationClient({
          baseUrl: member.origin,
          fetch: Object.assign(transport.fetch, { preconnect() {} }),
          credentials: "omit",
          redirect: "error",
        })
        const response = await client.orgRuntime.consumeTicket(
          {
            orgRuntimeConsumeTicket: {
              token: ticket.token,
              proof,
              signature: await Protocol.sign(proof, credentials.privateKey),
            },
          },
          {
            signal: input.signal
              ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000),
          },
        )
        if (!response.data) {
          const error = OrganizationProtocol.Error.safeParse(response.error)
          throw new OrganizationRuntimeError(
            error.success
              ? error.data
              : {
                  code: "SERVICE_UNAVAILABLE",
                  message: "Member Runtime registration failed",
                  outcome: "unknown",
                  retryable: true,
                },
          )
        }
        const registration = Protocol.Registration.parse(response.data)
        checkIdentity(member, registration)
        if (
          registration.runtimeID !== ticket.runtime.runtimeID ||
          registration.deploymentIncarnation !== ticket.runtime.deploymentIncarnation ||
          registration.state !== "active"
        )
          throw new MemberHomeError("Runtime registration response does not match the requested identity")
        const saved = {
          ...registration,
          connectionEpoch: Math.max(existing?.connectionEpoch ?? 0, registration.connectionEpoch),
        }
        await writeRecord(filename(member.root), { schemaVersion: 1, registration: saved })
        return saved
      } finally {
        transport.close()
      }
    },
  )
}
