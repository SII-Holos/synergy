import { z } from "zod"
import { createHash } from "node:crypto"
import {
  OrganizationCloudProtocol as Cloud,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

export namespace OrganizationCloudRecord {
  export function scopeID(orgID: string, projectID: string) {
    return `org_${createHash("sha256")
      .update(JSON.stringify([orgID, projectID]))
      .digest("hex")}`
  }
  export const Locator = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    projectID: Identity.ID,
    resourceID: Identity.ID,
    id: Identity.ID,
    name: Identity.Name,
  })
  export type Locator = z.infer<typeof Locator>
  export const Receipt = z.strictObject({ schemaVersion: z.literal(1), digest: z.string(), result: Cloud.Workspace })
  export const EnvironmentReceipt = z.strictObject({ schemaVersion: z.literal(1), digest: z.string(), id: Identity.ID })
  export const FileReceipt = z.strictObject({
    version: z.literal(1),
    digest: Cloud.Hash,
    reference: Cloud.FileReference,
    result: Cloud.FileResult,
  })
  export const key = (kind: "workspaces" | "environments", id: string) => ["organization", "cloud", kind, id]
  export const receiptKey = (workspaceID: string, operationID: string) => [
    "organization",
    "cloud",
    "receipts",
    workspaceID,
    operationID,
  ]
  export const creationKey = (kind: string, orgID: string, accountID: string, requestID: string) => [
    "organization",
    "cloud",
    "creation",
    kind,
    orgID,
    accountID,
    requestID,
  ]
  export const projectKey = (kind: string, orgID: string, projectID: string, resourceID: string) => [
    "organization",
    "cloud",
    "project",
    kind,
    orgID,
    projectID,
    resourceID,
  ]
}
