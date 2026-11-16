import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { createWorkspaceFileHost } from "./workspace-file-host"
import { withMemberFiles } from "./execution-source"
import { OrganizationRuntimeError } from "./error"

function unavailable(message: string): never {
  throw new OrganizationRuntimeError({
    code: "RESOURCE_UNAVAILABLE",
    message,
    outcome: "not_dispatched",
    retryable: false,
  })
}

export namespace OrganizationWorkspaceFiles {
  export async function request(
    sessionID: string,
    value: Cloud.LocalFileRequest,
    signal?: AbortSignal,
  ): Promise<Cloud.FileResult> {
    const input = Cloud.LocalFileRequest.parse(value)
    const owner = WorkspaceContent.captureOwner(signal)
    return withMemberFiles({ sessionID, signal }, async (resolution, cancellation) => {
      owner()
      const selection = resolution.description.grant.selection.infrastructure.workspace!
      const bind = resolution.source.resources.bind.bind(resolution.source.resources)
      const send = resolution.source.resources.workspaceFiles.bind(resolution.source.resources)
      const proof = resolution.source.intake.bindingProof.bind(resolution.source.intake)
      const original = resolution.accepted
      await bind(resolution.proof, cancellation)
      owner()
      let open = true
      const pending = new Set<Promise<unknown>>()
      let last: Cloud.FileResult | undefined
      function assert() {
        owner()
        cancellation.throwIfAborted()
        if (!open) unavailable("Workspace file callback has ended")
      }
      function perform(operation: Cloud.FileOperation) {
        assert()
        const request = Cloud.LocalFileRequest.parse({ reference: input.reference, operation })
        const work = (async () => {
          const authority = await proof(original.actor, original.rootID)
          assert()
          const result = await send(authority, request, cancellation)
          assert()
          if (
            result.reference.resourceID !== selection.resourceID ||
            result.reference.workspaceID !== selection.workspaceID
          )
            unavailable("Workspace files returned another selected resource")
          last = result
          return result
        })()
        pending.add(work)
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        )
        return work
      }
      const mount = input.reference && {
        id: input.reference.workspaceID,
        workspaceID: input.reference.workspaceID,
        generation: input.reference.generation,
      }
      const files = createWorkspaceFileHost(mount, perform, assert)
      try {
        const operation = input.operation
        if (operation.action === "describe" || operation.action === "list") await perform(operation)
        else {
          if (!mount) unavailable("Workspace files require their original version")
          if (operation.action === "canonical") await files.canonical(mount, operation.path, operation.follow)
          else if (operation.action === "stat") await files.stat(mount, operation.path, operation.follow)
          else if (operation.action === "read") await files.read({ mount, ...operation })
          else if (operation.action === "write") await files.write({ mount, ...operation })
          else if (operation.action === "mutate") await files.mutate({ mount, ...operation })
          else if (operation.action === "receipt") await files.checkpointStatus(operation.id)
          else await files.acknowledge(operation.id)
        }
        assert()
        if (!last) unavailable("Workspace file operation has no completed response")
        return last
      } finally {
        open = false
        await Promise.allSettled([...pending])
      }
    })
  }
}
