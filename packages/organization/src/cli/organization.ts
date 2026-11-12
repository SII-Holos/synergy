import fs from "node:fs/promises"
import path from "node:path"
import { cmd, type CommandModule } from "@ericsanchezok/synergy-util/cli-command"
import { openOrganizationService } from "../service"
import { readOrganizationConfiguration } from "../configuration"
import { loadOrganizationInfrastructure } from "../infrastructure"
import { OrganizationInviteCommand } from "./invite"
import { OrganizationBackupCommand, OrganizationRestoreCommand } from "./backup"
import { explicitOrganizationHome as explicitHome } from "./home"

export const OrganizationCommand = cmd({
  command: "org",
  aliases: ["organization"],
  describe: "initialize, administer or serve a dedicated organization",
  builder: (yargs) => {
    for (const command of organizationCommands) yargs.command(command)
    return yargs.demandCommand()
  },
  handler() {},
})

export const OrganizationInitCommand = cmd({
  command: "init",
  aliases: ["bootstrap"],
  describe: "create a single-use initialization token in a new private file; print JSON metadata",
  builder: (yargs) =>
    yargs
      .option("output", { type: "string", demandOption: true, describe: "absolute path for a new private token file" })
      .check((args) => {
        explicitHome()
        if (!path.isAbsolute(args.output)) throw new Error("Initialization output must be an absolute path")
        return true
      }),
  async handler(args) {
    const home = explicitHome()
    const configuration = await readOrganizationConfiguration(home)
    const file = await fs.open(args.output, "wx", 0o600)
    let written = false
    try {
      await using service = await openOrganizationService({
        home,
        authentication: configuration.authentication,
        ...(await loadOrganizationInfrastructure(configuration.infrastructure)),
      })
      const deployment = await service.deployment()
      const token = await service.bootstrapToken()
      await file.writeFile(
        JSON.stringify({ orgID: deployment.orgID, deploymentIncarnation: deployment.deploymentIncarnation, token }) +
          "\n",
      )
      await file.sync()
      written = true
      console.log(JSON.stringify({ ready: true, orgID: deployment.orgID, output: args.output }))
    } finally {
      await file.close()
      if (!written) await fs.rm(args.output, { force: true })
    }
  },
})

export const OrganizationServeCommand = cmd({
  command: "serve",
  describe: "serve organization APIs without Agent execution; print JSON readiness",
  builder: (yargs) =>
    yargs
      .option("origin", {
        type: "string",
        demandOption: true,
        describe: "exact public HTTPS origin served by the TLS reverse proxy",
      })
      .option("port", {
        type: "number",
        demandOption: true,
        describe: "explicit local HTTP port (0 selects an available port)",
      })
      .option("hostname", {
        type: "string",
        default: "127.0.0.1",
        describe: "HTTP listening address behind the TLS reverse proxy",
      })
      .option("web", {
        type: "string",
        describe: "absolute directory containing the built organization authorization page",
      })
      .check((args) => {
        explicitHome()
        const origin = new URL(args.origin)
        if (origin.protocol !== "https:" || origin.origin !== args.origin)
          throw new Error("Public origin must be an exact HTTPS origin")
        if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)
          throw new Error("Port must be an integer between 0 and 65535")
        if (args.web && !path.isAbsolute(args.web)) throw new Error("Organization Web directory must be absolute")
        return true
      }),
  async handler(args) {
    const stopped = Promise.withResolvers<void>()
    const stop = () => stopped.resolve()
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      const home = explicitHome()
      const configuration = await readOrganizationConfiguration(home)
      await using service = await openOrganizationService({
        ...configuration,
        ...(await loadOrganizationInfrastructure(configuration.infrastructure)),
        home,
        publicOrigin: args.origin,
        web: args.web ? { directory: args.web } : undefined,
      })
      const server = Bun.serve({
        hostname: args.hostname,
        port: args.port,
        fetch: service.fetch,
        websocket: service.websocket,
      })
      try {
        const deployment = await service.deployment()
        console.log(
          JSON.stringify({
            ready: true,
            executesAgents: false,
            orgID: deployment.orgID,
            deploymentIncarnation: deployment.deploymentIncarnation,
            url: server.url.toString(),
          }),
        )
        await stopped.promise
      } finally {
        await server.stop(true)
      }
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  },
})

export const organizationCommands = [
  OrganizationInitCommand,
  OrganizationServeCommand,
  OrganizationInviteCommand,
  OrganizationBackupCommand,
  OrganizationRestoreCommand,
] as unknown as CommandModule[]
