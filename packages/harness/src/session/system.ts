import { Session } from "."
import { formatLocalDate, formatLocalDateTime } from "../util/time-format"

import { SessionProjectHealth } from "./project-health"
import { SessionEnvContributor } from "./env-contributor"

import { ScopeContext } from "../scope/context"
import { Scope } from "../scope"
import { WorkspaceCatalog } from "../workspace/catalog"
import { SessionEndpoint } from "./endpoint"

import PROMPT_FALLBACK from "./prompt/fallback.txt"
import type { Provider } from "../provider/provider"
import { InstructionFiles } from "./instruction-files"
import { RuntimeContext, type RuntimeLaunch } from "../lifecycle/context"
import { peekRuntimeListener } from "../util/runtime-endpoint"

export namespace SystemPrompt {
  export function provider(_model: Provider.Model) {
    return [PROMPT_FALLBACK]
  }

  const endpointLabels: Record<string, string> = {
    feishu: "Feishu (Lark)",
  }

  const launchLabels: Record<RuntimeLaunch["entry"], readonly [string, string]> = {
    "dev-server": ["bun dev server", "source development orchestrator"],
    "dev-web": ["bun dev web", "source development orchestrator"],
    "dev-desktop": ["bun dev desktop (external-server mode)", "source development orchestrator"],
    "dev-desktop-managed": ["bun dev desktop --managed", "Desktop managed server"],
    "dev-send": ["bun dev send", "one-shot CLI task"],
    "desktop-managed": ["Desktop managed server", "Desktop managed server"],
    daemon: ["synergy start", "platform background service"],
    "cli-server": ["synergy server", "foreground CLI server"],
    "cli-send": ["synergy send", "one-shot CLI task"],
    embedded: ["embedded Runtime", "embedding host"],
  }

  export function runtime(): string {
    const instance = RuntimeContext.current()
    const { host } = instance
    const launch = host.launch
    const listener = peekRuntimeListener()
    const label = launch ? launchLabels[launch.entry] : undefined
    const hostname = listener?.hostname === "0.0.0.0" || listener?.hostname === "::" ? "127.0.0.1" : listener?.hostname
    const backend =
      listener && hostname
        ? new URL(`http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${listener.port}`).origin
        : undefined
    const lines = [
      "  Role: Synergy backend carrying the current conversation; not the Session Workspace or selected execution Environment.",
      `  Instance ID: ${instance.id}`,
      `  Runtime started: ${new Date(instance.startedAt).toISOString()}`,
      `  Runtime mode: ${instance.mode}`,
      `  Launch entry: ${label?.[0] ?? "unknown (not supplied by the host)"}`,
      `  Lifecycle owner: ${label?.[1] ?? "unknown (not supplied by the host)"}`,
      `  Distribution: ${launch?.distribution ?? "unknown"}`,
      `  Version: ${launch?.version ?? "unknown"}`,
      `  Channel: ${launch?.channel ?? "unknown"}`,
      `  Runtime home: ${host.home}`,
      `  Data root: ${host.root}`,
      `  Backend URL: ${backend ?? "none (this Runtime has no HTTP listener)"}`,
    ]
    if (listener) {
      lines.push(`  Listener bind: ${listener.hostname}:${listener.port}`)
      lines.push(`  Listener generation: ${listener.generation}`)
    }
    if (launch?.sourceCheckout) lines.push(`  Runtime source checkout: ${launch.sourceCheckout}`)
    if (launch?.revision) lines.push(`  Revision at launch: ${launch.revision}`)
    lines.push(
      "  Runtime identity is independent of the files being edited. An attached Web/Desktop client does not change this backend's launch entry.",
      "  Do not stop, restart, signal, or reuse this Runtime's Home while it carries the current task. Develop Synergy in a separate Home with explicit alternate ports.",
    )
    return ["<synergy-runtime>", ...lines, "</synergy-runtime>"].join("\n")
  }

  export interface WorkspaceWriteRoots {
    roots: string[]
    failure: string[]
  }

  /** Resolved once per model round: the environment block states these roots, and the permission
   *  profile resolves against the same list, so callers pass the result instead of re-reading the
   *  Workspace catalog and re-acquiring shared roots for the second consumer. */
  export async function resolveWriteRoots(): Promise<WorkspaceWriteRoots> {
    const scope = ScopeContext.current.scope
    const workspace = ScopeContext.current.workspace
    const failure: string[] = []
    const roots = await Scope.Root.executionRoots(scope, workspace).catch(async (error) => {
      if (!WorkspaceCatalog.Unavailable.isInstance(error)) throw error
      const [failedWorkspace] = await WorkspaceCatalog.readMany([error.data.workspaceID])
      const failedPath = failedWorkspace?.scopeID === scope.id ? failedWorkspace.binding.path : undefined
      const failedRole = error.data.workspaceID === workspace?.id ? "Selected Workspace" : "Shared writable Workspace"
      failure.push(
        "  Workspace write-root validation: failed. API-only work remains available; operations requiring these roots remain blocked until recovery.",
        `  ${failedRole}: ${error.data.workspaceID}${failedPath ? ` (path: ${failedPath})` : ""}. Reason: ${error.data.reason ? `${error.data.reason}: ` : ""}${error.data.message}`,
      )
      return []
    })
    return { roots, failure }
  }

  export async function environment(options?: {
    endpointType?: string
    session?: SessionEnvContributor.EnvSession & { id: string; title: string; time: { created: number } }
    writeRoots?: WorkspaceWriteRoots
  }) {
    const scope = ScopeContext.current.scope
    const workspace = ScopeContext.current.workspace
    const endpointType = options?.endpointType
    const session = options?.session
    // Probe live instead of trusting the session-scope snapshot: a scope
    // created before `git init` keeps vcs undefined for the whole session,
    // which used to contradict the git-health block forever. Same probe as
    // git-health so the two can never disagree.
    const isGitRepo = workspace ? await SessionProjectHealth.isGitRepo(ScopeContext.current.directory) : false
    const envLines = [
      workspace
        ? `  Working directory: ${workspace.path}`
        : session?.workspaceID
          ? `  Workspace: ${session.workspaceID}. File paths resolve within this Workspace.`
          : "  Workspace: none. File tools require a Workspace; execution tools use the selected Environment.",
      `  Is directory a git repo: ${isGitRepo ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${formatLocalDate(Date.now())}`,
    ]

    const writeRoots = options?.writeRoots ?? (await SystemPrompt.resolveWriteRoots())
    envLines.push(...writeRoots.failure)
    if (writeRoots.roots.length) envLines.push(`  Writable workspace directories: ${writeRoots.roots.join(", ")}`)
    if (session) envLines.push(`  Selected Environment: ${session.environmentID ?? "none"}`)

    if (workspace) {
      envLines.push(`  Workspace type: ${workspace.type}`)
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
          `  Leaving: worktree_leave returns you to the original checkout and keeps the worktree unless you pass cleanup: "remove_if_clean", which permanently deletes it. Use worktree_archive when isolated work is finished: it returns you to the original checkout, attempts safe reclamation while keeping this conversation running, and leaves the checkout restorable with worktree_enter.`,
        )
      }
    }

    for (const contributor of SessionEnvContributor.list()) {
      envLines.push(...(await contributor.envHints(session)))
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
      ].join("\n"),
    ]
  }

  export async function custom() {
    return InstructionFiles.load()
  }
}
