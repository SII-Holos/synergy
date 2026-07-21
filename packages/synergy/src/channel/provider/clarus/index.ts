import { Channel } from "@/channel"
import type * as ChannelTypes from "@/channel/types"
import type { Config } from "@/config/config"
import { HolosAuth } from "@/holos/auth"
import { HolosRuntime } from "@/holos/runtime"
import { Session } from "@/session"
import { SessionEndpoint } from "@/session/endpoint"
import { SessionInteraction } from "@/session/interaction"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import type {
  ClarusAgentTunnelPort,
  ClarusObservedEvent,
  ProjectMessageCreatedEvent,
  RuntimeTaskAssignedEvent,
} from "./agent-tunnel-port"
import { ClarusAssignmentStore } from "./assignment-store"
import { ClarusOutbox } from "./outbox"
import { ClarusProjectClient } from "./project-client"
import { ClarusProjectSync } from "./project-sync"
import { ClarusResultOutbox, type ClarusResultPayload } from "./result-outbox"
import { createClarusAgentTunnelAdapter } from "./tunnel-adapter"

type AccountConnection = {
  accountId: string
  config: Config.ChannelClarusAccount
  tunnel: ClarusAgentTunnelPort
  signal: AbortSignal
  projects: Map<string, string>
  messageProjects: Map<string, string>
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

function textFromParts(parts: ChannelTypes.OutboundPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text
      const label = part.filename ?? part.type
      const location = part.url ?? part.path
      return location ? `[${label}](${location})` : `[${label}]`
    })
    .join("\n")
}

class ClarusStreamingSession implements ChannelTypes.StreamingSession {
  private active = false
  private text = ""

  constructor(
    private readonly provider: ClarusProvider,
    private readonly accountId: string,
    private readonly projectID: string,
  ) {}

  async start(): Promise<void> {
    this.active = true
  }

  async update(text: string): Promise<void> {
    this.text = text
  }

  async updateToolProgress(): Promise<void> {}

  async close(finalText?: string): Promise<void> {
    if (!this.active) return
    this.active = false
    const text = finalText ?? this.text
    if (text)
      await this.provider.pushMessage({
        accountId: this.accountId,
        chatId: this.projectID,
        parts: [{ type: "text", text }],
      })
  }

  isActive(): boolean {
    return this.active
  }
}

export class ClarusProvider implements ChannelTypes.Provider<Config.ChannelClarusAccount, Config.ChannelClarus> {
  readonly type = "clarus"
  private readonly log = Log.create({ service: "channel.clarus" })
  private readonly connections = new Map<string, AccountConnection>()

