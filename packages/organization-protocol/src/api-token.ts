import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"

export namespace OrganizationApiTokenProtocol {
  export const Operation = z.enum([
    "sessions.read",
    "sessions.create",
    "sessions.input",
    "sessions.pause",
    "sessions.continue",
    "sessions.cancel",
    "sessions.reply",
    "sessions.configure",
    "resources.read",
    "artifacts.read",
  ])
  export type Operation = z.infer<typeof Operation>
  const Operations = z
    .array(Operation)
    .min(1)
    .max(Operation.options.length)
    .refine((items) => new Set(items).size === items.length, "Operations must be unique")
  export const Secret = z.string().regex(/^sy_api_[a-f0-9]{64}$/)
  export const Metadata = z
    .strictObject({
      tokenID: Identity.ID,
      orgID: Identity.ID,
      accountID: Identity.ID,
      projectID: Identity.ID,
      label: Identity.Name,
      operations: Operations,
      revision: Identity.Revision,
      createdAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
      revokedAt: z.number().int().nonnegative().optional(),
    })
    .meta({ ref: "OrgApiTokenMetadata" })
  export type Metadata = z.infer<typeof Metadata>
  export const Create = z
    .strictObject({
      requestID: Identity.ID,
      projectID: Identity.ID,
      label: Identity.Name,
      operations: Operations,
      expiresAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgApiTokenCreate" })
  export type Create = z.infer<typeof Create>
  export const Created = z
    .strictObject({
      metadata: Metadata,
      token: Secret.optional(),
      secretUnavailable: z.boolean(),
    })
    .refine(
      (value) => value.secretUnavailable === (value.token === undefined),
      "The secret is returned only at issuance",
    )
    .meta({ ref: "OrgApiTokenCreated" })
  export const Page = z
    .strictObject({ items: z.array(Metadata).max(100), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgApiTokenPage" })
  export const Revoke = z.strictObject({ expectedRevision: Identity.Revision }).meta({ ref: "OrgApiTokenRevoke" })
}
