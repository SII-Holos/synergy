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
import { OrganizationAuthorityHistory as History } from "./authority-history"
import { OrganizationCloud as Cloud } from "./cloud"

export namespace OrganizationSessionResources {
  export function mappedWorkspace(
    contract: Record.SessionResources,
    target: { resourceID: string; workspaceID: string },
  ) {
    return Record.SessionResources.parse({
      ...contract,
      revision: contract.revision + 1,
      selection: {
        ...contract.selection,
        infrastructure: {
          ...contract.selection!.infrastructure,
          workspace: { resourceID: target.resourceID, workspaceID: target.workspaceID },
        },
      },
    })
  }
  export async function rebindHandoff(
    session: Record.SessionDirectory,
    original: Record.SessionResources,
    target: { resourceID: string; workspaceID: string },
  ) {
    if (!Storage.inTransaction() || !session.handoffID || session.retainedExecutionGrants)
      fail("HANDOFF_BLOCKED", "Mapped resources require their drained original handoff transaction")
    const current = await read(session)
    if (JSON.stringify(current) !== JSON.stringify(original))
      fail("REVISION_CONFLICT", "The consented resource contract changed")
    const mapped = mappedWorkspace(original, target)
    await enabled({ ...session, resourceIDs: Execution.resourceIDs(mapped.selection!) }, mapped.selection!)
    await Storage.write(Keys.sessionResources(session.sessionID), mapped)
    return mapped
  }
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
    return History.credentials(credentials, "session.resources", async () => {
      const { account, session } = await authorize(credentials, "session.execute", { sessionID })
      const previous = await read(session)
      revision(input.expectedRevision, previous?.revision ?? 0)
      const command = await Record.read(Record.CommandState, Keys.commandState(sessionID))
      if (session.retainedExecutionGrants || command?.pendingAttemptID)
        fail("REVISION_CONFLICT", "Session execution must release its resource contract before changing selection")
      const ids = Execution.resourceIDs(input.selection)
      await Promise.all(
        Execution.resourceRoles(input.selection).map(async ({ resourceID, kind }) => {
          const { resource } = await authorize(credentials, "resource.use", {
            resourceID,
            projectID: session.projectID,
          })
          if (resource.kind !== kind) fail("INVALID_REQUEST", "Resource kind does not match its selected role")
        }),
      )
      await Cloud.assertInfrastructure(account.orgID, session.projectID, input.selection.infrastructure)
      const contract = Record.SessionResources.parse({
        schemaVersion: 2,
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
    const roles = Execution.resourceRoles(selection)
    const records = await Storage.readMany(roles.map(({ resourceID }) => Keys.resource(session.orgID, resourceID)))
    const resources = records.map((raw, index) => {
      if (!raw) fail("RESOURCE_UNAVAILABLE", "A selected resource is unavailable")
      const resource = Record.Resource.parse(raw)
      if (
        resource.orgID !== session.orgID ||
        resource.resourceID !== roles[index].resourceID ||
        resource.kind !== roles[index].kind ||
        resource.state !== "enabled" ||
        (resource.scope.kind === "project" && resource.scope.projectID !== session.projectID)
      )
        fail("RESOURCE_UNAVAILABLE", "A selected resource is unavailable")
      return resource
    })
    await Cloud.assertInfrastructure(session.orgID, session.projectID, selection.infrastructure)
    return resources
  }
}