  async connect(input: {
    accountId: string
    accountConfig: Config.ChannelClarusAccount
    channelConfig: Config.ChannelClarus
    onMessage: ChannelTypes.MessageHandler
    signal: AbortSignal
    onDisconnect?: (reason?: string) => void
  }): Promise<void> {
    const credential = await HolosAuth.getCredentialOrThrow()
    if (credential.agentId !== input.accountId)
      throw new Error("The Clarus channel account is not the active Holos account")
    const status = await HolosRuntime.status()
    if (status.status !== "connected") throw new Error("Holos Agent Tunnel is not connected")

    const nativeTunnel = await HolosRuntime.getNativeTunnel()
    const tunnel = createClarusAgentTunnelAdapter(nativeTunnel)
    const connection: AccountConnection = {
      accountId: input.accountId,
      config: input.accountConfig,
      tunnel,
      signal: input.signal,
      projects: new Map(),
      messageProjects: new Map(),
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
        this.handleEvent(connection, event, input.onMessage).catch(() => {
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

  async replyMessage(input: {
    accountId: string
    messageId: string
    parts: ChannelTypes.OutboundPart[]
  }): Promise<ChannelTypes.SendResult> {
    const connection = this.requireConnection(input.accountId)
    const projectID = connection.messageProjects.get(input.messageId)
    if (!projectID) throw new Error("Clarus reply target is unavailable")
    return this.pushMessage({ accountId: input.accountId, chatId: projectID, parts: input.parts })
  }

  async pushMessage(input: {
    accountId: string
    chatId: string
    parts: ChannelTypes.OutboundPart[]
  }): Promise<ChannelTypes.SendResult> {
    const connection = this.requireConnection(input.accountId)
    const result = await ClarusOutbox.enqueue({
      accountHash: hash(input.accountId),
      projectID: input.chatId,
      content: textFromParts(input.parts),
      send: (outbound) => this.sendProjectMessage(connection, outbound),
    })
    return { messageId: result.messageID }
  }

  async addReaction(): Promise<void> {}

  createStreamingSession(input: { accountId: string; chatId: string }): ChannelTypes.StreamingSession {
    return new ClarusStreamingSession(this, input.accountId, input.chatId)
  }

  async submitTaskResult(input: {
    sessionID: string
    payload: ClarusResultPayload
    signal: AbortSignal
  }): Promise<{ requestID: string }> {
    return ClarusResultOutbox.submit({
      sessionID: input.sessionID,
      payload: input.payload,
      send: async ({ requestID, assignment, payload }) => {
        const connection = this.requireConnection(assignment.accountId)
        connection.outboundRequests.add(requestID)
        try {
          await connection.tunnel.recordTaskResult({
            requestID,
            runID: assignment.runID,
            taskID: assignment.taskID,
            subtaskID: assignment.subtaskID,
            success: payload.success,
            output: payload.output,
            artifacts: payload.artifacts.map((artifact) => ({
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
            evidenceRefs: payload.evidenceRefs,
            notaryRefs: payload.notaryRefs,
            error: payload.error,
            payload: { generated_by: payload.submittedBy, submitted_via: "synergy_clarus_tool" },
            signal: AbortSignal.any([connection.signal, input.signal]),
          }).response
        } finally {
          connection.outboundRequests.delete(requestID)
        }
      },
    })
  }

  private requireConnection(accountId: string): AccountConnection {
    const connection = this.connections.get(accountId)
    if (!connection || connection.signal.aborted) throw new Error("Clarus channel is not connected")
    return connection
  }

  private async syncProjects(connection: AccountConnection): Promise<void> {
    const accountHash = hash(connection.accountId)
    const previous = await ClarusProjectSync.load(accountHash)
    const config = await import("@/config/config").then(({ Config }) => Config.current())
    const rest = new ClarusProjectClient(
      connection.config.apiUrl ?? config.holos?.apiUrl ?? "https://api.holosai.io",
      async () => {
        const credential = await HolosAuth.getStoredCredential()
        if (!credential) return undefined
        return { agentID: credential.agentId, agentSecret: credential.agentSecret }
      },
      connection.signal,
    )
    let cursor: string | undefined
    do {
      const page = await rest.listProjects({ limit: 50, cursor })
      for (const project of page.projects) {
        await this.ensureProject(connection, project.projectID, project.projectName)
        const requestID = crypto.randomUUID()
        connection.outboundRequests.add(requestID)
        try {
          await connection.tunnel.subscribeProject({
            projectID: project.projectID,
            requestID,
            signal: connection.signal,
          }).response
        } finally {
          connection.outboundRequests.delete(requestID)
        }
      }
      cursor = page.nextCursor
    } while (cursor && !connection.signal.aborted)
    for (const projectID of previous.keys()) {
      if (connection.projects.has(projectID)) continue
      await Channel.archiveProjectScope({
        channelType: this.type,
        accountId: connection.accountId,
        projectID,
      })
    }
    await ClarusProjectSync.save(accountHash, connection.projects)
    await ClarusOutbox.recover({
      accountHash,
      send: (outbound) => this.sendProjectMessage(connection, outbound),
    })
    await ClarusResultOutbox.recover(accountHash)
  }

  private async sendProjectMessage(
    connection: AccountConnection,
    input: { requestID: string; projectID: string; content: string },
  ): Promise<{ messageID: string }> {
    connection.outboundRequests.add(input.requestID)
    try {
      const result = await connection.tunnel.sendProjectMessage({
        projectID: input.projectID,
        content: input.content,
        requestID: input.requestID,
        signal: connection.signal,
      }).response
      return { messageID: result.message.messageID }
    } finally {
      connection.outboundRequests.delete(input.requestID)
    }
  }

  private async ensureProject(connection: AccountConnection, projectID: string, projectName?: string) {
    const scope = await Channel.ensureProjectScope({
      channelType: this.type,
      accountId: connection.accountId,
      projectID,
      projectName,
    })
    connection.projects.set(projectID, projectName ?? scope.name ?? "Clarus project")
    const endpoint = SessionEndpoint.fromChannel({
      type: this.type,
      accountId: connection.accountId,
      chatId: projectID,
      chatType: "group",
      chatName: projectName,
    })
    await Session.getOrCreateForEndpoint(endpoint, {
      scope,
      title: projectName,
      agentOverride: connection.config.agent,
      controlProfile: "autonomous",
      interaction: SessionInteraction.unattended("channel:clarus"),
    })
    return scope
  }

  private async handleEvent(
    connection: AccountConnection,
    event: ClarusObservedEvent,
    onMessage: ChannelTypes.MessageHandler,
  ): Promise<void> {
    if (connection.signal.aborted || event.agentID !== connection.accountId || event.kind !== "known") return
    if (event.requestID && connection.outboundRequests.has(event.requestID)) return
    switch (event.type) {
      case "projectSubscribed":
        await this.ensureProject(connection, event.projectID, connection.projects.get(event.projectID))
        await ClarusProjectSync.save(hash(connection.accountId), connection.projects)
        return
      case "projectUnsubscribed":
        await Channel.archiveProjectScope({
          channelType: this.type,
          accountId: connection.accountId,
          projectID: event.projectID,
        })
        connection.projects.delete(event.projectID)
        await ClarusProjectSync.save(hash(connection.accountId), connection.projects)
        return
      case "projectMessageCreated":
        await this.handleProjectMessage(connection, event, onMessage)
        return
      case "runtimeTaskAssigned":
        await this.handleAssignment(connection, event)
        return
      default:
        return
    }
  }

  private async handleProjectMessage(
    connection: AccountConnection,
    event: ProjectMessageCreatedEvent,
    onMessage: ChannelTypes.MessageHandler,
  ): Promise<void> {
    const accountHash = hash(connection.accountId)
    const messageHash = hash(connection.accountId, event.projectID, event.message.messageID)
    using _ = await Lock.write(`channel:clarus:message:${accountHash}:${messageHash}`)
    const dedupKey = StoragePath.clarusProviderDedup(accountHash, messageHash)
    const duplicate = await Storage.read(dedupKey)
      .then(() => true)
      .catch(() => false)
    if (duplicate) return

    const projectName = connection.projects.get(event.projectID)
    const scope = await this.ensureProject(connection, event.projectID, projectName)
    connection.messageProjects.set(event.message.messageID, event.projectID)
    await onMessage(
      {
        channelType: this.type,
        accountId: connection.accountId,
        chatId: event.projectID,
        chatType: "group",
        chatName: projectName,
        senderId: event.message.senderID,
        senderName: event.message.senderName,
        text: event.message.content,
        messageId: event.message.messageID,
        timestamp: event.message.createdAt ?? Date.now(),
        messageType: event.message.messageType,
      },
      scope,
    )
    await Storage.write(dedupKey, { seenAt: Date.now() })
  }

  private async handleAssignment(connection: AccountConnection, event: RuntimeTaskAssignedEvent): Promise<void> {
    const scope = await this.ensureProject(connection, event.projectID, connection.projects.get(event.projectID))
    await ClarusAssignmentStore.ensure({
      accountId: connection.accountId,
      scope,
      event,
      agentOverride: connection.config.agent,
    })
  }
}
