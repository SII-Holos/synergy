import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { readRuntimeHome, type RuntimeIdentity, type MemberIdentity, type HostedIdentity } from "./home"
import { readCredentials } from "./credentials"
import { MemberHomeError, writeRecord } from "./record"
import { OrganizationRuntimeError } from "./error"
import { checkRuntimeRegistration, readRuntimeRegistration, registrationFilename } from "./registration"

export async function enrollRuntime(input: {
  home: string
  identity: RuntimeIdentity
  ticket: z.infer<typeof Protocol.Ticket>
  ca?: string | string[]
  signal?: AbortSignal
}) {
  const member = await readRuntimeHome(input.home, input.identity)
  const ticket = Protocol.Ticket.parse(input.ticket)
  checkRuntimeRegistration(member, ticket.runtime)
  return withFileLock(
    { directory: path.join(member.root, "state", ".locks"), key: "organization-enrollment", signal: input.signal },
    async () => {
      const existing = await readRuntimeRegistration(member.home, member.identity)
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
        checkRuntimeRegistration(member, registration)
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
        await writeRecord(registrationFilename(member.root), { schemaVersion: 1, registration: saved })
        return saved
      } finally {
        transport.close()
      }
    },
  )
}

export async function enrollMemberRuntime(input: Omit<Parameters<typeof enrollRuntime>[0], "identity"> & { identity: MemberIdentity }) {
  return Protocol.MemberRegistrationRecord.parse(await enrollRuntime(input))
}

export async function enrollHostedRuntime(input: Omit<Parameters<typeof enrollRuntime>[0], "identity"> & { identity: HostedIdentity }) {
  return Protocol.HostedRegistrationRecord.parse(await enrollRuntime(input))
}
