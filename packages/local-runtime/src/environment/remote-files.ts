import { z } from "zod"
import { WorkspaceProtocol, type WorkspaceFileHost } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { ExecutionConnection } from "./connection"

export class RemoteWorkspaceFiles implements WorkspaceFileHost {
  constructor(private readonly connection: ExecutionConnection) {}
  private async request(request: WorkspaceProtocol.Request, signal?: AbortSignal) {
    const result = await this.connection.json(
      "POST",
      "/v1/workspaces",
      WorkspaceProtocol.Request.parse(request),
      signal,
    )
    if (result === undefined) throw new Error("Workspace transport is unavailable")
    return result
  }
  async mount(input: WorkspaceProtocol.MountInput) {
    return WorkspaceProtocol.Mount.parse(await this.request({ action: "mount", input }))
  }
  async inspect(mount: WorkspaceProtocol.Reference) {
    return WorkspaceProtocol.Mount.nullable().parse(await this.request({ action: "inspect", mount })) ?? undefined
  }
  async observe(mount: WorkspaceProtocol.Reference, signal?: AbortSignal) {
    return WorkspaceProtocol.Observation.parse(await this.request({ action: "observe", mount }, signal))
  }
  async detach(mount: WorkspaceProtocol.Reference) {
    await this.request({ action: "detach", mount })
  }
  async stat(mount: WorkspaceProtocol.Reference, path: string, follow?: boolean) {
    return (
      WorkspaceProtocol.Item.nullable().parse(await this.request({ action: "stat", mount, path, follow })) ?? undefined
    )
  }
  async canonical(mount: WorkspaceProtocol.Reference, path: string, follow: boolean) {
    return z
      .union([WorkspaceTree.Path, z.literal("")])
      .parse(await this.request({ action: "canonical", mount, path, follow }))
  }
  async read(input: WorkspaceProtocol.ReadInput) {
    return WorkspaceProtocol.Read.parse(await this.request({ action: "read", input }))
  }
  async list(mount: WorkspaceProtocol.Reference, path: string) {
    return z.array(WorkspaceProtocol.Item).parse(await this.request({ action: "list", mount, path }))
  }
  async write(input: WorkspaceProtocol.WriteInput) {
    return WorkspaceProtocol.Checkpoint.parse(await this.request({ action: "write", input }))
  }
  async checkpoint(input: WorkspaceProtocol.CheckpointInput) {
    return WorkspaceProtocol.Checkpoint.parse(await this.request({ action: "checkpoint", input }))
  }
  async acknowledge(id: string) {
    await this.request({ action: "acknowledge", id })
  }
  async checkpointStatus(id: string) {
    return (
      WorkspaceProtocol.CheckpointStatus.nullable().parse(await this.request({ action: "checkpointStatus", id })) ??
      undefined
    )
  }
  async mutate(input: WorkspaceProtocol.ChangeInput) {
    return WorkspaceProtocol.Checkpoint.parse(await this.request({ action: "mutate", input }))
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    WorkspaceTree.verify(hash, bytes, WorkspaceTree.manifestBytes)
    if (!(await this.connection.send("PUT", `/v1/workspace-objects/${hash}`, bytes, true)))
      throw new Error("Workspace blob transport is unavailable")
  }
  async getBlob(hash: string, maximumBytes: number) {
    WorkspaceTree.Hash.parse(hash)
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > WorkspaceTree.manifestBytes)
      throw new Error("Invalid Workspace object size")
    const response = await this.connection.send("GET", `/v1/workspace-objects/${hash}?maximumBytes=${maximumBytes}`)
    if (!response?.body) throw new Error("Workspace blob is unavailable")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > maximumBytes) throw new Error("Workspace object exceeds the read limit")
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    return WorkspaceTree.verify(hash, Buffer.concat(chunks, size), maximumBytes)
  }
}
