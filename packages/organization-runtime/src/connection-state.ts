import path from "node:path"
import { z } from "zod"
import {
  OrganizationIdentity,
  OrganizationProtocol,
  OrganizationRuntimeProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import type { MemberHome } from "./home"
import { MemberHomeError, readRecord, writeRecord } from "./record"
import { OrganizationRuntimeError } from "./error"

const Checkpoint = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: OrganizationIdentity.ID,
  deploymentIncarnation: OrganizationIdentity.ID,
  runtimeID: OrganizationIdentity.ID,
  connectionEpoch: OrganizationProtocol.Revision,
})

export function connectionState(member: MemberHome, registration: OrganizationRuntimeProtocol.Registration) {
  const filename = path.join(member.root, "organization-connection.json")
  async function read() {
    const current = await readRecord(filename, Checkpoint, "connection records")
    if (
      current &&
      (current.orgID !== registration.orgID ||
        current.deploymentIncarnation !== registration.deploymentIncarnation ||
        current.runtimeID !== registration.runtimeID)
    )
      throw new MemberHomeError("Member Runtime connection identity changed; explicit recovery is required")
    return Math.max(current?.connectionEpoch ?? 0, registration.connectionEpoch)
  }
  return {
    read,
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
