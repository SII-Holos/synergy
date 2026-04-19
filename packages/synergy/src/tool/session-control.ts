import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import { PermissionNext } from "../permission/next"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { SessionInvoke } from "../session/invoke"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { MessageV2 } from "../session/message-v2"
import { SessionInteraction } from "../session/interaction"
import { AppChannel } from "../channel/app"
import { Contact } from "../holos/contact"
import { HolosRuntime } from "../holos/runtime"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import DESCRIPTION from "./session-control.txt"

const Action = z.enum([
  "status",
  "compact",
  "abort",
  "question_reply",
  "question_reject",
  "permission_reply",
  "set_allow_all",
])

const parameters = z.object({
  target: z
    .string()
    .describe("Target session. A session ID (ses_xxx), 'home' for the app home session, or a Holos contact/agent ID."),
  action: Action.describe("The control action to perform on the target session."),
  requestID: z
    .string()
    .optional()
    .describe(
      "ID of the pending question or permission request. Required for question_reply, question_reject, and permission_reply.",
    ),
  answers: z
    .array(z.array(z.string()))
    .optional()
    .describe(
      "Answers for question_reply. An array of arrays of selected labels — one array per question, each containing the label(s) selected.",
    ),
  reply: z
    .enum(["once", "reject"])
    .optional()
    .describe("Reply for permission_reply. 'once' approves this request; 'reject' denies it."),
  message: z.string().optional().describe("Optional feedback message when rejecting a permission request."),
  enabled: z.boolean().optional().describe("Enable or disable allow-all mode. Required for set_allow_all."),
})

async function resolveSession(target: string): Promise<Session.Info> {
  if (target === "home") {
    return AppChannel.session()
  }
  if (target.startsWith("ses_")) {
    return SessionManager.requireSession(target)
  }
  const contact = await Contact.get(target)
  if (!contact) {
    throw new Error(`Contact "${target}" not found.`)
  }
  if (contact.config.blocked) {
    throw new Error(`Contact "${target}" is blocked.`)
  }
  return HolosRuntime.getOrCreateSession(contact.holosId ?? contact.id)
}

export const SessionControlTool = Tool.define("session_control", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await resolveSession(params.target)
    const sessionID = session.id

    if (params.action === "status") {
      return handleStatus(sessionID)
    }

    const withScope = <T>(fn: () => Promise<T>) => Instance.provide({ scope: session.scope as Scope, fn })

    switch (params.action) {
      case "compact": {
        return withScope(() => handleCompact(sessionID))
      }
      case "abort": {
        return withScope(() => handleAbort(sessionID))
      }
      case "question_reply": {
        if (!params.requestID) {
          throw new Error("requestID is required for question_reply")
        }
        if (!params.answers) {
          throw new Error("answers is required for question_reply")
        }
        return withScope(() => handleQuestionReply(params.requestID!, params.answers!))
      }
      case "question_reject": {
        if (!params.requestID) {
          throw new Error("requestID is required for question_reject")
        }
        return withScope(() => handleQuestionReject(params.requestID!))
      }
      case "permission_reply": {
        if (!params.requestID) {
          throw new Error("requestID is required for permission_reply")
        }
        if (!params.reply) {
          throw new Error("reply is required for permission_reply")
        }
        return withScope(() => handlePermissionReply(params.requestID!, params.reply!, params.message))
      }
      case "set_allow_all": {
        if (params.enabled === undefined) {
          throw new Error("enabled is required for set_allow_all")
        }
        return withScope(() => handleSetAllowAll(sessionID, params.enabled!))
      }
    }
  },
})

