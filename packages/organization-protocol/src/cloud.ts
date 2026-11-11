import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"

export namespace OrganizationCloudProtocol {
  export const chunkBytes = 4 * 1024 * 1024
  export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Path = z.string().min(1).max(4096).refine(value =>
    !value.includes("\\") && !/[\x00-\x1f]/.test(value) && !value.startsWith("/") &&
    !value.split("/").some(part => !part || part === "." || part === "..") && !/^[a-zA-Z]:/.test(value),
  "Expected a relative Workspace path")
  export const Workspace = z.strictObject({
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
  }).meta({ ref: "OrgCloudWorkspace" })
  export type Workspace = z.infer<typeof Workspace>
  export const CreateWorkspace = z.strictObject({
    projectID: Identity.ID, resourceID: Identity.ID, requestID: Identity.ID, name: Identity.Name,
  }).meta({ ref: "OrgCloudWorkspaceCreate" })
  export type CreateWorkspace = z.infer<typeof CreateWorkspace>
  export const Read = z.strictObject({
    path: Path, offset: z.number().int().nonnegative().safe(), length: z.number().int().nonnegative().max(chunkBytes),
  }).meta({ ref: "OrgCloudWorkspaceRead" })
  export type Read = z.infer<typeof Read>
  export const Bytes = z.strictObject({
    data: z.string().max(Math.ceil(chunkBytes / 3) * 4), version: z.string(), size: z.number().int().nonnegative(), mode: z.number().int(),
  }).meta({ ref: "OrgCloudWorkspaceBytes" })
  export const Write = z.strictObject({
    operationID: Identity.ID, expectedRevision: Identity.Revision, path: Path,
    data: z.string().max(Math.ceil(chunkBytes / 3) * 4), expectedVersion: z.string().nullable(),
    mode: z.number().int().min(0).max(0o777).optional(),
  }).meta({ ref: "OrgCloudWorkspaceWrite" })
  export type Write = z.infer<typeof Write>
  export const WorkspacePage = z.strictObject({ items: z.array(Workspace), cursor: Identity.ID.optional() }).meta({ ref: "OrgCloudWorkspacePage" })
  export const CreateEnvironment = z.strictObject({
    projectID: Identity.ID, resourceID: Identity.ID, requestID: Identity.ID, name: Identity.Name,
  }).meta({ ref: "OrgCloudEnvironmentCreate" })
  export type CreateEnvironment = z.infer<typeof CreateEnvironment>
  export const Environment = z.strictObject({
    environmentID: Identity.ID, orgID: Identity.ID, projectID: Identity.ID, resourceID: Identity.ID, name: Identity.Name,
    generation: z.number().int().nonnegative().safe(), state: z.enum(["idle", "allocating", "ready", "releasing", "unavailable"]),
    activeUses: z.number().int().nonnegative().safe(),
  }).meta({ ref: "OrgCloudEnvironment" })
  export type Environment = z.infer<typeof Environment>
}
