import { Session } from "../session"
import { Ripgrep } from "../file/ripgrep"
import { formatLocalDate, formatLocalDateTime } from "../util/time-format"

import { ScopeContext } from "../scope/context"
import { SessionEndpoint } from "./endpoint"

import PROMPT_FALLBACK from "./prompt/fallback.txt"
import type { Provider } from "@/provider/provider"
import { InstructionFiles } from "./instruction-files"

export namespace SystemPrompt {
  export function provider(_model: Provider.Model) {
    return [PROMPT_FALLBACK]
  }

  const endpointLabels: Record<string, string> = {
    feishu: "Feishu (Lark)",
  }

  export async function environment(options?: {
    endpointType?: string
    session?: {
      id: string
      title: string
      parentID?: string
      time: { created: number }
      endpoint?: SessionEndpoint.Info
      interaction?: { mode: string; source?: string }
      superplan?: {
        runID: string
        role: string
        nodeID?: string
        mergeID?: string
      }
    }
  }) {
    const scope = ScopeContext.current.scope
    const endpointType = options?.endpointType
    const session = options?.session
    const envLines = [
      `  Working directory: ${ScopeContext.current.directory}`,
      `  Is directory a git repo: ${scope.type === "project" && scope.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${formatLocalDate(Date.now())}`,
    ]

    const workspace = ScopeContext.current.workspace
    if (workspace) {
      envLines.push(`  Workspace type: ${workspace.type}`)
      envLines.push(`  Workspace path: ${workspace.path}`)
      if (workspace.type === "git_worktree") {
        if (workspace.name) envLines.push(`  Worktree name: ${workspace.name}`)
        if (workspace.branch) envLines.push(`  Worktree branch: ${workspace.branch}`)
        if (workspace.baseRef) envLines.push(`  Worktree base: ${workspace.baseRef}`)
        if (workspace.baseRevision) envLines.push(`  Worktree base revision: ${workspace.baseRevision}`)
        if (workspace.resolvedBaseCommit) envLines.push(`  Worktree base commit: ${workspace.resolvedBaseCommit}`)
        envLines.push(
          `  Worktree isolation: this session's active workspace is the worktree path above. Stay inside it by default; access outside the active workspace, including the original checkout, requires explicit permission. Do not use cd or workdir to operate outside the worktree unless the user asks for that specific path.`,
        )
        envLines.push(`  Workspace boundary: enforced by tools and permission checks`)
        if (workspace.originalCheckout) {
          envLines.push(`  Original checkout: ${workspace.originalCheckout}`)
        }
        envLines.push(
          `  Leaving: use worktree_leave when isolated work is complete or you need to return to the main checkout.`,
        )
      }
    }

    if (session?.superplan) {
      envLines.push(`  SuperPlan run: ${session.superplan.runID}`)
      envLines.push(`  SuperPlan role: ${session.superplan.role}`)
      if (session.superplan.nodeID) envLines.push(`  SuperPlan node: ${session.superplan.nodeID}`)
      if (session.superplan.mergeID) envLines.push(`  SuperPlan merge: ${session.superplan.mergeID}`)
    }

    if (scope.type === "home") {
      if (!endpointType) {
        envLines.push(`  Scope: home`)
      }
    } else if (scope.type === "project") {
      envLines.push(`  Scope ID: ${scope.id}`)
      if (scope.name) envLines.push(`  Project name: ${scope.name}`)
    }

    if (session?.endpoint?.kind === "channel") {
      const ch = session.endpoint.channel
      const label = endpointLabels[ch.type] ?? ch.type
      const chatTypeLabel = ch.chatType === "group" ? "group chat" : ch.chatType === "dm" ? "direct message" : undefined
      envLines.push(`  Session source: ${label} channel${chatTypeLabel ? ` (${chatTypeLabel})` : ""}`)
      if (ch.chatId) envLines.push(`  Chat ID: ${ch.chatId}`)
      if (ch.senderName) envLines.push(`  User: ${ch.senderName}`)
      else if (ch.senderId) envLines.push(`  Sender ID: ${ch.senderId}`)
    } else if (endpointType) {
      envLines.push(`  Session source: ${endpointLabels[endpointType] ?? endpointType} endpoint`)
    }

    if (session) {
      envLines.push(`  Session ID: ${session.id}`)
      if (session.title) envLines.push(`  Session title: ${session.title}`)
      envLines.push(`  Session created: ${formatLocalDateTime(session.time.created)}`)
      if (session.parentID) {
        envLines.push(`  Parent session: ${session.parentID}`)
        const parent = await Session.get(session.parentID).catch(() => undefined)
        if (parent) {
          const parentWs = (parent as any).workspace
          const childWs = ScopeContext.current.workspace
          if (parentWs && childWs && parentWs.path !== childWs.path) {
            envLines.push(`  Parent workspace type: ${parentWs.type}`)
            envLines.push(`  Parent workspace path: ${parentWs.path}`)
          }
        }
      }
    }

    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        ...envLines,
        `</env>`,
        `<files>`,
        `  ${
          scope.type === "project" && scope.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: ScopeContext.current.directory,
                limit: 200,
              })
            : ""
        }`,
        `</files>`,
      ].join("\n"),
    ]
  }

  export async function custom() {
    return InstructionFiles.load()
  }
}
