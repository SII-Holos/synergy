import { createHash } from "node:crypto"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionWorkspaceRuntime } from "@ericsanchezok/synergy-harness/session/workspace-runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceFileSource } from "@ericsanchezok/synergy-harness/workspace/file-source"
import { OrganizationRuntimeError } from "./error"

function denied(message: string): never {
  throw new OrganizationRuntimeError({
    code: "RESOURCE_UNAVAILABLE",
    message,
    outcome: "not_dispatched",
    retryable: false,
  })
}

export async function prepareInitialWorkspace(input: {
  sessionID: string
  grant: Execution.BoundGrant
  reference: Cloud.FileReference
  signal: AbortSignal
  assert(): void
}) {
  const grant = Execution.BoundGrant.parse(structuredClone(input.grant))
  const reference = Cloud.FileReference.parse(structuredClone(input.reference))
  const selected = grant.selection.infrastructure.workspace
  const owner = WorkspaceContent.captureOwner(input.signal)
  const assert = () => {
    owner()
    input.assert()
    input.signal.throwIfAborted()
  }
  assert()
  if (
    !selected ||
    reference.rootPath !== undefined ||
    reference.orgID !== grant.orgID ||
    reference.projectID !== grant.projectID ||
    reference.resourceID !== selected.resourceID ||
    reference.workspaceID !== selected.workspaceID
  )
    denied("Initial Working requires its exact accepted whole Workspace")
  const matches = (spec: Cloud.FileLocator) =>
    spec.orgID === grant.orgID &&
    spec.deploymentIncarnation === grant.deploymentIncarnation &&
    spec.projectID === grant.projectID &&
    spec.resourceID === reference.resourceID &&
    spec.workspaceID === reference.workspaceID &&
    spec.generation === reference.generation
  return SessionWorkspaceRuntime.withBinding(
    input.sessionID,
    async () => {
      assert()
      const session = await Session.get(input.sessionID)
      if (
        session.scope.id !== grant.projectID ||
        session.organization?.orgID !== grant.orgID ||
        session.organization.projectID !== grant.projectID ||
        session.organization.bindingEpoch !== grant.bindingEpoch ||
        session.organization.driverRuntimeID !== grant.runtimeID
      )
        denied("Initial Working belongs to another native Session binding")
      if (session.workspaceID) {
        const existing = await WorkspaceFileSource.inspectBinding({
          workspaceID: session.workspaceID,
          scopeID: session.scope.id,
        })
        if (existing.backend?.provider !== "organization" || !matches(Cloud.FileLocator.parse(existing.backend.spec)))
          denied("The selected Workspace cannot replace the Session's existing Working location")
        assert()
        return session
      }
      if (session.workspace) denied("Initial Working cannot replace an unbound native directory")
      const spec = Cloud.FileLocator.parse({
        version: 3,
        orgID: grant.orgID,
        deploymentIncarnation: grant.deploymentIncarnation,
        projectID: grant.projectID,
        resourceID: reference.resourceID,
        workspaceID: reference.workspaceID,
        generation: reference.generation,
        ownerSessionID: session.id,
        sessionID: grant.sessionID,
        rootID: grant.rootID,
        grantID: grant.grantID,
        selectionRevision: grant.selectionRevision,
      })
      const id =
        "wsp_" +
        createHash("sha256")
          .update(
            JSON.stringify([
              "organization-initial-working-v1",
              session.id,
              grant.orgID,
              grant.deploymentIncarnation,
              grant.projectID,
              reference.resourceID,
              reference.workspaceID,
              reference.generation,
            ]),
          )
          .digest("hex")
      await Storage.transaction(
        async (tx) => {
          assert()
          const existing = await WorkspaceCatalog.get(id, session.scope.id).catch((error: unknown) => {
            if (error instanceof Storage.NotFoundError) return
            throw error
          })
          if (existing) {
            const original = Cloud.FileLocator.parse(existing.backend?.spec)
            if (
              existing.backend?.provider !== "organization" ||
              original.version !== 3 ||
              original.ownerSessionID !== session.id ||
              !matches(original)
            )
              denied("Initial Working publication belongs to another original Session or Workspace")
            await WorkspaceFileSource.inspectBinding({ workspaceID: id, scopeID: session.scope.id, generation: 1 })
            return
          }
          const now = Date.now()
          await WorkspaceCatalog.writeImportedFiles(
            WorkspaceCatalog.Info.parse({
              id,
              scopeID: session.scope.id,
              type: "directory",
              revision: 1,
              binding: { state: "bound", hostID: "organization:" + grant.orgID, path: null, generation: 1 },
              backend: { provider: "organization", spec },
              metadata: {},
              sharedWritableWorkspaceIDs: [],
              lifecycle: "active",
              createdAt: now,
              updatedAt: now,
            }),
            tx,
          )
          assert()
        },
        { commitGuard: assert },
      )
      assert()
      const updated = await Session.updateWorkspace(session.id, null, {
        reference: { workspaceID: id, workspaceGeneration: 1 },
        preserveActivityAt: true,
        signal: input.signal,
      })
      assert()
      return updated
    },
    input.signal,
  )
}
