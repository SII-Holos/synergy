import z from "zod"
import { Bus } from "@/bus"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { Dag } from "./dag"
import { Todo } from "./todo"
import { SessionExport } from "./session-export"
import { SessionEvent } from "./event"
import { SessionNav } from "./nav"
import { Log } from "@/util/log"

export namespace SessionImport {
  const log = Log.create({ service: "session-import" })

  function checkScopeMismatch(report: SessionExport.Report, targetScope: Scope): void {
    const sourceScopes = collectSourceScopes(report)
    if (sourceScopes.size === 0) return

    const targetType = targetScope.type
    const targetID = targetScope.id
    for (const [scopeID, source] of sourceScopes) {
      if (scopeID !== "unknown" && scopeID !== targetID) {
        throw new Error(
          `Cannot import session from scope "${scopeID}" into scope "${targetID}". ` +
            `Session import only supports importing back into the same scope.`,
        )
      }
      if (source.type && source.type !== targetType) {
        throw new Error(
          `Cannot import session from a "${source.type}" scope (${scopeID}) into a "${targetType}" scope. ` +
            `Session import only supports same-type scopes.`,
        )
      }
    }
  }

  function collectDirectoryWarnings(report: SessionExport.Report, targetScope: Scope): string[] {
    const warnings: string[] = []
    const sourceScopes = collectSourceScopes(report)
    if (sourceScopes.size === 0) return warnings

    const targetDir = targetScope.directory
    for (const [scopeID, source] of sourceScopes) {
      if (source.directory && source.directory !== targetDir) {
        warnings.push(
          `Session originally used directory "${source.directory}" but the target scope directory is "${targetDir}" (scope ${scopeID}). Relative paths in tool results may be incorrect.`,
        )
      }
    }
    return warnings
  }

  function collectSourceScopes(report: SessionExport.Report): Map<string, { type: string; directory: string }> {
    const scopes = new Map<string, { type: string; directory: string }>()
    for (const session of report.sessions) {
      const scope = session.info.scope as Scope | undefined
      if (!scope) continue
      const id = scope.id ?? "unknown"
      if (scopes.has(id)) continue
      scopes.set(id, { type: scope.type, directory: scope.directory ?? "" })
    }
    return scopes
  }
  const LegacyExport = z.object({
    info: Session.Info,
    messages: z.array(MessageV2.WithParts),
  })

  export const ImportedSession = z
    .object({
      sourceSessionID: z.string(),
      session: Session.Info,
    })
    .meta({ ref: "SessionImportImportedSession" })
  export type ImportedSession = z.infer<typeof ImportedSession>

  export const Result = z
    .object({
      rootSessionID: z.string(),
      sessions: z.array(ImportedSession),
      sessionCount: z.number(),
      messageCount: z.number(),
      warnings: z.array(z.string()),
    })
    .meta({ ref: "SessionImportResult" })
  export type Result = z.infer<typeof Result>

