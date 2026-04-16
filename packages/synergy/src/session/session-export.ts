import z from "zod"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { Dag } from "./dag"
import { Todo } from "./todo"
import { PermissionNext } from "@/permission/next"
import { SessionManager } from "./manager"
import { Snapshot } from "./snapshot"
import { Installation } from "@/global/installation"

export namespace SessionExport {
  export const Mode = z.enum(["compact", "standard", "full"]).meta({ ref: "SessionExportMode" })
  export type Mode = z.infer<typeof Mode>

  const COMPACT_TOOL_OUTPUT_LIMIT = 500
  const STANDARD_TOOL_OUTPUT_LIMIT = 2000

  export const SessionData = z.object({
    info: Session.Info,
    messages: z.array(MessageV2.WithParts),
    dag: z.array(Dag.Node),
    todos: z.array(Todo.Info),
    diffs: z.array(Snapshot.FileDiff),
  })
  export type SessionData = z.infer<typeof SessionData>

  export const Report = z.object({
    version: z.literal(1),
    generatedAt: z.number(),
    synergyVersion: z.string(),
    mode: Mode,
    rootSessionID: z.string(),
    sessions: z.array(SessionData),
  })
  export type Report = z.infer<typeof Report>

  export const SizeEstimate = z
    .object({
      sessionCount: z.number(),
      messageCount: z.number(),
      estimatedBytes: z.number(),
    })
    .meta({ ref: "SessionExportSizeEstimate" })
  export type SizeEstimate = z.infer<typeof SizeEstimate>

  async function collectSessionTree(rootSessionID: string): Promise<Session.Info[]> {
    const root = await Session.get(rootSessionID)
    const result: Session.Info[] = [root]
    const queue = [rootSessionID]
    while (queue.length) {
      const current = queue.shift()!
      const children = await Session.children(current)
      for (const child of children) {
        result.push(child)
        queue.push(child.id)
      }
    }
    return result
  }

  async function collectSessionData(session: Session.Info): Promise<SessionData> {
    const [messages, dag, todos, diffs] = await Promise.all([
      Session.messages({ sessionID: session.id }),
      Dag.get(session.id),
      Todo.get(session.id),
      Session.diff(session.id),
    ])
    return { info: session, messages, dag, todos, diffs }
  }

  function truncateToolOutput(output: string, limit: number): string {
    if (output.length <= limit) return output
    const half = Math.floor(limit / 2)
    const omitted = output.length - limit
    return output.slice(0, half) + `\n\n... [${omitted} characters omitted] ...\n\n` + output.slice(-half)
  }

  function applyMode(data: SessionData, mode: Mode): SessionData {
    if (mode === "full") return data

    const limit = mode === "compact" ? COMPACT_TOOL_OUTPUT_LIMIT : STANDARD_TOOL_OUTPUT_LIMIT

    const messages = data.messages.map((msg) => ({
      info: msg.info,
      parts: msg.parts.map((part) => {
        if (part.type === "tool" && part.state.status === "completed") {
          return {
            ...part,
            state: {
              ...part.state,
              output: truncateToolOutput(part.state.output, limit),
            },
          } as typeof part
        }
        if (mode === "compact" && part.type === "reasoning") {
          return {
            ...part,
            text: part.text.length > 200 ? part.text.slice(0, 200) + "... [truncated]" : part.text,
          } as typeof part
        }
        return part
      }),
    }))

    return { ...data, messages }
  }

  export async function estimate(rootSessionID: string): Promise<SizeEstimate> {
    const sessions = await collectSessionTree(rootSessionID)
    let messageCount = 0
    let estimatedBytes = 0
    for (const session of sessions) {
      const messages = await Session.messages({ sessionID: session.id })
      messageCount += messages.length
      estimatedBytes += JSON.stringify(messages).length
    }
    estimatedBytes += JSON.stringify(sessions).length
    return { sessionCount: sessions.length, messageCount, estimatedBytes }
  }

  export async function generate(input: { sessionID: string; mode: Mode }): Promise<Report> {
    const sessions = await collectSessionTree(input.sessionID)
    const collected = await Promise.all(sessions.map(collectSessionData))
    const shaped = collected.map((data) => applyMode(data, input.mode))

    return {
      version: 1,
      generatedAt: Date.now(),
      synergyVersion: Installation.VERSION,
      mode: input.mode,
      rootSessionID: input.sessionID,
      sessions: shaped,
    }
  }
}
