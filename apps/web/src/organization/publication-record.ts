import { z } from "zod"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import {
  OrganizationArtifactProtocol as Artifact,
  OrganizationKnowledgeProtocol as Knowledge,
  OrganizationPublicationProtocol as Publication,
  OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { SpaceIdentity, spaceKey } from "@/context/space-state"

export const PublicationIdentity = SpaceIdentity.options[1]
export type PublicationIdentity = z.infer<typeof PublicationIdentity>
export const publicationScopeKey = (scope: Publication.Scope) =>
  scope.kind === "organization" ? "organization" : `project:${scope.projectID}`
const base = z.strictObject({
  version: z.literal(1),
  identity: PublicationIdentity,
  connectionKey: z.string().min(1).max(1024),
  scopeKey: z.string().min(1).max(256),
  upload: Publication.Upload,
  requestHash: Protocol.Digest,
  createdAt: z.number().int().nonnegative().safe(),
  attempt: z.number().int().nonnegative().safe(),
  uncertain: z.boolean(),
  state: z.enum(["prepared", "dispatching", "unknown", "not_dispatched"]),
})
const body = z.discriminatedUnion("purpose", [
  base.extend({ purpose: z.literal("knowledge"), request: Knowledge.Publish }),
  base.extend({ purpose: z.literal("artifact"), request: Artifact.Publish }),
])
export const PublicationRecord = body.superRefine((record, context) => {
  const upload = record.upload
  if (
    record.connectionKey !== spaceKey(record.identity) ||
    record.scopeKey !== publicationScopeKey(upload.scope) ||
    upload.orgID !== record.identity.orgID ||
    upload.authorID !== record.identity.accountID ||
    upload.purpose !== record.purpose ||
    upload.state !== "sealed" ||
    !upload.manifestHash ||
    upload.uploadID !== record.request.uploadID ||
    record.requestHash !== publicationRequestHash(record.request) ||
    (record.state === "prepared" ? record.attempt !== 0 || record.uncertain : record.attempt === 0) ||
    (record.state === "unknown" && !record.uncertain) ||
    (record.state === "not_dispatched" && record.uncertain) ||
    (record.purpose === "artifact" && (upload.scope.kind !== "project" || !upload.sourceSessionID))
  )
    context.addIssue({ code: "custom", message: "Publication metadata does not match its original source" })
})
export type PublicationRecord = z.infer<typeof PublicationRecord>
export function publicationRequestHash(request: Knowledge.Publish | Artifact.Publish) {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(request))))
}
export function preparePublicationRecord(input: {
  identity: PublicationIdentity
  source: { scope: Publication.Scope; sourceSessionID?: string }
  upload: Publication.Upload
  publication: { purpose: "knowledge"; request: Knowledge.Publish } | { purpose: "artifact"; request: Artifact.Publish }
  createdAt: number
}): PublicationRecord {
  const scope = Publication.Scope.parse(input.source.scope)
  if (
    publicationScopeKey(scope) !== publicationScopeKey(input.upload.scope) ||
    input.source.sourceSessionID !== input.upload.sourceSessionID
  )
    throw new Error("The sealed publication upload belongs to another source")
  const request =
    input.publication.purpose === "knowledge"
      ? Knowledge.Publish.parse(input.publication.request)
      : Artifact.Publish.parse(input.publication.request)
  return PublicationRecord.parse({
    version: 1,
    identity: input.identity,
    connectionKey: spaceKey(input.identity),
    scopeKey: publicationScopeKey(input.upload.scope),
    upload: input.upload,
    ...input.publication,
    request,
    requestHash: publicationRequestHash(request),
    createdAt: input.createdAt,
    attempt: 0,
    uncertain: false,
    state: "prepared",
  })
}
export function publicationAttempt(record: PublicationRecord): PublicationRecord {
  return PublicationRecord.parse({
    ...record,
    attempt: record.attempt + 1,
    uncertain: record.uncertain || record.state === "dispatching" || record.state === "unknown",
    state: "dispatching",
  })
}
export function publicationFailed(record: PublicationRecord, notDispatched: boolean): PublicationRecord {
  const uncertain = record.uncertain || !notDispatched
  return PublicationRecord.parse({ ...record, uncertain, state: uncertain ? "unknown" : "not_dispatched" })
}
export function publicationConfirmed(record: PublicationRecord, value: unknown) {
  const published = record.purpose === "knowledge" ? Knowledge.Release.parse(value) : Artifact.Version.parse(value)
  if (
    published.orgID !== record.identity.orgID ||
    published.authorID !== record.identity.accountID ||
    published.title !== record.request.title ||
    published.manifestHash !== record.upload.manifestHash ||
    published.fileCount !== record.upload.fileCount ||
    published.totalBytes !== record.upload.totalBytes ||
    (record.purpose === "knowledge"
      ? !("itemID" in published) ||
        published.itemID !== record.request.itemID ||
        published.kind !== record.request.kind ||
        publicationScopeKey(published.scope) !== record.scopeKey
      : !("artifactID" in published) ||
        published.artifactID !== record.request.artifactID ||
        record.upload.scope.kind !== "project" ||
        published.projectID !== record.upload.scope.projectID ||
        published.revision !== record.request.expectedRevision + 1)
  )
    throw new Error("The publication result does not match the original request")
  return published
}
