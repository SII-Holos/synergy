import { OrganizationCloudProtocol as Cloud } from "@ericsanchezok/synergy-organization-protocol"
import type { WorkspaceFileHost, WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"

export function createWorkspaceFileHost(
  reference: WorkspaceProtocol.Reference | undefined,
  perform: (operation: Cloud.FileOperation) => Promise<Cloud.FileResult>,
  assert: () => void,
  prefix = "",
): WorkspaceFileHost {
  function remote(path: string) {
    const parsed = path === "" ? "" : Cloud.Path.parse(path)
    return prefix ? (parsed ? prefix + "/" + parsed : prefix) : parsed
  }
  function local(path: string) {
    if (!prefix) return path
    if (path === prefix) return ""
    if (!path.startsWith(prefix + "/"))
      throw new WorkspaceErrors.AccessDeniedError("Workspace path escapes its mapped directory")
    return path.slice(prefix.length + 1)
  }
  function unavailable(message: string): never {
    throw new WorkspaceErrors.AccessDeniedError(message)
  }
  const mount = reference
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
      const result = (await perform({ action: "canonical", path: remote(path), follow })).result
      if (result.action !== "canonical") unavailable("Workspace canonical response changed")
      return local(result.path)
    },
    async stat(value, path, follow) {
      selected(value)
      const result = (await perform({ action: "stat", path: remote(path), follow })).result
      if (result.action !== "stat") unavailable("Workspace metadata response changed")
      return result.item && { ...result.item, path: local(result.item.path) }
    },
    async list(value, path) {
      selected(value)
      const items: WorkspaceProtocol.Item[] = []
      let cursor: string | undefined, revision: number | undefined
      for (;;) {
        const result = (await perform({ action: "list", path: remote(path), cursor, revision, limit: 128 })).result
        if (result.action !== "list") unavailable("Workspace directory response changed")
        items.push(...result.items.map((item) => ({ ...item, path: local(item.path) })))
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
          path: remote(value.path),
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
      const result = (await perform({ action: "write", ...write, path: remote(write.path) })).result
      if (result.action !== "write") unavailable("Workspace write response changed")
      return { ...result.checkpoint, mount: reference! }
    },
    async mutate(value) {
      selected(value.mount)
      if (value.change.kind === "import") unavailable("Workspace import requires its canonical move owner")
      const result = (
        await perform({
          action: "mutate",
          id: value.id,
          change: Cloud.FileChange.parse(
            "path" in value.change
              ? { ...value.change, path: remote(value.change.path) }
              : { ...value.change, from: remote(value.change.from), to: remote(value.change.to) },
          ),
          protectSensitive: value.protectSensitive,
        })
      ).result
      if (result.action !== "mutate") unavailable("Workspace mutation response changed")
      return { ...result.checkpoint, mount: reference! }
    },
    async checkpointStatus(id) {
      const result = (await perform({ action: "receipt", id })).result
      if (result.action !== "receipt") unavailable("Workspace receipt response changed")
      return (
        result.status && {
          ...result.status,
          mount: reference!,
          checkpoint: result.status.checkpoint && { ...result.status.checkpoint, mount: reference! },
        }
      )
    },
    async acknowledge(id) {
      await perform({ action: "acknowledge", id })
    },
  }
  return files
}
