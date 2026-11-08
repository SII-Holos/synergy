import { z } from "zod"
import { RuntimeContext, type RuntimeLaunch } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { openAgentRuntime, type AgentRuntimeOptions } from "@ericsanchezok/synergy-agent-runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { version } from "../package.json" with { type: "json" }
import { readMemberHome, type MemberIdentity } from "./home"
import { readMemberRegistration } from "./registration"
import { MemberHomeError } from "./record"
import { registerMemberSources } from "./sources"
import { MemberDesktop, MemberDesktopEntry, MemberListener } from "./launch"
import { organizationRuntime } from "./component"
import { memberEnvironment } from "./environment"
import { startMemberBridge } from "./bridge"
import { createCommandIntake } from "./command-intake"

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
  identity: MemberIdentity
  environment?: Readonly<Record<string, string | undefined>>
  entry?: RuntimeLaunch["entry"]
  ca?: string | string[]
  listen?: z.infer<typeof MemberListener>
  desktop?: z.infer<typeof MemberDesktop>
}

export async function openMemberRuntime(input: MemberRuntimeOptions) {
  input.signal?.throwIfAborted()
  const listener = MemberListener.optional().safeParse(input.listen)
  if (!listener.success)
    throw new MemberHomeError("Member Runtime listener requires an explicit port and private credential")
  const desktop = MemberDesktop.optional().safeParse(input.desktop)
  if (!desktop.success || (desktop.data && (!listener.data || !MemberDesktopEntry.safeParse(input.entry).success)))
    throw new MemberHomeError("Member Desktop capabilities require a managed Desktop listener and private credential")
  const member = await readMemberHome(input.home, input.identity)
  const registration = await readMemberRegistration(member.home, member.identity)
  if (!registration || registration.state !== "active")
    throw new MemberHomeError("Member Runtime must be enrolled before startup")
  const components = [
    localRuntime({ workers: false, environment: false }),
    ...(listener.data ? [(await import("@ericsanchezok/synergy-server/component")).server()] : []),
    ...(desktop.data ? [(await import("@ericsanchezok/synergy-browser-runtime/component")).browser()] : []),
    {
      ...organizationRuntime(),
      workers: { agent: new URL("./worker.ts", import.meta.url), policy: new URL("./worker.ts", import.meta.url) },
      register: () => registerMemberSources(member.identity),
      services() {
        let bridge: ReturnType<typeof startMemberBridge> | undefined
        return {
          resident: {
            async start() {
              const context = RuntimeContext.current()
              bridge = startMemberBridge({
                home: member.home,
                identity: member.identity,
                buildVersion: version,
                ca: input.ca,
                signal: input.signal,
                commands(connection, signal) {
                  const intake = createCommandIntake({
                    identity: connection.signingIdentity,
                    runtimeID: connection.runtimeID,
                    accountID: member.identity.accountID,
                    connectionEpoch: connection.connectionEpoch,
                    signal,
                  })
                  return {
                    create: context.bind(intake.create),
                    control: context.bind(intake.control),
                    input: context.bind(intake.input),
                    query: context.bind(intake.query),
                    skip: context.bind(intake.skip),
                  }
                },
              })
              void bridge.closed.then((result) => {
                if (result.kind === "closed") return
                Log.create({ service: "organization-runtime" }).warn("Member bridge stopped", {
                  kind: result.kind,
                  code: result.error?.code,
                })
              })
            },
            async stop() {
              await bridge?.close()
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
