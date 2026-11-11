import { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Credentials } from "./auth/session"
import { authorize } from "./authorization"
import type { RuntimeConnections } from "./runtime-connection"
import type { CommandSigningAuthority } from "./signing"
import { OrganizationError, fail } from "./error"

export function createSessionReadForwarder(options: {
  connections: RuntimeConnections
  signing: CommandSigningAuthority
  timeoutMs?: number
}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  let active = 0
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Private read timeout must be finite")
  async function authorized(credentials: Credentials, sessionID: string) {
    const current = await authorize(credentials, "session.read", { sessionID })
    if (current.account.accountID !== current.session.creatorID)
      fail("PERMISSION_DENIED", "Native private reading requires the Session creator")
    return current
  }
  return {
    async read(credentials: Credentials, input: Read.Input, signal?: AbortSignal) {
      if (active >= 32) fail("SERVICE_UNAVAILABLE", "Private read capacity is currently busy")
      active++
      try {
        const query = Read.Query.parse(input)
        const deadline = Date.now() + timeoutMs
        const work = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
        const admitted = await Storage.snapshot(async () => {
          work.throwIfAborted()
          const { account, session } = await authorized(credentials, query.rootSessionID)
          const connection = options.connections.capture(session.driverRuntimeID)
          if (!connection.handshake.capabilities.includes("reads") || connection.handshake.schemas.reads !== 1)
            fail("RESOURCE_UNAVAILABLE", "The current Runtime does not support private native reads")
          const permit = Read.Permit.parse({
            purpose: "session-read",
            schemaVersion: 1,
            orgID: session.orgID,
            deploymentIncarnation: options.signing.identity.deploymentIncarnation,
            runtimeID: session.driverRuntimeID,
            projectID: session.projectID,
            creatorID: session.creatorID,
            subjectID: account.accountID,
            keyID: options.signing.identity.keyID,
            bindingEpoch: session.bindingEpoch,
            connectionEpoch: connection.handshake.connectionEpoch,
            query,
            issuedAt: Date.now(),
            expiresAt: deadline,
          })
          return { connection, authorization: await options.signing.signRead(permit) }
        })
        const { connection, authorization } = admitted
        try {
          const reply = await connection.exchange({ kind: "read", authorization }, { signal: work, deadline })
          connection.assertCurrent()
          if (reply.kind === "error") throw new OrganizationError(reply.error)
          if (reply.kind !== "read" || !Read.matches(query, reply.result, Read.bindingFor(authorization.permit)))
            fail("PROTOCOL_MISMATCH", "Private read returned another target")
          return await Storage.snapshot(async () => {
            work.throwIfAborted()
            const { session } = await authorized(credentials, query.rootSessionID)
            if (
              session.bindingEpoch !== authorization.permit.bindingEpoch ||
              session.driverRuntimeID !== authorization.permit.runtimeID ||
              session.projectID !== authorization.permit.projectID
            )
              fail("STALE_BINDING", "Private Session execution moved during the read")
            connection.assertCurrent()
            return Read.Result.parse(reply.result)
          })
        } catch (error) {
          if (error instanceof OrganizationError && error.data.code === "COMMAND_OUTCOME_UNKNOWN")
            fail("RUNTIME_OFFLINE", "Private reading ended before a verified response")
          throw error
        }
      } finally {
        active--
      }
    },
  }
}
export type SessionReadForwarder = ReturnType<typeof createSessionReadForwarder>
