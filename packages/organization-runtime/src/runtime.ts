import { z } from "zod"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { RuntimeContext, type RuntimeLaunch } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { openAgentRuntime, type AgentRuntimeOptions } from "@ericsanchezok/synergy-agent-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import type { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { version } from "../package.json" with { type: "json" }
import { readRuntimeHome, MemberIdentity, HostedIdentity, type RuntimeIdentity } from "./home"
import { readRuntimeRegistration } from "./registration"
import { MemberHomeError } from "./record"
import { registerMemberSources } from "./sources"
import { MemberDesktop, MemberDesktopEntry, MemberListener } from "./launch"
import { organizationRuntime } from "./component"
import { memberEnvironment } from "./environment"
import { startMemberBridge } from "./bridge"
import { createCommandIntake } from "./command-intake"
import { attachMemberExecution } from "./execution-source"
import { startExecutionReleaseObserver } from "./release-observer"
import { startMemberSyncExporter } from "./sync-exporter"
import { startMemberNotifications } from "./notifications"
import { OrganizationLocalProjects } from "./local-project"
import { OrganizationSessionReads } from "./session-reads"
import { registerOrganizationTransferOwner } from "./session-transfer"
import { OrganizationRuntimeNative } from "./backup/native"
import { createRuntimeHandoff } from "./handoff-runtime"
import { OrganizationHandoffWorkspaceTarget } from "./handoff-workspace-target"
import { OrganizationHandoffWorkspaceSource } from "./handoff-workspace-source"
import { OrganizationWorkspaceFileSource } from "./workspace-file-source"
import {
  SessionTransferCore,
  SessionTransferEvidence,
  SessionTransferSnapshots,
  SessionTransferWorkspaces,
  SessionTransferEnvironments,
} from "@ericsanchezok/synergy-harness/session/transfer"

export type MemberRuntimeOptions = Pick<
  AgentRuntimeOptions,
  | "signal"
  | "logging"
  | "startupReporter"
  | "storageReporter"
  | "maintenanceReporter"
  | "reporter"
  | "recoveryReporter"
  | "migrationOutput"
> & {
  home: string
  identity: RuntimeIdentity
  environment?: Readonly<Record<string, string | undefined>>
  entry?: RuntimeLaunch["entry"]
  ca?: string | string[]
  listen?: z.infer<typeof MemberListener>
  desktop?: z.infer<typeof MemberDesktop>
  handoff?: true
  workspaceCoordinator?: WorkspaceCoordinator
}

export async function openMemberRuntime(input: MemberRuntimeOptions) {
  return openOrganizationRuntime({ ...input, identity: MemberIdentity.parse(input.identity) })
}

export async function openHostedRuntime(
  input: Omit<MemberRuntimeOptions, "identity" | "desktop"> & { identity: HostedIdentity },
) {
  return openOrganizationRuntime({ ...input, identity: HostedIdentity.parse(input.identity) })
}

