import { z } from "zod"
import {
  OrganizationReadProtocol as Read,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSessionProtocol as SessionProtocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { RuntimeIdentity } from "./home"
import { OrganizationRuntimeError } from "./error"
import { observeSessionStatus } from "./session-status"
import { boundSessionSource } from "./session-source"

type ContentRead = Extract<Read.Result, { operation: "partContent" }>
type ContentResponse = ContentRead extends infer T
  ? T extends ContentRead
    ? Omit<T, "operation" | "rootSessionID" | "sourceSessionID" | "binding">
    : never
  : never
export type NativeContentReader = (
  query: Extract<Read.Query, { operation: "partContent" }>,
  source: Session.Info,
  signal?: AbortSignal,
) => Promise<ContentResponse>

function denied(message: string, code: "PERMISSION_DENIED" | "NOT_FOUND" = "PERMISSION_DENIED") {
  return new OrganizationRuntimeError({ code, message, outcome: "not_dispatched", retryable: false })
}

const safe = async (value: string, limit = 512) => (await SecretMask.apply(value)).slice(0, limit)
async function retainedSession(sessionID: string) {
  try {
    return await Session.get(sessionID)
  } catch (error) {
    if (error instanceof Storage.NotFoundError) return undefined
    throw error
  }
}

async function message(info: MessageV2.Info, version: string, order: string) {
  return Read.Message.parse({
    messageID: info.id,
    role: info.role,
    createdAt: info.time.created,
    summary: await safe(
      info.role === "user"
        ? (info.summary?.body ?? info.summary?.title ?? "")
        : (info.error?.name ?? info.finish ?? ""),
    ),
    actor: info.actor,
    agent: info.agent,
    rootID: info.rootID,
    model: info.role === "user" ? info.model : { providerID: info.providerID, modelID: info.modelID },
    ...(info.role === "assistant"
      ? {
          parentID: info.parentID,
          mode: info.mode,
          cost: info.cost,
          tokens: info.tokens,
          completedAt: info.time.completed,
          finish: info.finish,
          error: info.error && {
            code: info.error.name,
            message: await safe(
              "message" in info.error.data && typeof info.error.data.message === "string"
                ? info.error.data.message
                : info.error.name,
              2048,
            ),
          },
        }
      : {}),
    version,
    order,
  })
}

export function createSessionReader(options: {
  identity: RuntimeIdentity
  runtimeID: string
  content: NativeContentReader
}) {
  async function targets(query: Read.Query, subjectID: string, expected?: SessionProtocol.Binding) {
    const root = await retainedSession(query.rootSessionID)
    const binding = root?.organization
    if (!root || !binding) throw denied("Private Session not found", "NOT_FOUND")
    if (
      binding.orgID !== options.identity.orgID ||
      binding.projectID !== root.scope.id ||
      binding.driverRuntimeID !== options.runtimeID ||
      binding.creatorID !== subjectID
    )
      throw denied("Private reading requires the creator and current native binding")
    if (
      expected &&
      JSON.stringify(SessionProtocol.Binding.parse(binding)) !== JSON.stringify(SessionProtocol.Binding.parse(expected))
    )
      throw denied("Private reading authority belongs to another native binding")
    const source = await boundSessionSource(root, query.sourceSessionID)
    return { root, source }
  }

  async function read(query: Read.Query, subjectID: string, signal?: AbortSignal, expected?: Read.Permit) {
    signal?.throwIfAborted()
    const { root, source } = await targets(query, subjectID, expected ? Read.bindingFor(expected) : undefined)
    const scope = await Scope.fromID(source.scope.id)
    if (!scope) throw denied("Private Session Scope not found", "NOT_FOUND")
    const envelope = {
      rootSessionID: root.id,
      sourceSessionID: source.id,
      binding: SessionProtocol.Binding.parse(root.organization),
    }
    const result = await ScopeContext.provide({
      scope,
      workspace: null,
      async fn(): Promise<Read.Result> {
        switch (query.operation) {
          case "session":
            return {
              ...envelope,
              operation: "session",
              session: {
                sessionID: source.id,
                parentSessionID: source.parentID,
                title: await safe(source.title),
                createdAt: source.time.created,
                updatedAt: source.time.updated,
              },
            }
          case "timeline": {
            const page = await SessionHistory.timelinePage({
              sessionID: source.id,
              cursor: query.cursor,
              limit: query.limit,
            })
            return {
              ...envelope,
              operation: "timeline",
              items: await Promise.all(page.items.map((item) => message(item.info, item.version, item.order))),
              referencedRoots: await Promise.all(
                page.referencedRoots.map((item) => message(item.info, item.version, item.order)),
              ),
              cursor: page.nextCursor ?? undefined,
              hasMore: page.hasMore,
              total: page.total,
              generation: page.generation,
            }
          }
          case "parts": {
            const page = await SessionHistory.partPage({
              sessionID: source.id,
              messageID: query.messageID,
              cursor: query.cursor,
              limit: query.limit,
            })
            return {
              ...envelope,
              operation: "parts",
              messageID: query.messageID,
              items: await Promise.all(
                page.items.map(async (part) => ({
                  partID: part.id,
                  messageID: part.messageID,
                  type: part.type,
                  preview: await safe(part.preview),
                  render: part.render,
                  status: part.status,
                  tool: part.tool,
                  content: part.content,
                })),
              ),
              cursor: page.nextCursor ?? undefined,
              hasMore: page.hasMore,
              generation: page.generation,
            }
          }
          case "partContent":
            return { ...envelope, operation: "partContent", ...(await options.content(query, source, signal)) }
          case "status": {
            const status = await observeSessionStatus(source, options.identity.orgID, root.id)
            return { ...envelope, operation: "status", status }
          }
        }
      },
    })
    signal?.throwIfAborted()
    await targets(query, subjectID, envelope.binding)
    return Read.Result.parse(result)
  }

  return {
    async local(input: Read.Input, signal?: AbortSignal) {
      if (!("accountID" in options.identity)) throw denied("Local private reading requires a member creator")
      return read(Read.Query.parse(input), options.identity.accountID, signal)
    },
    async remote(input: Read.SignedPermit, connection: z.infer<typeof Runtime.Connected>, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const authorization = Read.SignedPermit.parse(input)
      const { permit } = authorization
      const authority = connection.signingIdentity
      if (
        permit.subjectID !== permit.creatorID ||
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
        !(await Read.verify(permit, authorization.signature, authority.publicKey))
      )
        throw denied("Private read authority is invalid or no longer current")
      const work = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(Math.max(1, permit.expiresAt - Date.now())),
      ])
      return read(permit.query, permit.subjectID, work, permit)
    },
  }
}
