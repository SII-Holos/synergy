import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import type { WorkspaceFileHost, WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
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
      const reference = input.reference
      const mount = reference && {
        id: reference.workspaceID,
        workspaceID: reference.workspaceID,
        generation: reference.generation,
      }
      function selected(value: WorkspaceProtocol.Reference) {
        assert()
        if (
          !mount ||
          value.id !== mount.id ||
          value.workspaceID !== mount.workspaceID ||
          value.generation !== mount.generation
        )
          unavailable("Workspace file handle belongs to another original selection")
      }
      const unsupported = async (): Promise<never> =>
        unavailable("This dormant file owner does not provide mounts, compute or blob imports")
      const files: WorkspaceFileHost = {
        mount: unsupported,
        inspect: unsupported,
        detach: unsupported,
        checkpoint: unsupported,
        putBlob: unsupported,
        getBlob: unsupported,
        async canonical(value, path, follow) {
          selected(value)
          const result = (await perform({ action: "canonical", path, follow })).result
          if (result.action !== "canonical") unavailable("Workspace canonical response changed")
          return result.path
        },
        async stat(value, path, follow) {
          selected(value)
          const result = (await perform({ action: "stat", path, follow })).result
          if (result.action !== "stat") unavailable("Workspace metadata response changed")
          return result.item
        },
        async list(value, path) {
          selected(value)
          const items: WorkspaceProtocol.Item[] = []
          let cursor: string | undefined, revision: number | undefined
          for (;;) {
            const result = (await perform({ action: "list", path, cursor, revision, limit: 128 })).result
            if (result.action !== "list") unavailable("Workspace directory response changed")
            items.push(...result.items)
            if (!result.cursor) return items
            cursor = result.cursor
            revision = result.revision
          }
        },
        async read(value) {
          selected(value.mount)
          const result = (
            await perform({
              action: "read",
              path: value.path,
              offset: value.offset ?? 0,
              maximumBytes: value.maximumBytes,
              expectedVersion: value.expectedVersion,
            })
          ).result
          if (result.action !== "read") unavailable("Workspace bytes response changed")
          return result
        },
        async write(value) {
          selected(value.mount)
          const { mount: _, ...write } = value
          const result = (await perform({ action: "write", ...write })).result
          if (result.action !== "write") unavailable("Workspace write response changed")
          return result.checkpoint
        },
        async mutate(value) {
          selected(value.mount)
          if (value.change.kind === "import") unavailable("Workspace import requires its canonical move owner")
          const result = (
            await perform({
              action: "mutate",
              id: value.id,
              change: Cloud.FileChange.parse(value.change),
              protectSensitive: value.protectSensitive,
            })
          ).result
          if (result.action !== "mutate") unavailable("Workspace mutation response changed")
          return result.checkpoint
        },
        async checkpointStatus(id) {
          const result = (await perform({ action: "receipt", id })).result
          if (result.action !== "receipt") unavailable("Workspace receipt response changed")
          return result.status
        },
        async acknowledge(id) {
          await perform({ action: "acknowledge", id })
        },
      }
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
