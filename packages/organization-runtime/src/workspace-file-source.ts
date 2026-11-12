import { z } from "zod"
import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceFileSource as Source } from "@ericsanchezok/synergy-harness/workspace/file-source"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"
import { OrganizationExecutionLeases as Leases } from "./execution-leases"
import { withMemberFiles, inspectMemberFiles } from "./execution-source"
import { OrganizationRuntimeError } from "./error"
import { RuntimeIdentity } from "./home"
import { createWorkspaceFileHost } from "./workspace-file-host"

export namespace OrganizationWorkspaceFileSource {
  const Binding = z.strictObject({
    version: z.literal(1),
    reference: Cloud.FileReference,
    authority: Leases.Authority,
    grantID: z.string().min(1),
    generation: z.number().int().positive().safe(),
  })
  function denied(message: string): never {
    throw new WorkspaceErrors.AccessDeniedError(message)
  }
  function rejected(error: unknown): never {
    if (error instanceof OrganizationRuntimeError && error.data.outcome === "not_dispatched") {
      if (error.data.code === "REVISION_CONFLICT")
        throw new Source.Rejected(WorkspaceErrors.failure(new WorkspaceErrors.ConflictError()))
      if (["PERMISSION_DENIED", "RESOURCE_UNAVAILABLE", "NOT_FOUND", "HANDOFF_BLOCKED"].includes(error.data.code))
        throw new Source.Rejected(WorkspaceErrors.failure(new WorkspaceErrors.AccessDeniedError(error.message)))
    }
    throw error
  }
  export function register(value: RuntimeIdentity) {
    const identity = RuntimeIdentity.parse(value)
    Source.register("organization", {
      async open(input) {
        const workspace = input.workspace
        const signal = input.signal
        const spec = Cloud.FileLocator.parse(workspace.backend?.spec)
        const owner = WorkspaceContent.captureOwner()
        if (spec.orgID !== identity.orgID || spec.projectID !== workspace.scopeID || workspace.content)
          denied("Organization Locator belongs to another file owner")
        const reference = WorkspaceProtocol.Reference.parse({
          id: workspace.id,
          workspaceID: workspace.id,
          generation: workspace.binding.generation,
        })
        function check(remote: Cloud.FileReference) {
          owner()
          if (
            remote.orgID !== spec.orgID ||
            remote.projectID !== spec.projectID ||
            remote.resourceID !== spec.resourceID ||
            remote.workspaceID !== spec.workspaceID ||
            remote.generation !== spec.generation ||
            remote.rootPath !== spec.path
          )
            denied("Organization files differ from the original remote Locator")
        }
        if (input.binding !== undefined) {
          const binding = Binding.parse(input.binding)
          check(binding.reference)
          if (
            binding.authority.orgID !== spec.orgID ||
            binding.authority.projectID !== spec.projectID ||
            binding.authority.deploymentIncarnation !== spec.deploymentIncarnation
          )
            denied("Workspace receipt belongs to another original deployment")
          let open = true
          const assert = () => {
            owner()
            signal?.throwIfAborted()
            if (!open) denied("Workspace receipt inspection has ended")
          }
          const perform = async (operation: Cloud.FileOperation) => {
            assert()
            if (operation.action !== "receipt" && operation.action !== "acknowledge")
              denied("Cold Workspace files support only original receipt inspection")
            const result = await inspectMemberFiles(
              binding.authority,
              binding,
              { reference: binding.reference, operation },
              signal,
            )
            assert()
            return result
          }
          return {
            reference,
            directory: "/workspace",
            binding,
            files: createWorkspaceFileHost(reference, perform, assert, spec.path),
            assert,
            async release() {
              owner()
              open = false
            },
          }
        }
        const origin = input.origin
        if (!origin || origin.value.kind !== "session")
          denied("Organization files require an original Session execution origin")
        const selected = origin.value
        const ready = Promise.withResolvers<Source.Lease>()
        const released = Promise.withResolvers<void>()
        let open = true
        const work = withMemberFiles(
          { sessionID: selected.sessionID, scopeID: selected.scopeID, origin, signal },
          async (resolution, cancellation) => {
            const accepted = structuredClone(resolution.accepted)
            const send = resolution.source.resources.workspaceFiles.bind(resolution.source.resources)
            const bind = resolution.source.resources.bind.bind(resolution.source.resources)
            const proof = resolution.source.intake.bindingProof.bind(resolution.source.intake)
            const original = resolution.proof
            const assert = () => {
              owner()
              origin.assertCurrent()
              cancellation.throwIfAborted()
              if (!open) denied("Organization file lease has ended")
            }
            assert()
            if (
              resolution.description.grant.deploymentIncarnation !== spec.deploymentIncarnation ||
              resolution.source.connection.deploymentIncarnation !== spec.deploymentIncarnation
            )
              denied("Organization Locator belongs to another deployment incarnation")
            const grant = await bind(original, cancellation)
            assert()
            const authority = await proof(accepted.actor, accepted.rootID)
            await resolution.assertCaller()
            const described = await send(authority, { operation: { action: "describe" } }, cancellation)
            assert()
            await resolution.assertCaller()
            const remote = Cloud.FileReference.parse({ ...described.reference, rootPath: spec.path })
            check(remote)
            const binding = Binding.parse({
              version: 1,
              reference: remote,
              authority: Leases.Authority.parse(JSON.parse(JSON.stringify(Leases.reference(original)))),
              grantID: grant.grantID,
              generation: grant.retention.generation,
            })
            const perform = async (operation: Cloud.FileOperation) => {
              assert()
              const file = Cloud.LocalFileRequest.parse({ reference: remote, operation })
              try {
                const authority = await proof(accepted.actor, accepted.rootID)
                assert()
                await resolution.assertCaller()
                const result = await send(authority, file, cancellation)
                assert()
                await resolution.assertCaller()
                check(result.reference)
                return result
              } catch (error) {
                return rejected(error)
              }
            }
            ready.resolve({
              reference,
              directory: "/workspace",
              binding,
              files: createWorkspaceFileHost(reference, perform, assert, spec.path),
              assert,
              async release() {
                owner()
                open = false
                released.resolve()
                await work
              },
            })
            await released.promise
            owner()
          },
        )
        void work.catch((error) => ready.reject(error))
        try {
          return await ready.promise
        } catch (error) {
          open = false
          released.resolve()
          await Promise.allSettled([work])
          throw error
        }
      },
    })
  }
}
