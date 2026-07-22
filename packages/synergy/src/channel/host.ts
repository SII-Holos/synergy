import z from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { ChannelTarget } from "./types"
import { ManagedProjectOwnership, type OwnershipRecord } from "./managed-project-ownership"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Session } from "@/session"
import { SessionEndpoint } from "@/session/endpoint"
import { SessionInteraction } from "@/session/interaction"
import { SessionInbox } from "@/session/inbox"
import { SessionDrive } from "@/session/drive"

export namespace ChannelHost {
  export type ProviderStatus = { kind: string }

  export const DiagnosticRecordInput = z.object({
    level: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  export type DiagnosticRecordInput = z.infer<typeof DiagnosticRecordInput>

  export const ExternalProjectRef = z.object({
    externalProjectId: z.string(),
    name: z.string(),
    isActive: z.boolean(),
  })
  export type ExternalProjectRef = z.infer<typeof ExternalProjectRef>

  export const ChannelHostProjectNotOwnedError = NamedError.create(
    "ChannelHostProjectNotOwnedError",
    z.object({
      externalProjectId: z.string(),
      channelType: z.string(),
      accountId: z.string(),
    }),
  )

  export const ChannelHostProjectUnavailableError = NamedError.create(
    "ChannelHostProjectUnavailableError",
    z.object({
      externalProjectId: z.string(),
      channelType: z.string(),
      accountId: z.string(),
    }),
  )

  function toRemoteState(isActive: boolean): OwnershipRecord["remoteState"] {
    return isActive ? "active" : "paused"
  }

  function projectOwnershipIdentity(host: { channelType: string; accountId: string }, externalProjectId: string) {
    return { channelType: host.channelType, accountId: host.accountId, externalProjectId }
  }

  async function resolveScopeForProject(
    host: { channelType: string; accountId: string },
    externalProjectId: string,
  ): Promise<{ record: OwnershipRecord; scope: Scope.Project }> {
    const record = await ManagedProjectOwnership.find(projectOwnershipIdentity(host, externalProjectId))
    if (!record) {
      throw new ChannelHostProjectNotOwnedError({
        externalProjectId,
        channelType: host.channelType,
        accountId: host.accountId,
      })
    }
    if (record.remoteState === "archived") {
      throw new ChannelHostProjectUnavailableError({
        externalProjectId,
        channelType: host.channelType,
        accountId: host.accountId,
      })
    }
    const scope = await Scope.fromID(record.scopeID)
    if (!scope || scope.type !== "project") {
      throw new ChannelHostProjectUnavailableError({
        externalProjectId,
        channelType: host.channelType,
        accountId: host.accountId,
      })
    }
    return { record, scope }
  }

  function taskEndpoint(
    host: { channelType: string; accountId: string },
    externalProjectId: string,
    externalTaskId: string,
  ) {
    return SessionEndpoint.Channel.parse({
      kind: "channel",
      channel: {
        type: host.channelType,
        accountId: host.accountId,
        target: ChannelTarget.parse({ kind: "task", externalProjectId, externalTaskId }),
      },
    })
  }

  export type Instance = ReturnType<typeof create>
  export function create(options: {
    channelType: string
    accountId: string
    onStatus?: (status: ProviderStatus) => void
    onDiagnostic?: (record: DiagnosticRecordInput) => void | Promise<void>
    activateTasks?: boolean
  }) {
    const { channelType, accountId, onStatus, onDiagnostic, activateTasks = false } = options
    const hostIdentity = { channelType, accountId }

    return {
      channelType,
      accountId,

      status: {
        update(status: ProviderStatus) {
          onStatus?.(status)
        },
      },

      diagnostics: {
        async record(record: DiagnosticRecordInput) {
          await onDiagnostic?.(record)
        },
      },

      projects: {
        async ensure(ref: ExternalProjectRef) {
          return ManagedProjectOwnership.ensure({
            ...projectOwnershipIdentity(hostIdentity, ref.externalProjectId),
            projectName: ref.name,
            remoteState: toRemoteState(ref.isActive),
          })
        },

        async reconcile(input: { projects: ExternalProjectRef[]; complete: boolean }) {
          const managed = await Promise.all(
            input.projects.map((ref) =>
              ManagedProjectOwnership.ensure({
                ...projectOwnershipIdentity(hostIdentity, ref.externalProjectId),
                projectName: ref.name,
                remoteState: toRemoteState(ref.isActive),
              }),
            ),
          )

          if (input.complete) {
            const listed = new Set(input.projects.map((project) => project.externalProjectId))
            const allOwned = await ManagedProjectOwnership.list({ channelType, accountId })
            await Promise.all(
              allOwned
                .filter((record) => !listed.has(record.externalProjectId) && record.remoteState !== "archived")
                .map((record) =>
                  ManagedProjectOwnership.markArchived(
                    projectOwnershipIdentity(hostIdentity, record.externalProjectId),
                  ),
                ),
            )
          }

          return managed
        },

        async markStale(input: { externalProjectId: string }) {
          return ManagedProjectOwnership.markStale(projectOwnershipIdentity(hostIdentity, input.externalProjectId))
        },

        async markArchived(input: { externalProjectId: string }) {
          return ManagedProjectOwnership.markArchived(projectOwnershipIdentity(hostIdentity, input.externalProjectId))
        },
      },

      tasks: {
        async dispatch(input: {
          externalProjectId: string
          externalTaskId: string
          deliveryKey: string
          title: string
          text: string
          agent?: string
          retryOfTaskID?: string
          systemGuidance?: { deliveryKey: string; text: string }
          beforeWake?: (result: { sessionID: string; deliveryCreated: boolean }) => void | Promise<void>
        }) {
          const { scope } = await resolveScopeForProject(hostIdentity, input.externalProjectId)
          const endpoint = taskEndpoint(hostIdentity, input.externalProjectId, input.externalTaskId)
          const session = await Session.getOrCreateForEndpoint(endpoint, {
            scope,
            controlProfile: "autonomous",
            interaction: SessionInteraction.unattended(`channel:${channelType}`),
            title: input.title,
            agentOverride: input.agent,
          })

          const result = await SessionInbox.deliverUnique({
            sessionID: session.id,
            deliveryKey: input.deliveryKey,
            mode: "task",
            message: {
              role: "user",
              parts: [{ type: "text", text: input.text }],
              visible: true,
              origin: { type: "channel" as const, label: channelType },
            },
          })
          if (input.systemGuidance) {
            await SessionInbox.deliverUnique({
              sessionID: session.id,
              deliveryKey: input.systemGuidance.deliveryKey,
              mode: "steer",
              message: {
                role: "user",
                parts: [{ type: "text", text: input.systemGuidance.text, origin: "system" }],
                visible: false,
                origin: { type: "channel" as const, label: channelType },
              },
            })
          }
          await ScopeContext.provide({
            scope,
            fn: () => input.beforeWake?.({ sessionID: session.id, deliveryCreated: result.created }),
          })
          if (activateTasks) await SessionDrive.request(session.id, `channel:${channelType}:task-dispatch`)

          return { sessionID: session.id, deliveryCreated: result.created }
        },

        async update(input: { externalProjectId: string; externalTaskId: string; deliveryKey: string; text: string }) {
          const record = await ManagedProjectOwnership.find(
            projectOwnershipIdentity(hostIdentity, input.externalProjectId),
          )
          if (!record || record.remoteState === "archived") {
            return { status: "no_session" as const, externalTaskId: input.externalTaskId }
          }

          const scope = await Scope.fromID(record.scopeID)
          if (!scope || scope.type !== "project") {
            return { status: "no_session" as const, externalTaskId: input.externalTaskId }
          }

          const endpoint = taskEndpoint(hostIdentity, input.externalProjectId, input.externalTaskId)
          const session = await Session.findForEndpoint(endpoint, { scope })
          if (!session) {
            return { status: "no_session" as const, externalTaskId: input.externalTaskId }
          }

          const result = await SessionInbox.deliverUnique({
            sessionID: session.id,
            deliveryKey: input.deliveryKey,
            mode: "steer",
            message: {
              role: "user",
              parts: [{ type: "text", text: input.text }],
              visible: true,
              origin: { type: "channel" as const, label: channelType },
            },
          })

          return {
            status: "delivered" as const,
            deliveryCreated: result.created,
            sessionID: session.id,
          }
        },
      },
    }
  }
}
