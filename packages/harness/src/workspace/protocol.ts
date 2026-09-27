import { z } from "zod"
import { WorkspaceTree } from "./tree"

export namespace WorkspaceProtocol {
  const ID = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]*$/)
  export const Reference = z.object({ id: ID, workspaceID: ID, generation: z.number().int().positive() })
  export type Reference = z.infer<typeof Reference>
  export const MountInput = Reference.extend({
    readOnly: z.boolean().default(false),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("directory"), path: z.string().min(1) }),
      z.object({ kind: z.literal("materialized"), manifest: WorkspaceTree.Hash }),
    ]),
  })
  export type MountInput = z.infer<typeof MountInput>
  export const Mount = Reference.extend({ path: z.string(), readOnly: z.boolean(), physicalID: z.string() })
  export type Mount = z.infer<typeof Mount>
  export const CheckpointInput = z.object({ id: ID, mount: Reference, executionID: ID.optional() })
  export type CheckpointInput = z.infer<typeof CheckpointInput>
  export const Checkpoint = z.object({ id: ID, mount: Reference, manifest: WorkspaceTree.Hash })
  export type Checkpoint = z.infer<typeof Checkpoint>
  export const CheckpointStatus = z.object({
    id: ID,
    mount: Reference,
    state: z.enum(["pending", "failed", "saved", "released"]),
    checkpoint: Checkpoint.optional(),
    error: z.string().optional(),
  })
  export type CheckpointStatus = z.infer<typeof CheckpointStatus>
  export const ReadInput = z.object({
    mount: Reference,
    path: WorkspaceTree.Path,
    maximumBytes: z.number().int().nonnegative().max(WorkspaceTree.chunkBytes).default(WorkspaceTree.chunkBytes),
  })
  export type ReadInput = z.infer<typeof ReadInput>
  export const Read = z.object({
    data: z.string().max(WorkspaceTree.chunkBytes * 1.34),
    version: z.string(),
    size: z.number(),
    mode: z.number(),
  })
  export type Read = z.infer<typeof Read>
  export const WriteInput = z.object({
    id: ID,
    mount: Reference,
    path: WorkspaceTree.Path,
    data: z.string().max(WorkspaceTree.chunkBytes * 1.34),
    expectedVersion: z.string().nullable(),
  })
  export type WriteInput = z.infer<typeof WriteInput>
  export const Item = z.object({
    path: WorkspaceTree.Path,
    kind: z.enum(["file", "directory", "symlink"]),
    size: z.number().nonnegative(),
    mode: z.number(),
    mtime: z.number(),
  })
  export type Item = z.infer<typeof Item>
  export const Request = z.discriminatedUnion("action", [
    z.object({ action: z.literal("mount"), input: MountInput }),
    z.object({ action: z.literal("inspect"), mount: Reference }),
    z.object({ action: z.literal("detach"), mount: Reference }),
    z.object({ action: z.literal("read"), input: ReadInput }),
    z.object({ action: z.literal("list"), mount: Reference, path: z.union([WorkspaceTree.Path, z.literal("")]) }),
    z.object({ action: z.literal("write"), input: WriteInput }),
    z.object({ action: z.literal("checkpoint"), input: CheckpointInput }),
    z.object({ action: z.literal("acknowledge"), id: ID }),
    z.object({ action: z.literal("checkpointStatus"), id: ID }),
  ])
  export type Request = z.infer<typeof Request>
}

export interface WorkspaceFileHost {
  mount(input: WorkspaceProtocol.MountInput): Promise<WorkspaceProtocol.Mount>
  inspect(mount: WorkspaceProtocol.Reference): Promise<WorkspaceProtocol.Mount | undefined>
  detach(mount: WorkspaceProtocol.Reference): Promise<void>
  read(input: WorkspaceProtocol.ReadInput): Promise<WorkspaceProtocol.Read>
  list(mount: WorkspaceProtocol.Reference, path: string): Promise<WorkspaceProtocol.Item[]>
  write(input: WorkspaceProtocol.WriteInput): Promise<WorkspaceProtocol.Checkpoint>
  checkpoint(input: WorkspaceProtocol.CheckpointInput): Promise<WorkspaceProtocol.Checkpoint>
  acknowledge(id: string): Promise<void>
  checkpointStatus(id: string): Promise<WorkspaceProtocol.CheckpointStatus | undefined>
  putBlob(hash: string, bytes: Uint8Array): Promise<void>
  getBlob(hash: string, maximumBytes: number): Promise<Uint8Array>
}
