import path from "node:path"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { run } from "@ericsanchezok/synergy-cli/server/runtime"
import {
  createManagedStartupReporter,
  createManagedStorageReporter,
  createManagedMigrationReporter,
  createManagedMaintenanceReporter,
  createManagedRecoveryReporter,
} from "@ericsanchezok/synergy-cli/cli/managed-startup"
import { readRuntimeHome } from "../home"
import { enrollRuntime } from "../enrollment"
import { readRuntimeRegistration } from "../registration"
import { MemberHomeError } from "../record"
import { HostedLaunchRequest, MemberDesktopEntry, MemberLaunchRequest } from "../launch"
import { openHostedRuntime, openMemberRuntime } from "../runtime"
import { readMachineInput } from "./input"

export function explicitHome() {
  const home = process.env.SYNERGY_HOME
  if (!home || !path.isAbsolute(home)) throw new MemberHomeError("Member Runtime requires an absolute SYNERGY_HOME")
  const root = process.env.SYNERGY_RUNTIME_ROOT
  if (root && path.resolve(root) !== path.join(path.resolve(home), ".synergy"))
    throw new MemberHomeError("Member Runtime root must match the dedicated Home")
  return path.resolve(home)
}

export function supervisedRuntimeCommand(kind: "member" | "hosted") {
  return cmd({
    command: `${kind}-runtime`,
    describe:
      kind === "member"
        ? "serve a prepared member Runtime from a private supervisor request"
        : "serve a prepared organization-hosted Runtime from a private supervisor request",
    builder: (yargs) =>
      yargs.check(() => {
        explicitHome()
        return true
      }),
    handler: () => serveSupervisedRuntime(kind),
  })
}

export async function serveSupervisedRuntime(kind: "member" | "hosted") {
  const home = explicitHome()
  const input =
    kind === "member"
      ? await readMachineInput(MemberLaunchRequest, "member supervisor request")
      : await readMachineInput(HostedLaunchRequest, "member supervisor request")
  const desktop = "desktop" in input ? input.desktop : undefined
  if (desktop && !MemberDesktopEntry.safeParse(process.env.SYNERGY_RUNTIME_ENTRY).success)
    throw new MemberHomeError("Member Desktop capabilities require a managed Desktop launch")
  const member = await readRuntimeHome(home, input.identity)
  if (input.ticket && input.ticket.runtime.deploymentIncarnation !== input.deploymentIncarnation)
    throw new MemberHomeError("Member supervisor deployment does not match its ticket")
  const registration = input.ticket
    ? await enrollRuntime({ home, identity: member.identity, ticket: input.ticket, ca: input.ca })
    : await readRuntimeRegistration(home, member.identity)
  if (
    !registration ||
    registration.runtimeKind !== kind ||
    registration.deploymentIncarnation !== input.deploymentIncarnation ||
    registration.state !== "active"
  )
    throw new MemberHomeError("Member supervisor deployment does not match its registration")
  input.ticket = undefined
  process.env.SYNERGY_SERVER_TOKEN = input.token
  await run({
    managedReady: true,
    interactive: false,
    printBanner: false,
    printChannelStatus: false,
    network: { hostname: "127.0.0.1", port: input.port },
    startupReporter: createManagedStartupReporter(),
    storageReporter: createManagedStorageReporter(),
    maintenanceReporter: createManagedMaintenanceReporter(),
    migrationReporter: createManagedMigrationReporter(),
    recoveryReporter: createManagedRecoveryReporter(),
    migrationOutput: "silent",
    runtimeFactory: (options) => {
      const common = {
        home,
        entry: options.host?.launch?.entry,
        ca: input.ca,
        listen: { port: input.port, token: input.token },
        handoff: true as const,
        startupReporter: options.startupReporter,
        storageReporter: options.storageReporter,
        maintenanceReporter: options.maintenanceReporter,
        reporter: options.reporter,
        recoveryReporter: options.recoveryReporter,
        migrationOutput: options.migrationOutput,
      }
      return "accountID" in member.identity
        ? openMemberRuntime({ ...common, identity: member.identity, desktop })
        : openHostedRuntime({ ...common, identity: member.identity })
    },
  })
}