  export function parse(data: ArrayBuffer | Uint8Array): SessionExport.Report {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const body = isGzip(bytes) ? Bun.gunzipSync(toArrayBuffer(bytes)) : bytes
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(body))
    } catch (error) {
      throw new Error(`Invalid session import JSON: ${error instanceof Error ? error.message : String(error)}`)
    }

    const report = SessionExport.Report.safeParse(raw)
    if (report.success) return report.data

    const legacy = LegacyExport.safeParse(raw)
    if (legacy.success) {
      return {
        version: 1,
        generatedAt: Date.now(),
        synergyVersion: legacy.data.info.version,
        mode: "full",
        rootSessionID: legacy.data.info.id,
        sessions: [
          {
            info: legacy.data.info,
            messages: legacy.data.messages,
            dag: [],
            todos: [],
            diffs: [],
          },
        ],
      }
    }

    throw new Error("Unsupported session import format")
  }

  export async function fromBuffer(data: ArrayBuffer | Uint8Array): Promise<Result> {
    return fromReport(parse(data))
  }

  export async function fromReport(report: SessionExport.Report): Promise<Result> {
    if (report.sessions.length === 0) throw new Error("Session import report does not contain any sessions")

    const scope = ScopeContext.current.scope
    checkScopeMismatch(report, scope)
    const warnings = collectDirectoryWarnings(report, scope)
    if (warnings.length > 0) {
      for (const warning of warnings) {
        log.warn(warning)
      }
    }

    const scopeID = Identifier.asScopeID(scope.id)
    const idMap = new Map(report.sessions.map((data) => [data.info.id, Identifier.descending("session")]))
    const ordered = orderSessions(report)
    const imported: ImportedSession[] = []
    let messageCount = 0

    for (const data of ordered) {
      const sessionID = idMap.get(data.info.id)!
      const parentID = data.info.parentID ? idMap.get(data.info.parentID) : undefined
      const info = normalizeSessionInfo({ info: data.info, sessionID, parentID, scope, idMap })

      await Session.create({
        scope,
        id: sessionID,
        parentID,
        title: info.title,
        permission: info.permission,
        controlProfile: info.controlProfile,
        preAuthorizedActions: info.preAuthorizedActions,
        interaction: info.interaction,
        cortex: info.cortex,
        superplan: info.superplan,
        workspace: info.workspace,
        forkedFrom: info.forkedFrom,
        completionNotice: info.completionNotice,
      })
      await writeSessionInfo(scopeID, info)

      for (const message of data.messages) {
        const nextMessage = remapMessage(message.info, sessionID, idMap)
        await Session.updateMessage(nextMessage)
        messageCount++

        for (const part of message.parts) {
          await Session.updatePart(remapPart(part, sessionID, message.info.id, idMap))
        }
      }

      const dag = data.dag.map((node) => ({
        ...node,
        session_id: node.session_id ? (idMap.get(node.session_id) ?? node.session_id) : undefined,
      }))
      if (dag.length > 0) await Dag.update({ sessionID, nodes: dag })
      if (data.todos.length > 0) await Todo.update({ sessionID, todos: data.todos })
      if (data.diffs.length > 0) {
        await Storage.write(StoragePath.sessionSummary(scopeID, Identifier.asSessionID(sessionID)), data.diffs)
      }

      imported.push({ sourceSessionID: data.info.id, session: info })
    }

    const navIndex = await SessionNav.buildNavIndex(scope.id)
    for (const item of imported) {
      Bus.publish(SessionEvent.Updated, {
        info: await Session.withRuntimeInfo(item.session),
        navEntry: navIndex.entries.find((entry) => entry.id === item.session.id),
      })
    }

    const rootSessionID = idMap.get(report.rootSessionID) ?? imported[0]?.session.id
    if (!rootSessionID) throw new Error("Session import did not create a root session")
    return {
      rootSessionID,
      sessions: imported,
      sessionCount: imported.length,
      messageCount,
      warnings,
    }
  }

  function isGzip(bytes: Uint8Array) {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  }

  function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  function orderSessions(report: SessionExport.Report): SessionExport.SessionData[] {
    const byID = new Map(report.sessions.map((session) => [session.info.id, session]))
    const children = new Map<string, SessionExport.SessionData[]>()
    for (const session of report.sessions) {
      const parentID = session.info.parentID
      if (!parentID || !byID.has(parentID)) continue
      const list = children.get(parentID) ?? []
      list.push(session)
      children.set(parentID, list)
    }

    const seen = new Set<string>()
    const ordered: SessionExport.SessionData[] = []
    const visit = (sessionID: string) => {
      if (seen.has(sessionID)) return
      const session = byID.get(sessionID)
      if (!session) return
      seen.add(sessionID)
      ordered.push(session)
      for (const child of children.get(sessionID) ?? []) {
        visit(child.info.id)
      }
    }

    visit(report.rootSessionID)
    for (const session of report.sessions) {
      visit(session.info.id)
    }
    return ordered
  }

  function normalizeSessionInfo(input: {
    info: Session.Info
    sessionID: string
    parentID?: string
    scope: Scope
    idMap: Map<string, string>
  }): Session.Info {
    const scopeType = input.scope.type === "home" ? "home" : "project"
    const workspace = {
      type: "main",
      path: input.scope.directory,
      scopeID: input.scope.id,
    }
    const cortex = input.info.cortex
      ? {
          ...input.info.cortex,
          parentSessionID: input.idMap.get(input.info.cortex.parentSessionID) ?? input.info.cortex.parentSessionID,
        }
      : undefined
    const forkedFrom = input.info.forkedFrom
      ? {
          ...input.info.forkedFrom,
          sessionID: input.idMap.get(input.info.forkedFrom.sessionID) ?? input.info.forkedFrom.sessionID,
        }
      : undefined
    const time = {
      ...input.info.time,
      compacting: undefined,
    }

    return Session.Info.parse({
      ...input.info,
      id: input.sessionID,
      scope: input.scope,
      parentID: input.parentID,
      forkedFrom,
      category: SessionNav.deriveCategory({ scopeType, parentID: input.parentID, cortex }),
      endpoint: undefined,
      agenda: undefined,
      pendingReply: undefined,
      cortex,
      workspace,
      time,
    })
  }

  function remapMessage(info: MessageV2.Info, sessionID: string, idMap: Map<string, string>): MessageV2.Info {
    const metadata = info.metadata ? (remapSessionIDs(info.metadata, idMap) as Record<string, any>) : undefined
    if (info.role === "assistant") {
      return {
        ...info,
        sessionID,
        metadata,
      }
    }

    return {
      ...info,
      sessionID,
      origin: info.origin?.sessionID
        ? {
            ...info.origin,
            sessionID: idMap.get(info.origin.sessionID) ?? info.origin.sessionID,
          }
        : info.origin,
      metadata,
    }
  }

  function remapPart(
    part: MessageV2.Part,
    sessionID: string,
    messageID: string,
    idMap: Map<string, string>,
  ): MessageV2.Part {
    const next = {
      ...part,
      sessionID,
      messageID,
    } as MessageV2.Part
    if ("metadata" in next && next.metadata) {
      next.metadata = remapSessionIDs(next.metadata, idMap) as Record<string, any>
    }
    if (next.type === "tool" && next.state.metadata) {
      next.state = {
        ...next.state,
        metadata: remapSessionIDs(next.state.metadata, idMap) as Record<string, any>,
      }
    }
    return next
  }

  function remapSessionIDs(value: unknown, idMap: Map<string, string>): unknown {
    if (typeof value === "string") return idMap.get(value) ?? value
    if (Array.isArray(value)) return value.map((item) => remapSessionIDs(item, idMap))
    if (!value || typeof value !== "object") return value

    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = remapSessionIDs(item, idMap)
    }
    return result
  }

  async function writeSessionInfo(scopeID: Identifier.ScopeID, info: Session.Info) {
    await Storage.write(
      StoragePath.sessionInfo(scopeID, Identifier.asSessionID(info.id)),
      Session.withoutRuntimeInfo(info),
    )
    await Storage.write(StoragePath.sessionIndex(Identifier.asSessionID(info.id)), Session.toIndex(info))
    await Session.upsertPageIndexEntry(scopeID, {
      id: info.id,
      updated: info.time.updated,
      created: info.time.created,
      pinned: info.pinned ?? 0,
      archived: !!info.time.archived,
      parentID: info.parentID,
    })
    if (info.parentID) {
      await Session.upsertChildIndexEntry(scopeID, info.parentID, {
        id: info.id,
        title: info.title,
        updated: info.time.updated,
        created: info.time.created,
        archived: !!info.time.archived,
      })
    }
  }
}