async function handleStatus(sessionID: string) {
  const runtime = SessionManager.getRuntime(sessionID)
  const pendingQuestions = await Question.list()
  const sessionQuestions = pendingQuestions.filter((q) => q.sessionID === sessionID)
  const pendingPermissions = await PermissionNext.list()
  const sessionPermissions = pendingPermissions.filter((p) => p.sessionID === sessionID)
  const allowAll = await PermissionNext.isAllowingAll(sessionID)
  const session = await Session.get(sessionID)

  const status = {
    sessionID,
    status: runtime?.status ?? { type: "idle" as const },
    allowAll,
    interaction: session?.interaction ?? SessionInteraction.interactive(),
    pendingQuestions: sessionQuestions.map((q) => ({
      id: q.id,
      questions: q.questions,
    })),
    pendingPermissions: sessionPermissions.map((p) => ({
      id: p.id,
      permission: p.permission,
      patterns: p.patterns,
      metadata: p.metadata,
    })),
  }

  const parts: string[] = []
  parts.push(`Session ${sessionID}: ${status.status.type}`)
  if (status.allowAll) parts.push("Allow-all: enabled")
  if (status.interaction.mode === "unattended") parts.push(`Mode: unattended (${status.interaction.source ?? ""})`)
  if (status.pendingQuestions.length > 0) {
    parts.push(`Pending questions: ${status.pendingQuestions.length}`)
    for (const q of status.pendingQuestions) {
      for (const question of q.questions) {
        const opts = question.options.map((o) => `"${o.label}" (${o.description})`).join(", ")
        parts.push(`  [${q.id}] ${question.header}: ${question.question}`)
        parts.push(`    Options: ${opts}`)
        if (question.multiple) parts.push("    (multiple selection allowed)")
      }
    }
  }
  if (status.pendingPermissions.length > 0) {
    parts.push(`Pending permissions: ${status.pendingPermissions.length}`)
    for (const p of status.pendingPermissions) {
      const toolInfo = p.metadata?.tool
      const toolLabel = toolInfo ? ` (tool: ${p.metadata?.toolName ?? "unknown"})` : ""
      parts.push(`  [${p.id}] ${p.permission} on ${p.patterns.join(", ")}${toolLabel}`)
    }
  }
  if (status.pendingQuestions.length === 0 && status.pendingPermissions.length === 0) {
    parts.push("No pending questions or permissions.")
  }

  return {
    title: `Status of ${sessionID}`,
    output: parts.join("\n"),
    metadata: { status } as Record<string, any>,
  }
}

async function handleCompact(sessionID: string) {
  const session = await Session.get(sessionID)
  if (!session) {
    throw new Error(`Session ${sessionID} not found`)
  }

  const msgs = await Session.messages({ sessionID })
  let currentAgent = await Agent.defaultAgent()
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info
    if (info.role === "user") {
      currentAgent = info.agent || (await Agent.defaultAgent())
      break
    }
  }

  const lastUserModel = msgs
    .filter((m) => m.info.role === "user")
    .map((m) => m.info as MessageV2.User)
    .at(-1)?.model

  const model = lastUserModel ?? (await Agent.getAvailableModel(await Agent.get(currentAgent)))
  if (!model) {
    throw new Error(`No model available for compaction in session ${sessionID}`)
  }

  const msg = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    model,
    sessionID,
    agent: currentAgent,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "compaction",
    auto: false,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: "What did we do so far?",
  })

  SessionInvoke.loop(sessionID).catch(() => {})

  return {
    title: `Compacted ${sessionID}`,
    output: `Compaction triggered for session ${sessionID}.`,
    metadata: { sessionID, action: "compact" } as Record<string, any>,
  }
}

async function handleAbort(sessionID: string) {
  SessionInvoke.cancel(sessionID)
  const { Cortex } = await import("../cortex")
  await Cortex.cancelAll(sessionID)
  return {
    title: `Aborted ${sessionID}`,
    output: `Session ${sessionID} has been aborted.`,
    metadata: { sessionID, action: "abort" } as Record<string, any>,
  }
}

async function handleQuestionReply(requestID: string, answers: Question.Answer[]) {
  await Question.reply({ requestID, answers })
  const formatted = answers.map((a) => a.join(", ")).join("; ")
  return {
    title: `Answered question ${requestID}`,
    output: `Question ${requestID} answered: ${formatted}`,
    metadata: { action: "question_reply", requestID, answers } as Record<string, any>,
  }
}

async function handleQuestionReject(requestID: string) {
  await Question.reject(requestID)
  return {
    title: `Rejected question ${requestID}`,
    output: `Question ${requestID} rejected.`,
    metadata: { action: "question_reject", requestID } as Record<string, any>,
  }
}

async function handlePermissionReply(requestID: string, reply: PermissionNext.Reply, message?: string) {
  await PermissionNext.reply({ requestID, reply, message })
  const desc = reply === "once" ? "approved" : "rejected"
  return {
    title: `${reply === "once" ? "Approved" : "Rejected"} permission ${requestID}`,
    output: `Permission ${requestID} ${desc}.${message ? ` Feedback: ${message}` : ""}`,
    metadata: { action: "permission_reply", requestID, reply, message } as Record<string, any>,
  }
}

async function handleSetAllowAll(sessionID: string, enabled: boolean) {
  await PermissionNext.setAllowAll(sessionID, enabled)
  return {
    title: `Allow-all ${enabled ? "enabled" : "disabled"} for ${sessionID}`,
    output: `Allow-all mode ${enabled ? "enabled" : "disabled"} for session ${sessionID}.`,
    metadata: { sessionID, action: "set_allow_all", enabled } as Record<string, any>,
  }
}
