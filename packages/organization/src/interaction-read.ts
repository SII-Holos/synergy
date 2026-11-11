import {
  OrganizationInteractionProtocol as Protocol,
  OrganizationProtocol as Core,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Credentials } from "./auth/session"
import { authorize } from "./authorization"
import type { RuntimeConnections } from "./runtime-connection"
import type { CommandSigningAuthority } from "./signing"
import { OrganizationError, fail } from "./error"

export function createInteractionForwarder(options: {
  connections: RuntimeConnections
  signing: CommandSigningAuthority
  timeoutMs?: number
}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Interaction read timeout must be finite")
  let active = 0
  return {
    async read(credentials: Credentials, input: Protocol.Query, signal?: AbortSignal) {
      credentials = { ...credentials }
      const query = Protocol.Query.parse(input)
      if (active >= 32) fail("SERVICE_UNAVAILABLE", "Interaction read capacity is currently busy")
      active++
      try {
        const deadline = Date.now() + timeoutMs
        const work = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
        const admitted = await Storage.snapshot(async () => {
          work.throwIfAborted()
          const { account, session } = await authorize(credentials, "session.read", { sessionID: query.rootSessionID })
          const connection = options.connections.capture(session.driverRuntimeID)
          if (
            !connection.handshake.capabilities.includes("interactions") ||
            connection.handshake.schemas.interactions !== 1
          )
            fail("RESOURCE_UNAVAILABLE", "The current Runtime does not support safe interaction reads")
          work.throwIfAborted()
          const binding = Core.SessionBinding.parse({
            schemaVersion: 1,
            orgID: session.orgID,
            projectID: session.projectID,
            creatorID: session.creatorID,
            driverRuntimeID: session.driverRuntimeID,
            bindingEpoch: session.bindingEpoch,
          })
          const permit = Protocol.Permit.parse({
            schemaVersion: 1,
            purpose: "session-interactions",
            orgID: session.orgID,
            deploymentIncarnation: options.signing.identity.deploymentIncarnation,
            keyID: options.signing.identity.keyID,
            runtimeID: session.driverRuntimeID,
            connectionEpoch: connection.handshake.connectionEpoch,
            subjectID: account.accountID,
            binding,
            query,
            issuedAt: Date.now(),
            expiresAt: deadline,
          })
          return { connection, authorization: await options.signing.signInteractions(permit) }
        })
        const { connection, authorization } = admitted
        try {
          const reply = await connection.exchange({ kind: "interactions", authorization }, { signal: work, deadline })
          connection.assertCurrent()
          if (reply.kind === "error") throw new OrganizationError(reply.error)
          if (
            reply.kind !== "interactions" ||
            reply.result.runtimeKind !== connection.handshake.runtimeKind ||
            !Protocol.matches(query, reply.result, authorization.permit.binding)
          )
            fail("PROTOCOL_MISMATCH", "Interaction read returned another target")
          return await Storage.snapshot(async () => {
            work.throwIfAborted()
            const { session } = await authorize(credentials, "session.read", { sessionID: query.rootSessionID })
            const binding = Core.SessionBinding.parse({
              schemaVersion: 1,
              orgID: session.orgID,
              projectID: session.projectID,
              creatorID: session.creatorID,
              driverRuntimeID: session.driverRuntimeID,
              bindingEpoch: session.bindingEpoch,
            })
            if (JSON.stringify(binding) !== JSON.stringify(authorization.permit.binding))
              fail("STALE_BINDING", "Interaction execution binding changed during the read")
            connection.assertCurrent()
            return Protocol.Result.parse(reply.result)
          })
        } catch (error) {
          if (error instanceof OrganizationError && error.data.code === "COMMAND_OUTCOME_UNKNOWN")
            fail("RUNTIME_OFFLINE", "Interaction reading ended before a verified response")
          throw error
        }
      } finally {
        active--
      }
    },
  }
}
