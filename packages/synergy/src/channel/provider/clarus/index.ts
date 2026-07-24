import type * as ChannelTypes from "@/channel/types"
import type { ChannelHost } from "@/channel/host"
import type { Config } from "@/config/config"
import { HolosAuth } from "@/holos/auth"
import { HolosRuntime } from "@/holos/runtime"
import { Log } from "@/util/log"
import type { ClarusAgentTunnelPort, ClarusObservedEvent, RuntimeTaskAssignedEvent } from "./agent-tunnel-port"
import {
  ClarusAssignmentExpiredError,
  ClarusAssignmentRuntime,
  ClarusAssignmentSessionArchivedError,
} from "./assignment-runtime"
import { ClarusAssignmentStore, type ClarusAssignment } from "./assignment-store"
import { ClarusDeadlineAgenda } from "./deadline-agenda"
import { ClarusProjectClient } from "./project-client"
import { ClarusResultOutbox, type ClarusResultPayload, type ClarusResultSend } from "./result-outbox"
import { ClarusExtensionOutbox, type ClarusExtendPayload, type ClarusExtensionSend } from "./extension-outbox"
import { createClarusAgentTunnelAdapter } from "./tunnel-adapter"
import { createClarusCliRunner } from "./cli-runner"
const PROJECT_REFRESH_TIMEOUT_MS = 60_000
const PROJECT_SUBSCRIBE_TIMEOUT_MS = 15_000
const INVALID_EVENT_MAX_ISSUES = 20
const INVALID_EVENT_MAX_TEXT_LENGTH = 500

function boundDiagnosticText(value: string): string {
  return value.length <= INVALID_EVENT_MAX_TEXT_LENGTH ? value : `${value.slice(0, INVALID_EVENT_MAX_TEXT_LENGTH - 1)}…`
}

function invalidEventDiagnostic(event: Extract<ClarusObservedEvent, { kind: "invalid" }>) {
  return {
    level: "warn",
    message: "Invalid Clarus event",
    data: {
      eventType: boundDiagnosticText(event.sourceType),
      issues: event.issues.slice(0, INVALID_EVENT_MAX_ISSUES).map((issue) => ({
        path: boundDiagnosticText(issue.path.map(String).join(".")),
        message: boundDiagnosticText(issue.message),
      })),
      ...(event.issues.length > INVALID_EVENT_MAX_ISSUES ? { issuesTruncated: true } : {}),
    },
  }
}

type ClarusHolosDependencies = {
  auth: Pick<typeof HolosAuth, "getCredentialOrThrow" | "getStoredCredential">
  runtime: Pick<typeof HolosRuntime, "getNativeIdentity" | "getNativeTunnel" | "status">
}

const defaultHolosDependencies: ClarusHolosDependencies = {
  auth: HolosAuth,
  runtime: HolosRuntime,
}

type AccountConnection = {
  accountId: string
  config: Config.ChannelClarusAccount
  tunnel: ClarusAgentTunnelPort
  signal: AbortSignal
  host: ChannelHost.Instance
  projects: Map<string, string>
  outboundRequests: Set<string>
}

