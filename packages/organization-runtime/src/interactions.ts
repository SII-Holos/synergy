import { z } from "zod"
import {
  OrganizationInteractionProtocol as Protocol,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSessionProtocol as Sessions,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { SessionDecisionReceipts } from "@ericsanchezok/synergy-harness/session/decision-receipts"
import { SessionPendingWindow } from "@ericsanchezok/synergy-harness/session/pending-window"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { boundSessionSource } from "./session-source"
import type { RuntimeIdentity } from "./home"
import { OrganizationRuntimeError } from "./error"

const Cursor = z.strictObject({
  rootSessionID: z.string(),
  sourceSessionID: z.string(),
  viewID: z.string(),
  after: z.number().int().nonnegative().safe(),
})
function fail(
  code: "PERMISSION_DENIED" | "REVISION_CONFLICT" | "INVALID_REQUEST" | "RESOURCE_UNAVAILABLE",
  message: string,
): never {
  throw new OrganizationRuntimeError({ code, message, outcome: "not_dispatched", retryable: false })
}
function cursor(value: string | undefined) {
  if (!value) return
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
  } catch {
    return fail("INVALID_REQUEST", "Pending interaction cursor is invalid")
  }
}
async function pending(entry: PermissionNext.PendingRequest | Question.Request): Promise<Protocol.Pending> {
  const tool = entry.tool
  if ("permission" in entry)
    return Protocol.Pending.parse({
      kind: "permission",
      requestID: entry.id,
      sourceSessionID: entry.sessionID,
      permission: await SecretMask.apply(entry.permission),
      patterns: await Promise.all(entry.patterns.map((value) => SecretMask.apply(value))),
      tool,
      alwaysScope: "runtime",
    })
  return Protocol.Pending.parse({
    kind: "question",
    requestID: entry.id,
    sourceSessionID: entry.sessionID,
    tool,
    timeout: entry.timeout,
    createdAt: entry.createdAt,
    questions: await Promise.all(
      entry.questions.map(async (question) => ({
        ...question,
        question: await SecretMask.apply(question.question),
        header: await SecretMask.apply(question.header),
        options: await Promise.all(
          question.options.map(async (option) => ({
            label: await SecretMask.apply(option.label),
            description: await SecretMask.apply(option.description),
          })),
        ),
      })),
    ),
  })
}
export function createInteractionReader(options: { identity: RuntimeIdentity; runtimeID: string }) {
  async function source(permit: Protocol.Permit) {
    const root = await Session.get(permit.query.rootSessionID)
    if (JSON.stringify(Sessions.Binding.parse(root.organization)) !== JSON.stringify(permit.binding))
      fail("REVISION_CONFLICT", "Interaction binding changed")
    return { root, source: await boundSessionSource(root, permit.query.sourceSessionID) }
  }
  return {
    async remote(
      input: Protocol.SignedPermit,
      connection: z.infer<typeof Runtime.Connected>,
      signal?: AbortSignal,
    ): Promise<Protocol.Result> {
      const authorization = Protocol.SignedPermit.parse(input)
      const { permit } = authorization
      const authority = connection.signingIdentity
      if (
        permit.orgID !== options.identity.orgID ||
        permit.orgID !== connection.orgID ||
        permit.runtimeID !== options.runtimeID ||
        permit.runtimeID !== connection.runtimeID ||
        permit.deploymentIncarnation !== connection.deploymentIncarnation ||
        authority.orgID !== connection.orgID ||
        authority.deploymentIncarnation !== connection.deploymentIncarnation ||
        authority.keyID !== permit.keyID ||
        permit.connectionEpoch !== connection.connectionEpoch ||
        permit.issuedAt > Date.now() + 1000 ||
        permit.expiresAt <= Date.now() ||
        !(await Protocol.verify(permit, authorization.signature, authority.publicKey))
      )
        fail("PERMISSION_DENIED", "Interaction read authority is invalid or no longer current")
      const work = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(Math.max(1, permit.expiresAt - Date.now())),
      ])
      work.throwIfAborted()
      const current = await source(permit)
      const envelope = {
        rootSessionID: current.root.id,
        sourceSessionID: current.source.id,
        binding: permit.binding,
        runtimeKind: "accountID" in options.identity ? ("member" as const) : ("hosted" as const),
      }
      const result = await ScopeContext.provide({
        scope: current.source.scope,
        workspace: null,
        fn: async (): Promise<Protocol.Result> => {
          const query = permit.query
          if (query.operation === "decisions") {
            const items: z.infer<typeof Protocol.Decision>[] = []
            for (const identity of query.identities) {
              work.throwIfAborted()
              const target = { sessionID: current.source.id, requestID: identity.requestID }
              const receipt = await SessionDecisionReceipts.read({ ...target, kind: identity.kind })
              if (receipt) {
                items.push({
                  identity,
                  state: "resolved",
                  winner: Protocol.Winner.parse({
                    sessionID: receipt.sessionID,
                    requestID: receipt.requestID,
                    actor: receipt.actor,
                    decidedAt: receipt.decidedAt,
                    outcome:
                      receipt.outcome.kind === "permission"
                        ? receipt.outcome
                        : { kind: "question", reply: receipt.outcome.reply },
                  }),
                })
                continue
              }
              const retained =
                identity.kind === "permission"
                  ? await PermissionNext.hasPending(target)
                  : await Question.hasPending(target)
              items.push({ identity, state: retained ? "pending" : "expired" })
            }
            return { ...envelope, operation: "decisions", items }
          }
          const after = cursor(query.cursor)
          if (after && (after.rootSessionID !== current.root.id || after.sourceSessionID !== current.source.id))
            fail("INVALID_REQUEST", "Pending cursor belongs to another source")
          const input = { sessionID: current.source.id, after: after?.after, viewID: after?.viewID, limit: query.limit }
          let permissions: Awaited<ReturnType<typeof PermissionNext.pendingPage>>
          let questions: Awaited<ReturnType<typeof Question.pendingPage>>
          try {
            ;[permissions, questions] = await Promise.all([
              PermissionNext.pendingPage(input),
              Question.pendingPage(input),
            ])
          } catch (error) {
            if (SessionPendingWindow.Changed.isInstance(error))
              return fail("REVISION_CONFLICT", "Native pending interaction view changed")
            throw error
          }
          if (permissions.viewID !== questions.viewID)
            fail("REVISION_CONFLICT", "Native pending interaction view changed")
          const selected = [...permissions.items, ...questions.items].sort((a, b) => a.ordinal - b.ordinal)
          const rows = selected.slice(0, query.limit)
          const hasMore = permissions.hasMore || questions.hasMore || selected.length > rows.length
          return {
            ...envelope,
            operation: "pending",
            items: await Promise.all(rows.map((entry) => pending(entry.info))),
            hasMore,
            ...(hasMore
              ? {
                  cursor: Buffer.from(
                    JSON.stringify(
                      Cursor.parse({
                        rootSessionID: current.root.id,
                        sourceSessionID: current.source.id,
                        viewID: permissions.viewID,
                        after: rows.at(-1)!.ordinal,
                      }),
                    ),
                  ).toString("base64url"),
                }
              : {}),
          }
        },
      })
      work.throwIfAborted()
      await source(permit)
      if (!Protocol.matches(permit.query, result, permit.binding))
        fail("RESOURCE_UNAVAILABLE", "Interaction content cannot fit the supported response window")
      return Protocol.Result.parse(result)
    },
  }
}