async function openOrganizationRuntime(input: MemberRuntimeOptions) {
  input = { ...input, ca: Array.isArray(input.ca) ? [...input.ca] : input.ca }
  input.signal?.throwIfAborted()
  const listener = MemberListener.optional().safeParse(input.listen)
  if (!listener.success)
    throw new MemberHomeError("Member Runtime listener requires an explicit port and private credential")
  if (input.handoff !== undefined && (input.handoff !== true || !listener.data))
    throw new MemberHomeError("Mapped handoff controllers require an explicit listening Runtime composition")
  const desktop = MemberDesktop.optional().safeParse(input.desktop)
  if (!desktop.success || (desktop.data && (!listener.data || !MemberDesktopEntry.safeParse(input.entry).success)))
    throw new MemberHomeError("Member Desktop capabilities require a managed Desktop listener and private credential")
  const member = await readRuntimeHome(input.home, input.identity)
  const registration = await readRuntimeRegistration(member.home, member.identity)
  if (!registration || registration.state !== "active")
    throw new MemberHomeError("Member Runtime must be enrolled before startup")
  let bridge: ReturnType<typeof startMemberBridge> | undefined
  let handoff: ReturnType<typeof createRuntimeHandoff> | undefined
  let restartBridge: (() => Promise<void>) | undefined
  let bridgeDrained = false
  const components = [
    localRuntime({
      workers: false,
      environment: "accountID" in member.identity ? "native" : false,
      workspaceCoordinator: input.workspaceCoordinator,
    }),
    ...(listener.data ? [(await import("@ericsanchezok/synergy-server/component")).server()] : []),
    ...(desktop.data ? [(await import("@ericsanchezok/synergy-browser-runtime/component")).browser()] : []),
    {
      ...organizationRuntime(),
      workers: { agent: new URL("./worker.ts", import.meta.url), policy: new URL("./worker.ts", import.meta.url) },
      register() {
        registerMemberSources(member.identity, member.restoration)
        RuntimeMaintenance.register("organization-bridge", {
          version: 1,
          order: 200,
          async suspend(context) {
            await RuntimeMaintenance.assertDraining(context.lease)
          },
          async drain(context) {
            await RuntimeMaintenance.assertDraining(context.lease)
            await bridge?.close()
            await handoff?.close()
            bridgeDrained = true
          },
          async inspect(context) {
            context.signal.throwIfAborted()
            return bridgeDrained
              ? []
              : [
                  {
                    code: "organization_bridge_active",
                    owner: "organization-bridge",
                    label: "Drain the installed organization bridge and accepted receipts",
                    recoverable: true,
                  },
                ]
          },
          async release(context) {
            await RuntimeMaintenance.assertReleasing(context.lease)
          },
          async released(context) {
            await RuntimeMaintenance.assertReleased(context.lease)
            if (RuntimeContext.isReady()) await restartBridge?.()
          },
        })
        OrganizationWorkspaceFileSource.register(member.identity)
        OrganizationLocalProjects.register(member.identity)
        OrganizationSessionReads.register(member.identity, registration.runtimeID)
        SessionTransferCore.register()
        SessionTransferEvidence.register()
        SessionTransferSnapshots.register()
        SessionTransferWorkspaces.register()
        OrganizationHandoffWorkspaceTarget.register()
        OrganizationHandoffWorkspaceSource.register()
        SessionTransferEnvironments.register()
        registerOrganizationTransferOwner()
        if (!("accountID" in member.identity)) {
          OrganizationRuntimeNative.register({ identity: member.identity, ca: input.ca })
          RuntimeMaintenance.configure({
            required: [
              "sessions",
              "loop-jobs",
              "environments",
              "cortex",
              "organization-bridge",
              "native-processes",
              "workspace-access",
              "workspace-mounts",
              "workspace-operations",
              "workspace-moves",
            ],
          })
        }
      },
      services() {
        const start = async () => {
          const context = RuntimeContext.current()
          handoff = input.handoff
            ? createRuntimeHandoff({
                identity: member.identity,
                runtimeID: registration.runtimeID,
                ca: input.ca,
              })
            : undefined
          bridgeDrained = false
          bridge = startMemberBridge({
            home: member.home,
            identity: member.identity,
            buildVersion: version,
            ca: input.ca,
            signal: input.signal,
            commands: context.bind((connection, signal, resources) => {
              const intake = createCommandIntake({
                identity: connection.signingIdentity,
                runtimeID: connection.runtimeID,
                accountID: "accountID" in member.identity ? member.identity.accountID : undefined,
                connectionEpoch: connection.connectionEpoch,
                signal,
              })
              attachMemberExecution({ connection, signal, resources, intake, origin: member.origin, ca: input.ca })
              const closeReleaseObserver = startExecutionReleaseObserver({ connection, intake, resources, signal })
              return {
                create: context.bind(intake.create),
                control: context.bind(intake.control),
                input: context.bind(intake.input),
                decision: context.bind(intake.decision),
                query: context.bind(intake.query),
                skip: context.bind(intake.skip),
                close: context.bind(closeReleaseObserver),
              }
            }),
            sync: true,
            ...(handoff
              ? {
                  handoff: context.bind(handoff.dispatch),
                  handoffInspection: context.bind(handoff.inspection),
                  handoffVersion: 6 as const,
                }
              : {}),
            notifications: true,
            read: context.bind(OrganizationSessionReads.remote),
            interactions: context.bind(OrganizationSessionReads.interactions),
            onConnected: context.bind((connection, signal) => {
              const exporter = startMemberSyncExporter({ identity: member.identity, connection, signal })
              const stopNotifications = startMemberNotifications(connection, signal)
              void exporter.flush()
              return () => {
                stopNotifications()
                return exporter.close()
              }
            }),
          })
          void bridge.closed.then((result) => {
            if (result.kind === "closed") return
            Log.create({ service: "organization-runtime" }).warn("Member bridge stopped", {
              kind: result.kind,
              code: result.error?.code,
            })
          })
        }
        restartBridge = start
        return {
          resident: {
            async start() {
              await start()
            },
            async stop() {
              await bridge?.close()
              bridgeDrained = true
              await handoff?.close()
            },
          },
        }
      },
    },
  ]
  return openAgentRuntime({
    home: member.root,
    host: createLocalHost({
      home: member.home,
      root: member.root,
      entry: input.entry,
      env: {
        ...memberEnvironment(member, input.environment ?? process.env),
        ...(listener.data ? { SYNERGY_SERVER_TOKEN: listener.data.token } : {}),
        ...(desktop.data ? { SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: desktop.data.browserToken } : {}),
      },
    }),
    components,
    features: FeatureSelection.resolve(components),
    mode: listener.data ? "server" : "oneshot",
    listen: !!listener.data,
    network: listener.data ? { hostname: "127.0.0.1", port: listener.data.port } : undefined,
    signal: input.signal,
    logging: input.logging,
    startupReporter: input.startupReporter,
    storageReporter: input.storageReporter,
    maintenanceReporter: input.maintenanceReporter,
    reporter: input.reporter,
    recoveryReporter: input.recoveryReporter,
    migrationOutput: input.migrationOutput,
  })
}
