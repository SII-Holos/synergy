import { z } from "zod"
import path from "node:path"
import { cmd, type CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import { prepareHostedHome, prepareMemberHome, RuntimeIdentity } from "../home"
import { upgradeOrganizationRuntimeHome } from "../runtime"
import { enrollRuntime } from "../enrollment"
import { readRuntimeRegistration } from "../registration"
import { RuntimeRegistrationRequest } from "../launch"
import { MemberHomeError } from "../record"
import { readMachineInput } from "./input"
import { explicitHome, serveSupervisedRuntime } from "./supervisor"
import { createCleanupCommand } from "./cleanup"

export const OrganizationRuntimeRegisterCommand = cmd({
  command: "register",
  describe: "prepare a dedicated machine Home or consume its ticket from a private stdin request",
  builder: (yargs) =>
    yargs
      .option("base-directory", {
        type: "string",
        demandOption: true,
        describe: "absolute parent directory for organization-qualified machine Homes",
      })
      .check((args) => {
        if (!path.isAbsolute(args["base-directory"]))
          throw new MemberHomeError("Machine registration requires an absolute base directory")
        return true
      }),
  async handler(args) {
    const input = await readMachineInput(RuntimeRegistrationRequest)
    const base = { baseDirectory: args["base-directory"], origin: input.origin }
    const home =
      "accountID" in input.identity
        ? await prepareMemberHome({ ...base, identity: input.identity })
        : await prepareHostedHome({ ...base, identity: input.identity })
    try {
      const registration = input.ticket
        ? await enrollRuntime({ home: home.home, identity: home.identity, ticket: input.ticket, ca: input.ca })
        : await readRuntimeRegistration(home.home, home.identity)
      console.log(
        JSON.stringify({
          state: registration?.state ?? "prepared",
          kind: "accountID" in home.identity ? "member" : "hosted",
          home: home.home,
          identity: home.identity,
          publicKey: home.publicKey,
          ...(registration
            ? { runtimeID: registration.runtimeID, deploymentIncarnation: registration.deploymentIncarnation }
            : {}),
        }),
      )
    } finally {
      input.ticket = undefined
    }
  },
})

export const OrganizationRuntimeServeCommand = cmd({
  command: "serve",
  describe: "serve an enrolled machine from a private stdin launch request",
  builder: (yargs) =>
    yargs
      .option("kind", {
        choices: ["member", "hosted"] as const,
        demandOption: true,
        describe: "machine identity kind of the selected dedicated Home",
      })
      .check(() => {
        explicitHome()
        return true
      }),
  handler: (args) => serveSupervisedRuntime(args.kind),
})

export const OrganizationRuntimeUpgradeCommand = cmd({
  command: "upgrade",
  describe: "explicitly advance an enrolled Runtime Home reader under native maintenance; print JSON metadata",
  builder: (yargs) =>
    yargs
      .option("request-id", {
        type: "string",
        demandOption: true,
        describe: "stable identifier for this exact Home reader upgrade and its retries",
      })
      .check((args) => {
        explicitHome()
        z.string().min(1).max(128).parse(args["request-id"])
        return true
      })
      .epilog(
        "Private stdin requires version:1 and the original member or Hosted identity. Stop ordinary serving and select its existing SYNERGY_HOME. Failed or cancelled upgrades stay held for the same request; successful completion requires a separate serve restart.",
      ),
  async handler(args) {
    const input = await readMachineInput(
      z.strictObject({ version: z.literal(1), identity: RuntimeIdentity }),
      "native Home reader upgrade request",
    )
    const controller = new AbortController()
    const stop = () => controller.abort(new Error("Runtime Home reader upgrade cancelled"))
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      console.log(
        JSON.stringify(
          await upgradeOrganizationRuntimeHome({
            home: explicitHome(),
            identity: input.identity,
            requestID: args["request-id"],
            signal: controller.signal,
          }),
        ),
      )
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  },
})

export const organizationRuntimeCommands = [
  OrganizationRuntimeRegisterCommand,
  OrganizationRuntimeServeCommand,
  createCleanupCommand(),
  OrganizationRuntimeUpgradeCommand,
] as unknown as CommandModule[]

export const OrganizationRuntimeCommand = cmd({
  command: "org-runtime",
  describe: "register, serve, upgrade or clean up an independent organization Runtime",
  builder: (yargs) => {
    for (const command of organizationRuntimeCommands) yargs.command(command)
    return yargs.demandCommand()
  },
  handler() {},
})
