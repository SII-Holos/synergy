import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationExecutionProtocol as Execution } from "./execution.js"
import { SigningSignature, signedProtocol } from "./signature.js"
import { WorkspacePath } from "./workspace-path.js"
import { OrganizationHandoffProtocol as Handoff } from "./handoff.js"

export namespace OrganizationCloudProtocol {
  export const chunkBytes = 4 * 1024 * 1024
  export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Path = WorkspacePath
  export const Workspace = z
    .strictObject({
      workspaceID: Identity.ID,
      orgID: Identity.ID,
      projectID: Identity.ID,
      resourceID: Identity.ID,
      name: Identity.Name,
      revision: Identity.Revision,
      generation: z.number().int().positive().safe(),
      contentRevision: Identity.Revision,
      manifest: Hash.nullable(),
      activeMount: z.boolean(),
    })
    .meta({ ref: "OrgCloudWorkspace" })
  export type Workspace = z.infer<typeof Workspace>
  export const CreateWorkspace = z
    .strictObject({
      projectID: Identity.ID,
      resourceID: Identity.ID,
      requestID: Identity.ID,
      name: Identity.Name,
    })
    .meta({ ref: "OrgCloudWorkspaceCreate" })
  export type CreateWorkspace = z.infer<typeof CreateWorkspace>
  export const Read = z
    .strictObject({
      path: Path,
      offset: z.number().int().nonnegative().safe(),
      length: z.number().int().nonnegative().max(chunkBytes),
    })
    .meta({ ref: "OrgCloudWorkspaceRead" })
  export type Read = z.infer<typeof Read>
  export const Bytes = z
    .strictObject({
      data: z.string().max(Math.ceil(chunkBytes / 3) * 4),
      version: z.string(),
      size: z.number().int().nonnegative(),
      mode: z.number().int(),
    })
    .meta({ ref: "OrgCloudWorkspaceBytes" })
  export const Write = z
    .strictObject({
      operationID: Identity.ID,
      expectedRevision: Identity.Revision,
      path: Path,
      data: z.string().max(Math.ceil(chunkBytes / 3) * 4),
      expectedVersion: z.string().nullable(),
      mode: z.number().int().min(0).max(0o777).optional(),
    })
    .meta({ ref: "OrgCloudWorkspaceWrite" })
  export type Write = z.infer<typeof Write>
  export const WorkspacePage = z
    .strictObject({ items: z.array(Workspace), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgCloudWorkspacePage" })
  export const CreateEnvironment = z
    .strictObject({
      projectID: Identity.ID,
      resourceID: Identity.ID,
      requestID: Identity.ID,
      name: Identity.Name,
    })
    .meta({ ref: "OrgCloudEnvironmentCreate" })
  export type CreateEnvironment = z.infer<typeof CreateEnvironment>
  export const Environment = z
    .strictObject({
      environmentID: Identity.ID,
      orgID: Identity.ID,
      projectID: Identity.ID,
      resourceID: Identity.ID,
      name: Identity.Name,
      generation: z.number().int().nonnegative().safe(),
      state: z.enum(["idle", "allocating", "ready", "releasing", "unavailable"]),
      activeUses: z.number().int().nonnegative().safe(),
    })
    .meta({ ref: "OrgCloudEnvironment" })
  export type Environment = z.infer<typeof Environment>

  const RootPath = z.union([Path, z.literal("")])
  const FileBytes = z.string().max(Math.ceil((8 * 1024 * 1024) / 3) * 4)
  export const FileReference = z
    .strictObject({
      orgID: Identity.ID,
      projectID: Identity.ID,
      resourceID: Identity.ID,
      workspaceID: Identity.ID,
      generation: z.number().int().positive().safe(),
      revision: z.number().int().positive().safe(),
      rootPath: Path.optional(),
    })
    .meta({ ref: "OrgCloudFileReference" })
  export type FileReference = z.infer<typeof FileReference>
  export const FileLocator = z.strictObject({
    version: z.literal(1),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    projectID: Identity.ID,
    resourceID: Identity.ID,
    workspaceID: Identity.ID,
    generation: z.number().int().positive().safe(),
    path: Path,
    moveID: Identity.ID,
    mappingRevision: z.number().int().positive().safe(),
    workspaceMoveReceiptHash: Hash,
  })
  export type FileLocator = z.infer<typeof FileLocator>
  export const FileItem = z.strictObject({
    path: RootPath,
    entryVersion: z.string(),
    identity: z.string().optional(),
    ctime: z.number(),
    mtime: z.number(),
    kind: z.enum(["file", "directory", "symlink", "unknown"]),
    size: z.number().nonnegative(),
    mode: z.number().int(),
  })
  export const FileChange = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("replace"),
      path: Path,
      data: FileBytes,
      mode: z.enum(["100644", "100755", "120000"]),
      expectedVersion: z.string().nullable(),
      expectedContentVersion: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal("mkdir"),
      path: Path,
      createParents: z.boolean().optional(),
      mode: z.number().int().min(0).max(0o777).optional(),
    }),
    z.strictObject({
      kind: z.literal("remove"),
      path: Path,
      expectedVersion: z.string(),
      recursive: z.boolean().optional(),
    }),
    z.strictObject({ kind: z.literal("move"), from: Path, to: Path, expectedVersion: z.string() }),
    z.strictObject({ kind: z.literal("copy"), from: Path, to: Path, expectedVersion: z.string() }),
  ])
  export const FileOperation = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("describe") }),
    z.strictObject({ action: z.literal("canonical"), path: RootPath, follow: z.boolean() }),
    z.strictObject({ action: z.literal("stat"), path: RootPath, follow: z.boolean().optional() }),
    z.strictObject({
      action: z.literal("list"),
      path: RootPath,
      cursor: Path.optional(),
      revision: z.number().int().positive().safe().optional(),
      limit: z.number().int().min(1).max(128).default(128),
    }),
    z.strictObject({
      action: z.literal("read"),
      path: Path,
      offset: z.number().int().nonnegative().safe().default(0),
      maximumBytes: z.number().int().nonnegative().max(chunkBytes).default(chunkBytes),
      expectedVersion: z.string().optional(),
    }),
    z.strictObject({
      action: z.literal("write"),
      id: Identity.ID,
      path: Path,
      data: FileBytes,
      expectedVersion: z.string().nullable(),
      expectedEntryVersion: z.string().nullable().optional(),
      protectSensitive: z.boolean().optional(),
      mode: z.number().int().min(0).max(0o777).optional(),
    }),
    z.strictObject({
      action: z.literal("mutate"),
      id: Identity.ID,
      change: FileChange,
      protectSensitive: z.boolean().optional(),
    }),
    z.strictObject({ action: z.literal("receipt"), id: Identity.ID }),
    z.strictObject({ action: z.literal("acknowledge"), id: Identity.ID }),
  ])
  export type FileOperation = z.infer<typeof FileOperation>
  export const LocalFileRequest = z
    .strictObject({ reference: FileReference.optional(), operation: FileOperation })
    .refine(
      (value) => value.operation.action === "describe" || value.reference !== undefined,
      "File operations require their original Workspace version",
    )
    .meta({ ref: "OrgCloudLocalFileRequest" })
  export type LocalFileRequest = z.infer<typeof LocalFileRequest>
  export const FileProof = z
    .strictObject({
      purpose: z.literal("organization-workspace-file"),
      authority: Execution.BindingRequest,
      reference: FileReference.optional(),
      operation: FileOperation,
    })
    .refine(
      (value) => value.operation.action === "describe" || value.reference !== undefined,
      "File operations require their original Workspace version",
    )
  export type FileProof = z.infer<typeof FileProof>
  export const FileRequest = z
    .strictObject({ proof: FileProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudFileRequest" })
  export type FileRequest = z.infer<typeof FileRequest>
  const signedFiles = signedProtocol(FileProof, "synergy.organization.workspace.file.v1\n")
  export const signFile = signedFiles.sign
  export const verifyFile = signedFiles.verify
  export const FileInspectionProof = z.strictObject({
    purpose: z.literal("organization-workspace-file-inspection"),
    authority: Execution.InspectionRequest,
    reference: FileReference,
    operation: z.discriminatedUnion("action", [
      z.strictObject({ action: z.literal("receipt"), id: Identity.ID }),
      z.strictObject({ action: z.literal("acknowledge"), id: Identity.ID }),
    ]),
  })
  export type FileInspectionProof = z.infer<typeof FileInspectionProof>
  export const FileInspectionRequest = z
    .strictObject({ proof: FileInspectionProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudFileInspectionRequest" })
  export type FileInspectionRequest = z.infer<typeof FileInspectionRequest>
  const signedFileInspection = signedProtocol(
    FileInspectionProof,
    "synergy.organization.workspace.file.inspection.v1\n",
  )
  export const signFileInspection = signedFileInspection.sign
  export const verifyFileInspection = signedFileInspection.verify
  const FileMount = z.strictObject({
    id: Identity.ID,
    workspaceID: Identity.ID,
    generation: z.number().int().positive().safe(),
  })
  export const FileCheckpoint = z.strictObject({
    id: Identity.ID,
    mount: FileMount,
    manifest: Hash.nullable(),
    beforeManifest: Hash.optional(),
    isolated: z.boolean().optional(),
  })
  export const FileStatus = z.strictObject({
    id: Identity.ID,
    mount: FileMount,
    state: z.enum(["pending", "failed", "saved", "released"]),
    checkpoint: FileCheckpoint.optional(),
    error: z.string().optional(),
  })
  export const FileResult = z
    .strictObject({
      reference: FileReference,
      result: z.discriminatedUnion("action", [
        z.strictObject({ action: z.literal("describe") }),
        z.strictObject({ action: z.literal("canonical"), path: RootPath }),
        z.strictObject({ action: z.literal("stat"), item: FileItem.optional() }),
        z.strictObject({
          action: z.literal("list"),
          items: z.array(FileItem).max(128),
          cursor: Path.optional(),
          revision: z.number().int().positive().safe(),
        }),
        z.strictObject({
          action: z.literal("read"),
          data: z.string().max(Math.ceil(chunkBytes / 3) * 4),
          version: z.string(),
          size: z.number().int().nonnegative().safe(),
          mode: z.number().int(),
        }),
        z.strictObject({ action: z.literal("write"), checkpoint: FileCheckpoint }),
        z.strictObject({ action: z.literal("mutate"), checkpoint: FileCheckpoint }),
        z.strictObject({ action: z.literal("receipt"), status: FileStatus.optional() }),
        z.strictObject({ action: z.literal("acknowledge"), id: Identity.ID }),
      ]),
    })
    .meta({ ref: "OrgCloudFileResult" })
  export type FileResult = z.infer<typeof FileResult>
  export const HandoffWorkspaceOperation = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("put"), hash: Hash, data: z.string().max(Math.ceil(chunkBytes / 3) * 4) }),
    z.strictObject({ action: z.literal("publish"), source: z.json() }),
    z.strictObject({ action: z.literal("inspect") }),
    z.strictObject({ action: z.literal("validate") }),
  ])
  export type HandoffWorkspaceOperation = z.infer<typeof HandoffWorkspaceOperation>
  export const HandoffWorkspaceProof = Handoff.Binding.extend({
    purpose: z.literal("handoff-workspace"),
    runtimeID: Identity.ID,
    connectionEpoch: z.number().int().positive().safe(),
    mappingHash: Hash,
    operation: HandoffWorkspaceOperation,
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
  })
    .refine(
      (value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 30_000,
      "Workspace handoff requests have a finite signing window",
    )
    .refine(
      (value) =>
        value.operation.action === "validate"
          ? value.runtimeID === value.targetRuntimeID
          : value.operation.action === "inspect"
            ? [value.sourceRuntimeID, value.targetRuntimeID].includes(value.runtimeID)
            : value.runtimeID === value.sourceRuntimeID,
      "Workspace handoff requests bind their actual participant",
    )
  export type HandoffWorkspaceProof = z.infer<typeof HandoffWorkspaceProof>
  export const HandoffWorkspaceRequest = z
    .strictObject({ proof: HandoffWorkspaceProof, signature: SigningSignature })
    .meta({ ref: "OrgHandoffWorkspaceRequest" })
  export type HandoffWorkspaceRequest = z.infer<typeof HandoffWorkspaceRequest>
  const signedHandoffWorkspace = signedProtocol(HandoffWorkspaceProof, "synergy.organization.handoff.workspace.v1\n")
  export const signHandoffWorkspace = signedHandoffWorkspace.sign
  export const verifyHandoffWorkspace = signedHandoffWorkspace.verify
  export const HandoffWorkspaceResult = z
    .discriminatedUnion("action", [
      z.strictObject({ action: z.literal("put"), hash: Hash }),
      z.strictObject({ action: z.literal("publish"), receipt: z.json() }),
      z.strictObject({ action: z.literal("inspect"), status: z.json().optional() }),
      z.strictObject({ action: z.literal("validate"), receipt: z.json() }),
    ])
    .meta({ ref: "OrgHandoffWorkspaceResult" })
  export type HandoffWorkspaceResult = z.infer<typeof HandoffWorkspaceResult>
}
