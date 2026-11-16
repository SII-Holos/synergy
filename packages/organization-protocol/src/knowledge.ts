import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationPublicationProtocol as Publication } from "./publication.js"
import { OrganizationExecutionProtocol as Execution } from "./execution.js"

export namespace OrganizationKnowledgeProtocol {
  export const Kind = z.enum(["material", "skill"])
  export const Item = z
    .strictObject({
      itemID: Identity.ID,
      orgID: Identity.ID,
      scope: Publication.Scope,
      kind: Kind,
      title: Identity.Name,
      authorID: Identity.ID,
      state: z.enum(["published", "withdrawn"]),
      revision: Identity.Revision,
      latestVersion: z.number().int().positive(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgKnowledgeItem" })
  export type Item = z.infer<typeof Item>
  export const Skill = z.strictObject({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().optional(),
  })
  export const Release = z
    .strictObject({
      itemID: Identity.ID,
      orgID: Identity.ID,
      scope: Publication.Scope,
      kind: Kind,
      title: Identity.Name,
      version: z.number().int().positive(),
      authorID: Identity.ID,
      author: Publication.Author.optional(),
      publishedAt: z.number().int().nonnegative(),
      manifestHash: Protocol.Digest,
      fileCount: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe(),
      skill: Skill.optional(),
    })
    .meta({ ref: "OrgKnowledgeRelease" })
  export type Release = z.infer<typeof Release>
  export const Publish = z.strictObject({
    requestID: Identity.ID,
    itemID: Identity.ID,
    expectedRevision: Identity.Revision,
    uploadID: Identity.ID,
    title: Identity.Name,
    kind: Kind,
  })
  export type Publish = z.infer<typeof Publish>
  export const PublicationReceipt = z
    .discriminatedUnion("state", [
      z.strictObject({ state: z.literal("missing") }),
      z.strictObject({ state: z.literal("published"), release: Release }),
    ])
    .meta({ ref: "OrgKnowledgePublicationReceipt" })
  export type PublicationReceipt = z.infer<typeof PublicationReceipt>
  export const Query = z.strictObject({
    projectID: Identity.ID.optional(),
    kind: Kind.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Identity.ID.optional(),
  })
  export const Search = Query.extend({ q: z.string().trim().min(1).max(256) })
  export const Page = z
    .strictObject({ items: z.array(Item), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgKnowledgePage" })
  export const VersionQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().positive().optional(),
  })
  export const VersionPage = z
    .strictObject({ items: z.array(Release), cursor: z.number().int().positive().optional() })
    .meta({ ref: "OrgKnowledgeVersionPage" })
  export const Reference = z.strictObject({
    itemID: Identity.ID,
    version: z.number().int().positive(),
    manifestHash: Protocol.Digest,
  })
  export type Reference = z.infer<typeof Reference>
  export const Apply = z
    .strictObject({ expectedRevision: Identity.Revision, releases: z.array(Reference) })
    .refine(
      (value) => new Set(value.releases.map((release) => release.itemID)).size === value.releases.length,
      "An applied manifest selects at most one version of each item",
    )
  export type Apply = z.infer<typeof Apply>
  export const Selection = z
    .strictObject({
      revision: Identity.Revision,
      manifestHash: Protocol.Digest,
      releases: z.array(Reference),
      updatedBy: Identity.ID,
      updatedAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgKnowledgeSelection" })
  export type Selection = z.infer<typeof Selection>
  export const Withdraw = z.strictObject({ expectedRevision: Identity.Revision })
  export const ExecutionQuery = z
    .strictObject({
      authority: Execution.DescriptionRequest,
      limit: z.number().int().min(1).max(100).default(50),
      cursor: Identity.ID.optional(),
      manifestHash: Protocol.Digest.optional(),
    })
    .meta({ ref: "OrgKnowledgeExecutionQuery" })
  export const ExecutionPage = z
    .strictObject({
      orgID: Identity.ID,
      projectID: Identity.ID,
      sessionID: Identity.ID,
      selection: Selection.omit({ releases: true }).extend({ releaseCount: z.number().int().nonnegative() }),
      items: z.array(Release),
      cursor: Identity.ID.optional(),
    })
    .meta({ ref: "OrgKnowledgeExecutionPage" })
  export type ExecutionPage = z.infer<typeof ExecutionPage>
  export const ExecutionFiles = z
    .strictObject({
      authority: Execution.DescriptionRequest,
      reference: Reference,
      activatedManifestHash: Protocol.Digest.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: Protocol.Digest.optional(),
    })
    .meta({ ref: "OrgKnowledgeExecutionFiles" })
  export const ExecutionContent = z
    .strictObject({
      authority: Execution.DescriptionRequest,
      reference: Reference,
      fileID: Protocol.Digest,
      activatedManifestHash: Protocol.Digest.optional(),
      offset: z.number().int().nonnegative().safe(),
      length: z
        .number()
        .int()
        .min(1)
        .max(128 * 1024),
    })
    .meta({ ref: "OrgKnowledgeExecutionContent" })
  export const ContentChunk = z
    .strictObject({
      fileID: Protocol.Digest,
      sha256: Protocol.Digest,
      offset: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe(),
      data: z
        .string()
        .regex(/^[A-Za-z0-9_-]*$/)
        .max(180_000),
    })
    .meta({ ref: "OrgKnowledgeContentChunk" })
  export type ContentChunk = z.infer<typeof ContentChunk>
  export const ActivationRequest = z
    .strictObject({
      authority: Execution.DescriptionRequest,
      manifestHash: Protocol.Digest,
      revision: Identity.Revision,
      outcome: z.enum(["activated", "failed"]).default("activated"),
    })
    .meta({ ref: "OrgKnowledgeActivationRequest" })
  export const ActivationReceipt = z
    .strictObject({
      orgID: Identity.ID,
      projectID: Identity.ID,
      sessionID: Identity.ID,
      manifestHash: Protocol.Digest,
      revision: Identity.Revision,
    })
    .meta({ ref: "OrgKnowledgeActivationReceipt" })
  export type ActivationReceipt = z.infer<typeof ActivationReceipt>
  export const SelectionSummary = Selection.omit({ releases: true })
    .extend({
      releaseCount: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgKnowledgeSelectionSummary" })
  export type SelectionSummary = z.infer<typeof SelectionSummary>
  export const SelectionPageQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: Identity.ID.optional(),
    manifestHash: Protocol.Digest.optional(),
  })
  export const SelectionReferences = z.strictObject({
    itemIDs: z.array(Identity.ID).max(100),
    manifestHash: Protocol.Digest.optional(),
  })
  export const SelectionPage = z
    .strictObject({ selection: SelectionSummary, items: z.array(Reference).max(100), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgKnowledgeSelectionPage" })
  export const SelectionTarget = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("member"), projectID: Identity.ID }),
    z.strictObject({ kind: z.literal("session"), sessionID: Identity.ID }),
  ])
  export type SelectionTarget = z.infer<typeof SelectionTarget>
  export const BeginSelectionUpdate = z.strictObject({
    requestID: Identity.ID,
    target: SelectionTarget,
    expectedRevision: Identity.Revision,
  })
  export const SelectionChange = z
    .strictObject({ itemID: Identity.ID, reference: Reference.optional() })
    .refine(
      (value) => !value.reference || value.reference.itemID === value.itemID,
      "Knowledge change identity must match its reference",
    )
  export const PatchSelectionUpdate = z
    .strictObject({ sequence: Identity.Revision, changes: z.array(SelectionChange).max(100) })
    .refine(
      (value) => new Set(value.changes.map((change) => change.itemID)).size === value.changes.length,
      "Each page may change an item only once",
    )
  export const CommitSelectionUpdate = z.strictObject({ expectedSequence: Identity.Revision })
  export const SelectionUpdate = z
    .strictObject({
      updateID: Identity.ID,
      target: SelectionTarget,
      baseRevision: Identity.Revision,
      nextSequence: Identity.Revision,
      state: z.enum(["draft", "committed"]),
      committed: SelectionSummary.optional(),
    })
    .meta({ ref: "OrgKnowledgeSelectionUpdate" })
  export const Status = z
    .strictObject({
      orgID: Identity.ID,
      projectID: Identity.ID,
      sessionID: Identity.ID,
      desired: SelectionSummary,
      activated: SelectionSummary.optional(),
      state: z.enum(["pending", "active", "failed"]),
      error: z.literal("update_failed").optional(),
    })
    .meta({ ref: "OrgKnowledgeStatus" })
  export const ActivatedQuery = z
    .strictObject({
      authority: Execution.DescriptionRequest,
      manifestHash: Protocol.Digest,
      limit: z.number().int().min(1).max(100).default(50),
      cursor: Identity.ID.optional(),
    })
    .meta({ ref: "OrgKnowledgeActivatedQuery" })
}
