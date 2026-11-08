import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import type { Credentials } from "./auth/session"
import { authorize } from "./authorization"
import { fail, revision } from "./error"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"

export namespace OrganizationSessionResources {
  export async function read(session: Record.SessionDirectory) {
    const contract = await Record.read(Record.SessionResources, Keys.sessionResources(session.sessionID))
    if (!contract) {
      if (session.resourceIDs.length) fail("SERVICE_UNAVAILABLE", "Session resource contract is missing")
      return
    }
    if (
      contract.orgID !== session.orgID ||
      contract.sessionID !== session.sessionID ||
      !contract.selection ||
      JSON.stringify(Execution.resourceIDs(contract.selection)) !== JSON.stringify(session.resourceIDs)
    )
      fail("SERVICE_UNAVAILABLE", "Session resource contract is inconsistent")
    return contract
  }
  export async function get(credentials: Credentials, sessionID: string): Promise<Execution.Contract> {
    credentials = { ...credentials }
    sessionID = Identity.ID.parse(sessionID)
    return Storage.snapshot(async () => {
      const { session } = await authorize(credentials, "session.read", { sessionID })
      const contract = await read(session)
      return Execution.Contract.parse({
        sessionID,
        revision: contract?.revision ?? 0,
        selection: contract?.selection ?? null,
      })
    })
  }
  export async function set(
    credentials: Credentials,
    sessionID: string,
    value: Execution.Change,
  ): Promise<Execution.Contract> {
    credentials = { ...credentials }
    sessionID = Identity.ID.parse(sessionID)
    const input = Execution.Change.parse(value)
    return Storage.transaction(async () => {
      const { account, session } = await authorize(credentials, "session.execute", { sessionID })
      const previous = await read(session)
      revision(input.expectedRevision, previous?.revision ?? 0)
      const command = await Record.read(Record.CommandState, Keys.commandState(sessionID))
      if (session.executionGrantIDs.length || command?.pendingAttemptID)
        fail("REVISION_CONFLICT", "Session execution must release its resource contract before changing selection")
      const ids = Execution.resourceIDs(input.selection)
      await Promise.all(
        ids.map(async (resourceID) => {
          const { resource } = await authorize(credentials, "resource.use", {
            resourceID,
            projectID: session.projectID,
          })
          if (resource.kind !== (resourceID === input.selection.modelResourceID ? "model" : "connection"))
            fail("INVALID_REQUEST", "Resource kind does not match its selected role")
        }),
      )
      const contract = Record.SessionResources.parse({
        schemaVersion: 1,
        orgID: account.orgID,
        sessionID,
        revision: (previous?.revision ?? 0) + 1,
        selection: input.selection,
      })
      await Storage.write(Keys.sessionResources(sessionID), contract)
      await Storage.write(
        Keys.session(sessionID),
        Record.SessionDirectory.parse({
          ...session,
          resourceIDs: ids,
          rowRevision: session.rowRevision + 1,
        }),
      )
      return Execution.Contract.parse({ sessionID, revision: contract.revision, selection: contract.selection })
    })
  }
  export async function enabled(session: Record.SessionDirectory, selection: Execution.Selection) {
    const ids = Execution.resourceIDs(selection)
    const records = await Storage.readMany(ids.map((id) => Keys.resource(session.orgID, id)))
    return records.map((raw, index) => {
      if (!raw) fail("RESOURCE_UNAVAILABLE", "A selected resource is unavailable")
      const resource = Record.Resource.parse(raw)
      if (
        resource.orgID !== session.orgID ||
        resource.resourceID !== ids[index] ||
        resource.kind !== (index === 0 ? "model" : "connection") ||
        resource.state !== "enabled" ||
        (resource.scope.kind === "project" && resource.scope.projectID !== session.projectID)
      )
        fail("RESOURCE_UNAVAILABLE", "A selected resource is unavailable")
      return resource
    })
  }
}
