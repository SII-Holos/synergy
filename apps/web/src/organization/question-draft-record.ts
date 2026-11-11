import { z } from "zod"
import { OrganizationIdentity as Identity } from "@ericsanchezok/synergy-organization-protocol"
import type { QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import {
  QuestionDraftSchema,
  sanitizeQuestionDraft,
  type QuestionDraft,
} from "@/components/session/question-prompt-model"

export const OrganizationQuestionDraftOwner = z.strictObject({
  connectionKey: z.string().min(1),
  accountID: Identity.ID,
  projectID: Identity.ID,
})
export type OrganizationQuestionDraftOwner = z.infer<typeof OrganizationQuestionDraftOwner>
export const OrganizationQuestionDraftRecord = OrganizationQuestionDraftOwner.extend({
  version: z.literal(1),
  sourceSessionID: Identity.ID,
  requestID: Identity.ID,
  inputTypes: z.array(z.enum(["text", "password", "unknown"])),
  draft: QuestionDraftSchema,
}).strict()
export type OrganizationQuestionDraftRecord = z.infer<typeof OrganizationQuestionDraftRecord>
export const organizationQuestionDraftOwnerKey = (owner: OrganizationQuestionDraftOwner) => [
  owner.connectionKey,
  owner.accountID,
  owner.projectID,
]
export function prepareOrganizationQuestionDraft(
  owner: OrganizationQuestionDraftOwner,
  request: QuestionRequest,
  value: QuestionDraft,
): OrganizationQuestionDraftRecord {
  const policy = request.questions.map((question) => question.input_type ?? "text")
  const draft = sanitizeQuestionDraft(request, value)
  return OrganizationQuestionDraftRecord.parse({
    ...OrganizationQuestionDraftOwner.parse(owner),
    version: 1,
    sourceSessionID: request.sessionID,
    requestID: request.id,
    inputTypes: policy,
    draft: {
      ...draft,
      custom: draft.custom.map((text, index) => (policy[index] === "password" ? "" : text)),
      selections: draft.selections.map((selection, index) => (policy[index] === "password" ? [] : selection)),
      source: draft.source.map((source, index) => (policy[index] === "password" ? "custom" : source)),
    },
  })
}
export function restoreOrganizationQuestionDraft(
  owner: OrganizationQuestionDraftOwner,
  request: QuestionRequest,
  value: unknown,
): QuestionDraft {
  const record = OrganizationQuestionDraftRecord.parse(value)
  if (
    JSON.stringify(organizationQuestionDraftOwnerKey(OrganizationQuestionDraftOwner.parse(owner))) !==
      JSON.stringify(organizationQuestionDraftOwnerKey(record)) ||
    record.sourceSessionID !== request.sessionID ||
    record.requestID !== request.id
  )
    throw new Error("The saved answer belongs to another question")
  const draft = sanitizeQuestionDraft(request, record.draft)
  const allowed = (index: number) =>
    (request.questions[index]?.input_type ?? "text") === "text" && record.inputTypes[index] === "text"
  return {
    ...draft,
    custom: draft.custom.map((text, index) => (allowed(index) ? text : "")),
    selections: draft.selections.map((selection, index) => (allowed(index) ? selection : [])),
    source: draft.source.map((source, index) => (allowed(index) ? source : "custom")),
  }
}

export function importOrganizationQuestionDraft(
  owner: OrganizationQuestionDraftOwner,
  identity: readonly [string, string],
  value: unknown,
): OrganizationQuestionDraftRecord {
  const legacy = QuestionDraftSchema.extend({ inputTypes: z.array(z.enum(["text", "password"])) }).parse(value)
  const count = Math.max(legacy.custom.length, legacy.selections.length, legacy.source.length, legacy.inputTypes.length)
  const policy = Array.from({ length: count }, (_, index) => legacy.inputTypes[index] ?? "unknown")
  return OrganizationQuestionDraftRecord.parse({
    ...OrganizationQuestionDraftOwner.parse(owner),
    version: 1,
    sourceSessionID: identity[0],
    requestID: identity[1],
    inputTypes: policy,
    draft: {
      step: Math.min(legacy.step, Math.max(0, count - 1)),
      custom: policy.map((kind, index) => (kind === "text" ? (legacy.custom[index] ?? "") : "")),
      selections: policy.map((kind, index) => (kind === "text" ? (legacy.selections[index] ?? []) : [])),
      source: policy.map((kind, index) => (kind === "text" ? (legacy.source[index] ?? "option") : "custom")),
    },
  })
}
