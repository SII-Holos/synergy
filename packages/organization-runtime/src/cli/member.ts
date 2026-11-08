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
import { readMemberHome } from "../home"
import { readMemberRegistration, enrollMemberRuntime } from "../enrollment"
import { MemberHomeError } from "../record"
import { MemberLaunchRequest } from "../launch"
import { openMemberRuntime } from "../runtime"

function explicitHome() {
  const home = process.env.SYNERGY_HOME
  if (!home || !path.isAbsolute(home)) throw new MemberHomeError("Member Runtime requires an absolute SYNERGY_HOME")
  const root = process.env.SYNERGY_RUNTIME_ROOT
  if (root && path.resolve(root) !== path.join(path.resolve(home), ".synergy"))
    throw new MemberHomeError("Member Runtime root must match the dedicated Home")
  return path.resolve(home)
}

async function request() {
  const chunks: Buffer[] = []
  let bytes = 0
  const deadline = setTimeout(() => process.stdin.destroy(new Error("Supervisor input expired")), 15_000)
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 64 * 1024) throw new Error("Supervisor input exceeds its limit")
      chunks.push(buffer)
    }
    return MemberLaunchRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  } catch {
    throw new MemberHomeError("Invalid or incomplete member supervisor request")
  } finally {
    clearTimeout(deadline)
  }
}

export const MemberRuntimeCommand = cmd({
  command: "member-runtime",
  describe: "serve a prepared member Runtime from a private supervisor request",
  builder: (yargs) =>
    yargs.check(() => {
      explicitHome()
      return true
    }),
  async handler() {
    const home = explicitHome()
    const input = await request()
    const member = await readMemberHome(home, input.identity)
    if (input.ticket && input.ticket.runtime.deploymentIncarnation !== input.deploymentIncarnation)
      throw new MemberHomeError("Member supervisor deployment does not match its ticket")
    const registration = input.ticket
      ? await enrollMemberRuntime({ home, identity: member.identity, ticket: input.ticket, ca: input.ca })
      : await readMemberRegistration(home, member.identity)
    if (
      !registration ||
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
      runtimeFactory: (options) =>
        openMemberRuntime({
          home,
          identity: member.identity,
          entry: options.host?.launch?.entry,
          ca: input.ca,
          listen: { port: input.port, token: input.token },
          startupReporter: options.startupReporter,
          storageReporter: options.storageReporter,
          maintenanceReporter: options.maintenanceReporter,
          reporter: options.reporter,
          recoveryReporter: options.recoveryReporter,
          migrationOutput: options.migrationOutput,
        }),
    })
  },
})
