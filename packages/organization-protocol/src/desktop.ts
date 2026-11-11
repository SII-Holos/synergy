import { z } from "zod"
import { OrganizationClientAuth as Auth } from "./client-auth.js"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationLocalProjectProtocol as LocalProject } from "./local-project.js"
import { OrganizationReadProtocol as Read } from "./read.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationCommandStream as CommandStream } from "./command-stream.js"

export namespace OrganizationDesktop {
  export const ControlLimit = 65_536
  export const BinaryLimit = 4 * 1024 * 1024
  const Bytes = z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= BinaryLimit, "Binary chunk exceeds its bound")
  const Range = z
    .string()
    .max(100)
    .regex(/^bytes=\d+-\d+$/)
    .refine((value) => {
      const [start, end] = value.slice(6).split("-").map(Number)
      return (
        Number.isSafeInteger(start) && Number.isSafeInteger(end) && end! >= start! && end! - start! + 1 <= BinaryLimit
      )
    }, "A content range must select one bounded chunk")
  export const Connect = z.strictObject({
    issuer: Auth.Origin,
    clientID: Identity.ID,
    expected: z
      .strictObject({
        orgID: Identity.ID,
        deploymentIncarnation: Identity.ID,
        accountID: Identity.ID.optional(),
      })
      .optional(),
  })
  export type Connect = z.infer<typeof Connect>
  export const Connection = Auth.Authority.extend({
    id: Identity.Token,
    clientID: Identity.ID,
    account: Identity.Account,
    state: z.enum(["ready", "reauthorization_required", "sign_out_pending", "signed_out"]),
  })
  export type Connection = z.infer<typeof Connection>
  export const Request = z
    .strictObject({
      requestID: Identity.ID,
      connectionID: Identity.Token,
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
      path: z.string().min(1).max(8192),
      body: z.string().max(ControlLimit).optional(),
      bodyBytes: Bytes.optional(),
      contentType: z.literal("application/octet-stream").optional(),
      range: Range.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        (value.bodyBytes !== undefined && value.body !== undefined) ||
        (value.bodyBytes !== undefined) !== (value.contentType !== undefined) ||
        (value.range !== undefined &&
          (value.method !== "GET" || value.body !== undefined || value.bodyBytes !== undefined))
      )
        ctx.addIssue({ code: "custom", message: "Native content transfer fields are inconsistent" })
    })
  export type Request = z.infer<typeof Request>
  export const JsonResponse = z.strictObject({
    status: z.number().int().min(200).max(599),
    body: z.string().max(2_097_152),
  })
  export type JsonResponse = z.infer<typeof JsonResponse>
  export const Response = z.union([
    JsonResponse,
    z.strictObject({
      status: z.number().int().min(200).max(299),
      bodyBytes: Bytes,
      contentType: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/),
      contentRange: z
        .string()
        .max(120)
        .regex(/^bytes \d+-\d+\/\d+$/)
        .optional(),
    }),
  ])
  export type Response = z.infer<typeof Response>
  export const CommandStreamReply = z.union([
    CommandStream.Progress,
    z.strictObject({ kind: z.literal("response"), requestID: Identity.ID, response: JsonResponse }),
  ])
  export type CommandStreamReply = z.infer<typeof CommandStreamReply>
  export const Start = z.strictObject({ requestID: Identity.ID, target: Connect })
  export type Start = z.infer<typeof Start>
  export const Cancel = z.strictObject({ requestID: Identity.ID })
  export const Account = z.strictObject({ connectionID: Identity.Token })
  export const Download = Account.extend({
    requestID: Identity.ID,
    path: z.string().min(1).max(8192),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\x00-\x1f\x7f/\\]+$/)
      .refine((value) => value !== "." && value !== ".."),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  export type Download = z.infer<typeof Download>
  export const DownloadResult = z.strictObject({
    saved: z.boolean(),
    bytes: z.number().int().nonnegative().safe().optional(),
  })
  export type DownloadResult = z.infer<typeof DownloadResult>
  export const MemberStart = Account.extend({ requestID: Identity.ID })
  export const ProjectBinding = MemberStart.extend({ projectID: Identity.ID })
  export const ProjectBind = ProjectBinding.extend({ expectedRevision: LocalProject.Summary.shape.revision })
  export const ProjectBindingOutcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("ready"), summary: LocalProject.Summary }),
    z.strictObject({ kind: z.literal("revision_conflict"), current: LocalProject.Summary }),
  ])
  export type ProjectBindingOutcome = z.infer<typeof ProjectBindingOutcome>
  export const MemberRequest = MemberStart.extend({ query: Read.Query })
  export type MemberRequest = z.infer<typeof MemberRequest>
  export const ContentDownload = MemberRequest.extend({
    binding: Protocol.SessionBinding,
    reference: Read.Content,
    fileName: Download.shape.fileName,
  }).refine(
    (value) =>
      value.query.operation === "partContent" &&
      value.reference.kind === "native" &&
      value.query.offset === 0 &&
      value.query.version === value.reference.version &&
      value.query.field === value.reference.field,
    "Saving requires an exact complete field reference",
  )
  export type ContentDownload = z.infer<typeof ContentDownload>
  export const ContentDownloadOutcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), result: DownloadResult, original: z.enum(["complete", "partial"]) }),
    z.strictObject({
      kind: z.literal("preparing"),
      version: z.string().min(1).max(512),
      progress: z.strictObject({
        phase: z.enum(["queued", "materializing", "busy"]),
        bytes: z.number().int().nonnegative().safe(),
        totalBytes: z.number().int().nonnegative().safe().optional(),
      }),
    }),
  ])
  export type ContentDownloadOutcome = z.infer<typeof ContentDownloadOutcome>
  export const AttachmentDownload = MemberRequest.extend({
    binding: Protocol.SessionBinding,
  }).refine(
    (value) => value.query.operation === "attachmentContent" && value.query.offset === 0,
    "Saving requires an exact complete attachment target",
  )
  export type AttachmentDownload = z.infer<typeof AttachmentDownload>
  export const AttachmentDownloadOutcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), result: DownloadResult }),
    z.strictObject({
      kind: z.literal("unavailable"),
      version: z.string().min(1).max(512),
      reason: z.enum(["partial", "not_retained"]),
    }),
  ])
  export type AttachmentDownloadOutcome = z.infer<typeof AttachmentDownloadOutcome>
  export const MemberReadOutcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), result: Read.Result }),
    z.strictObject({ kind: z.literal("revision_conflict") }),
    z.strictObject({ kind: z.literal("not_found") }),
    z.strictObject({ kind: z.literal("binding_changed") }),
  ])
  export type MemberReadOutcome = z.infer<typeof MemberReadOutcome>
  export const MemberRuntime = Account.extend({
    state: z.enum(["stopped", "starting", "running", "failed"]),
    runtimeID: Identity.ID.optional(),
  })
  export type MemberRuntime = z.infer<typeof MemberRuntime>
  export const ErrorCode = z.enum([
    "invalid_request",
    "invalid_response",
    "identity_changed",
    "cancelled",
    "expired",
    "reauthorization_required",
    "signed_out",
    "revocation_pending",
    "credentials_unavailable",
    "credentials_invalid",
    "storage_unavailable",
    "unavailable",
    "untrusted_sender",
    "request_in_progress",
    "permission_denied",
  ])
  export type ErrorCode = z.infer<typeof ErrorCode>
  export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode } }
  export interface Bridge {
    list(): Promise<Result<Connection[]>>
    connect(input: Start): Promise<Result<Connection>>
    request(input: Request): Promise<Result<Response>>
    commandStream(input: CommandStream.Frame): Promise<Result<CommandStreamReply>>
    download(input: Download): Promise<Result<DownloadResult>>
    cancel(input: z.infer<typeof Cancel>): Promise<Result<void>>
    signOut(input: z.infer<typeof Account>): Promise<Result<Connection>>
    memberStatus(input: z.infer<typeof Account>): Promise<Result<MemberRuntime>>
    startMember(input: z.infer<typeof MemberStart>): Promise<Result<MemberRuntime>>
    projectBinding(input: z.infer<typeof ProjectBinding>): Promise<Result<ProjectBindingOutcome>>
    bindProject(input: z.infer<typeof ProjectBind>): Promise<Result<ProjectBindingOutcome>>
    memberRequest(input: z.infer<typeof MemberRequest>): Promise<Result<MemberReadOutcome>>
    downloadContent(input: ContentDownload): Promise<Result<ContentDownloadOutcome>>
    downloadAttachment(input: AttachmentDownload): Promise<Result<AttachmentDownloadOutcome>>
  }
}