function hash(...parts: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const part of parts) {
    hasher.update(part)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

export class ClarusProvider implements ChannelTypes.Provider<Config.ChannelClarusAccount, Config.ChannelClarus> {
  readonly type = "clarus"
  readonly lifecycle = "borrowed_transport" as const
  readonly messaging = "task_only" as const
  private readonly log = Log.create({ service: "channel.clarus" })
  private readonly connections = new Map<string, AccountConnection>()

  constructor(private readonly holos: ClarusHolosDependencies = defaultHolosDependencies) {}

  async waitForTransport(input: { accountId: string; signal: AbortSignal }): Promise<void> {
    if (input.signal.aborted) return
    const tunnel = await this.holos.runtime.getNativeTunnel()
    if (input.signal.aborted) return

    const ready = async () => {
      const [status, identity] = await Promise.all([
        this.holos.runtime.status(),
        this.holos.runtime.getNativeIdentity(),
      ])
      return status.status === "connected" && identity.agentID === input.accountId
    }
    if (await ready()) return

    await new Promise<void>((resolve) => {
      let settled = false
      let removeObserver = () => {}
      const settle = () => {
        if (settled) return
        settled = true
        input.signal.removeEventListener("abort", settle)
        removeObserver()
        resolve()
      }
      removeObserver = tunnel.registerConnectionObserver((event) => {
        if (event.type === "connected" && event.agentID === input.accountId) settle()
      })
      input.signal.addEventListener("abort", settle, { once: true })
      if (input.signal.aborted) {
        settle()
        return
      }
      void ready()
        .then((isReady) => {
          if (isReady) settle()
        })
        .catch((error) => {
          this.log.warn("failed to recheck Holos transport readiness", {
            accountHash: hash(input.accountId),
            error,
          })
        })
    })
  }

  async connect(input: {
    accountId: string
    accountConfig: Config.ChannelClarusAccount
    channelConfig: Config.ChannelClarus
    onMessage: ChannelTypes.MessageHandler
    signal: AbortSignal
    host: ChannelHost.Instance
    onDisconnect?: (reason?: string) => void
  }): Promise<void> {
    const credential = await this.holos.auth.getCredentialOrThrow()
    if (credential.agentId !== input.accountId)
      throw new Error("The Clarus channel account is not the active Holos account")
    const status = await this.holos.runtime.status()
    if (status.status !== "connected") throw new Error("Holos Agent Tunnel is not connected")

    const nativeTunnel = await this.holos.runtime.getNativeTunnel()
    const tunnel = createClarusAgentTunnelAdapter(nativeTunnel)
    const connection: AccountConnection = {
      accountId: input.accountId,
      config: input.accountConfig,
      tunnel,
      signal: input.signal,
      host: input.host,
      projects: new Map(),
      outboundRequests: new Set(),
    }
    this.connections.set(input.accountId, connection)

    const removers = new Set<() => void>()
    const cleanup = () => {
      input.signal.removeEventListener("abort", cleanup)
      for (const remove of removers) remove()
      removers.clear()
      if (this.connections.get(input.accountId) === connection) this.connections.delete(input.accountId)
    }
    removers.add(
      tunnel.registerEventHandler((event) =>
        this.handleEvent(connection, event).catch(() => {
          this.log.error("failed to handle Clarus event", {
            accountHash: hash(input.accountId),
            eventType: event.kind === "known" ? event.type : event.kind,
          })
        }),
      ),
    )
    removers.add(
      tunnel.registerConnectionHandler((event) => {
        if (event.agentID !== input.accountId || event.type !== "disconnected") return
        cleanup()
        input.onDisconnect?.(event.reason)
      }),
    )
    input.signal.addEventListener("abort", cleanup, { once: true })

    try {
      await this.syncProjects(connection)
    } catch (error) {
      cleanup()
      throw error
    }
  }

  async submitTaskResult(input: {
    sessionID: string
    payload: ClarusResultPayload
    signal: AbortSignal
  }): Promise<{ requestID: string }> {
    const result = await ClarusResultOutbox.submit({
      sessionID: input.sessionID,
      payload: input.payload,
      send: async (outbound) => {
        const connection = this.requireConnection(outbound.assignment.accountId, outbound.requestID)
        await this.sendTaskResult(connection, outbound, input.signal)
      },
    })
    const located = await ClarusAssignmentStore.findBySessionID(input.sessionID)
    if (located?.assignment.resultState === "acknowledged") {
      await ClarusDeadlineAgenda.cancel({
        accountId: located.assignment.accountId,
        projectID: located.assignment.projectID,
        taskID: located.assignment.taskID,
      })
    }
    return result
  }

  async extendTask(input: {
    sessionID: string
    payload: ClarusExtendPayload
    signal: AbortSignal
  }): Promise<{ requestID: string }> {
    const result = await ClarusExtensionOutbox.submit({
      sessionID: input.sessionID,
      payload: input.payload,
      send: async (outbound) => {
        const connection = this.requireConnection(outbound.assignment.accountId, outbound.requestID)
        return this.sendTaskExtension(connection, outbound, input.signal)
      },
    })
    const located = await ClarusAssignmentStore.findBySessionID(input.sessionID)
    if (located) await this.syncAssignmentDeadline(located.assignment)
    return result
  }

  private async sendTaskResult(
    connection: AccountConnection,
    input: Parameters<ClarusResultSend>[0],
    signal: AbortSignal = connection.signal,
  ): Promise<void> {
    connection.outboundRequests.add(input.requestID)
    try {
      await connection.tunnel.recordTaskResult({
        requestID: input.requestID,
        runID: input.assignment.runID,
        taskID: input.assignment.taskID,
        subtaskID: input.assignment.subtaskID,
        success: input.payload.success,
        output: input.payload.output,
        artifacts: input.payload.artifacts.map((artifact) => ({
          artifact_id: artifact.artifactID,
          name: artifact.name,
          ...(artifact.description === undefined ? {} : { description: artifact.description }),
          parts: artifact.parts.map((part) => ({
            type: part.type,
            format: part.format,
            role: part.role,
            content_kind: part.contentKind,
            name: part.name,
            content: part.content,
          })),
        })),
        evidenceRefs: input.payload.evidenceRefs,
        notaryRefs: input.payload.notaryRefs,
        error: input.payload.error,
        payload: { generated_by: input.payload.submittedBy, submitted_via: "synergy_clarus_tool" },
        signal: AbortSignal.any([connection.signal, signal]),
      }).response
    } finally {
      connection.outboundRequests.delete(input.requestID)
    }
  }
  private async sendTaskExtension(
    connection: AccountConnection,
    input: Parameters<ClarusExtensionSend>[0],
    signal: AbortSignal = connection.signal,
  ): Promise<{ deadlineAt?: string | null }> {
    connection.outboundRequests.add(input.requestID)
    try {
      const event = await connection.tunnel.extendTask({
        requestID: input.requestID,
        runID: input.assignment.runID,
        taskID: input.assignment.taskID,
        subtaskID: input.assignment.subtaskID,
        extendSeconds: input.payload.extend_seconds,
        progress: input.payload.progress,
        payload: input.payload.payload,
        signal: AbortSignal.any([connection.signal, signal]),
      }).response
      return { deadlineAt: event.task.deadlineAt }
    } finally {
      connection.outboundRequests.delete(input.requestID)
    }
  }

  async refreshProjects(input: { accountId: string; signal: AbortSignal; host: ChannelHost.Instance }): Promise<void> {
    const connection = this.connections.get(input.accountId)
    if (!connection || connection.signal.aborted) throw new Error("Clarus channel is not connected")
    const signal = AbortSignal.any([connection.signal, input.signal, AbortSignal.timeout(PROJECT_REFRESH_TIMEOUT_MS)])
    await this.syncProjects(connection, signal)
  }

  private requireConnection(accountId: string, requestID: string): AccountConnection {
    const connection = this.connections.get(accountId)
    if (connection && !connection.signal.aborted) return connection
    throw {
      disposition: "not_dispatched" as const,
      requestID,
      code: "CLARUS_NOT_CONNECTED",
      message: "Clarus channel is not connected",
    }
  }

  private async syncProjects(connection: AccountConnection, signal: AbortSignal = connection.signal): Promise<void> {
    const accountHash = hash(connection.accountId)
    const apiUrl =
      connection.config.apiUrl ??
      (await import("@/config/config").then(({ Config }) => Config.current())).holos?.apiUrl ??
      "https://api.holosai.io"
    const rest = new ClarusProjectClient(
      apiUrl,
      async () => {
        const credential = await this.holos.auth.getStoredCredential()
        if (!credential) return undefined
        return { agentID: credential.agentId, agentSecret: credential.agentSecret }
      },
      signal,
    )
    const projects: ChannelHost.ExternalProjectRef[] = []
    let cursor: string | undefined
    do {
      const page = await rest.listProjects({ limit: 50, cursor })
      for (const project of page.projects) {
        const name = project.projectName ?? project.projectID
        projects.push({ externalProjectId: project.projectID, name, isActive: project.status === "active" })
        connection.projects.set(project.projectID, name)
      }
      cursor = page.nextCursor
    } while (cursor && !signal.aborted)

    await connection.host.projects.reconcile({ projects, complete: !signal.aborted })
    for (const project of projects) {
      if (!project.isActive) continue
      const requestID = crypto.randomUUID()
      connection.outboundRequests.add(requestID)
      try {
        await connection.tunnel.subscribeProject({
          projectID: project.externalProjectId,
          requestID,
          timeoutMs: PROJECT_SUBSCRIBE_TIMEOUT_MS,
          signal,
        }).response
      } finally {
        connection.outboundRequests.delete(requestID)
      }
    }
    await ClarusResultOutbox.recover({
      accountHash,
      send: (input) => this.sendTaskResult(connection, input, signal),
    })
    const recoveredExtensions = await ClarusExtensionOutbox.recover({
      accountHash,
      send: (input) => this.sendTaskExtension(connection, input, signal),
    })
    for (const sessionID of recoveredExtensions) {
      const located = await ClarusAssignmentStore.findBySessionID(sessionID)
      if (located) await this.syncAssignmentDeadline(located.assignment)
    }
  }

  private async ensureProject(connection: AccountConnection, projectID: string, projectName?: string) {
    const name = projectName ?? connection.projects.get(projectID) ?? "Clarus project"
    const project = await connection.host.projects.ensure({ externalProjectId: projectID, name, isActive: true })
    connection.projects.set(projectID, name)
    return project
  }
  private async syncAssignmentDeadline(assignment: ClarusAssignment, active = assignment.status === "running") {
    await ClarusDeadlineAgenda.sync({
      accountId: assignment.accountId,
      projectID: assignment.projectID,
      taskID: assignment.taskID,
      sessionID: assignment.sessionID,
      deadlineAt: assignment.deadlineAt,
      active: active && assignment.resultState !== "acknowledged",
    })
  }

  private async handleEvent(connection: AccountConnection, event: ClarusObservedEvent): Promise<void> {
    if (connection.signal.aborted || event.agentID !== connection.accountId) return
    if (event.kind === "invalid") {
      await connection.host.diagnostics.record(invalidEventDiagnostic(event))
      return
    }
    if (event.kind !== "known") return
    if (event.requestID && connection.outboundRequests.has(event.requestID)) return
    switch (event.type) {
      case "projectSubscribed":
        await this.ensureProject(connection, event.projectID, connection.projects.get(event.projectID))
        return
      case "projectUnsubscribed":
        await connection.host.projects.markArchived({ externalProjectId: event.projectID })
        connection.projects.delete(event.projectID)
        return
      case "runtimeTaskAssigned":
        await this.handleAssignment(connection, event)
        return
      case "runtimeTaskExtended":
        await this.handleTaskExtended(connection, event)
        return
      case "runtimeTaskResultRecorded":
        await this.handleResultRecorded(connection, event)
        return
      default:
        return
    }
  }

  private async handleTaskExtended(
    connection: AccountConnection,
    event: Extract<ClarusObservedEvent, { kind: "known"; type: "runtimeTaskExtended" }>,
  ): Promise<void> {
    const located = await ClarusAssignmentStore.findByIdentity({
      accountId: connection.accountId,
      projectID: event.projectID,
      taskID: event.task.taskID,
    })
    if (!located) return
    const assignment = located.assignment
    if (assignment.runID !== event.runID || assignment.status !== "running") return
    if (event.requestID && assignment.extensionRequestID && event.requestID !== assignment.extensionRequestID) return
    if (event.requestID && event.requestID === assignment.extensionRequestID) {
      if (assignment.extensionState === "rejected") return
      await ClarusExtensionOutbox.acknowledge({
        accountHash: located.accountHash,
        assignmentHash: located.assignmentHash,
        requestID: event.requestID,
        deadlineAt: event.task.deadlineAt,
      })
    } else {
      await ClarusAssignmentStore.updateDeadline({
        accountHash: located.accountHash,
        assignmentHash: located.assignmentHash,
        deadlineAt: event.task.deadlineAt,
      })
    }
    const updated = await ClarusAssignmentStore.find(located.accountHash, located.assignmentHash)
    if (updated) await this.syncAssignmentDeadline(updated.assignment, event.task.status === "running")
  }

  private async handleResultRecorded(
    connection: AccountConnection,
    event: Extract<ClarusObservedEvent, { kind: "known"; type: "runtimeTaskResultRecorded" }>,
  ): Promise<void> {
    const located = await ClarusAssignmentStore.findByIdentity({
      accountId: connection.accountId,
      projectID: event.projectID,
      taskID: event.task.taskID,
    })
    if (!located) return
    const assignment: ClarusAssignment = located.assignment
    if (assignment.runID !== event.runID || assignment.subtaskID !== event.task.subtaskID) return
    if (assignment.resultState === "none" || assignment.resultState === "rejected") return
    if (event.requestID && event.requestID !== assignment.resultRequestID) return
    const requestID = event.requestID ?? assignment.resultRequestID
    if (!requestID) return
    await ClarusResultOutbox.acknowledge({
      accountHash: located.accountHash,
      assignmentHash: located.assignmentHash,
      requestID,
    })
    await ClarusDeadlineAgenda.cancel({
      accountId: assignment.accountId,
      projectID: assignment.projectID,
      taskID: assignment.taskID,
    })
  }

  private async handleAssignment(connection: AccountConnection, event: RuntimeTaskAssignedEvent): Promise<void> {
    const credential = await this.holos.auth.getStoredCredential()
    if (!credential || credential.agentId !== connection.accountId) {
      throw new Error("The Clarus channel account is not the active Holos account")
    }
    const apiUrl =
      connection.config.apiUrl ??
      (await import("@/config/config").then(({ Config }) => Config.current())).holos?.apiUrl ??
      "https://api.holosai.io"
    try {
      await ClarusAssignmentRuntime.dispatch({
        host: connection.host,
        accountId: connection.accountId,
        event,
        agentOverride: connection.config.agent || undefined,
        cliRunner: createClarusCliRunner({ apiUrl, credential }),
      })
    } catch (error) {
      if (ClarusAssignmentExpiredError.isInstance(error)) {
        await connection.host.diagnostics.record({
          level: "info",
          message: "Skipped expired Clarus assignment",
          data: {
            projectHash: hash(event.projectID),
            taskHash: hash(event.taskID),
            deadlineAt: error.data.deadlineAt,
          },
        })
        return
      }
      if (ClarusAssignmentSessionArchivedError.isInstance(error)) {
        await connection.host.diagnostics.record({
          level: "warn",
          message: "Clarus assignment blocked by archived Session",
          data: {
            projectHash: hash(event.projectID),
            taskHash: hash(event.taskID),
            sessionID: error.data.sessionID,
          },
        })
        return
      }
      throw error
    }
  }
}
