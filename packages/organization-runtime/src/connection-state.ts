import path from "node:path"
import { z } from "zod"
import {
  OrganizationIdentity,
  OrganizationProtocol,
  OrganizationRuntimeProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import type { RuntimeHome } from "./home"
import { MemberHomeError, readRecordSnapshot, parseRecord, writeRecord } from "./record"
import { OrganizationRuntimeError } from "./error"

const Checkpoint = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: OrganizationIdentity.ID,
  deploymentIncarnation: OrganizationIdentity.ID,
  runtimeID: OrganizationIdentity.ID,
  connectionEpoch: OrganizationProtocol.Revision,
})

export function verifyConnectionRecord(bytes: Uint8Array, registration: OrganizationRuntimeProtocol.Registration) {
  const current = parseRecord(bytes, Checkpoint, "connection records")
  assertIdentity(current, registration)
  return current
}

function assertIdentity(current: z.infer<typeof Checkpoint>, registration: OrganizationRuntimeProtocol.Registration) {
  if (
    current.orgID !== registration.orgID ||
    current.deploymentIncarnation !== registration.deploymentIncarnation ||
    current.runtimeID !== registration.runtimeID
  )
    throw new MemberHomeError("Member Runtime connection identity changed; explicit recovery is required")
}

export function connectionState(member: RuntimeHome, registration: OrganizationRuntimeProtocol.Registration) {
  const filename = path.join(member.root, "organization-connection.json")
  async function snapshot(options: { signal?: AbortSignal } = {}) {
    const current = await readRecordSnapshot(filename, Checkpoint, "connection records", options)
    if (current) assertIdentity(current.value, registration)
    return { record: current, epoch: Math.max(current?.value.connectionEpoch ?? 0, registration.connectionEpoch) }
  }
  const read = async () => (await snapshot()).epoch
  return {
    read,
    snapshot,
    save(epoch: number, signal?: AbortSignal) {
      OrganizationProtocol.Revision.parse(epoch)
      return withFileLock(
        { directory: path.join(member.root, "state", ".locks"), key: "organization-connection", signal },
        async () => {
          const current = await read()
          signal?.throwIfAborted()
          if (epoch < current)
            throw new OrganizationRuntimeError({
              code: "STALE_CONNECTION",
              message: "Connection epoch regressed; explicit recovery is required",
              currentConnectionEpoch: current,
              retryable: false,
              outcome: "not_dispatched",
            })
          await writeRecord(filename, {
            schemaVersion: 1,
            orgID: registration.orgID,
            deploymentIncarnation: registration.deploymentIncarnation,
            runtimeID: registration.runtimeID,
            connectionEpoch: epoch,
          })
        },
      )
    },
  }
}
