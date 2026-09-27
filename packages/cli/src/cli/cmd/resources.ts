import { z } from "zod"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { createSynergyClient, type SynergyClientInstance } from "@ericsanchezok/synergy-sdk/client"

const Connection = z.object({ attach: z.string().url(), scope: z.string().min(1), tokenEnv: z.string().min(1) })
const identifier = { type: "string", demandOption: true } as const
const positive = (value: unknown) => z.number().int().positive().parse(value)
const selected = (value: string) => (value === "none" ? null : value)

async function request(
  args: unknown,
  action: (client: SynergyClientInstance) => Promise<{ data?: unknown; error?: unknown }>,
) {
  const connection = Connection.parse(args)
  const url = new URL(connection.attach)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("--attach requires an HTTP(S) URL without credentials, query or fragment")
  const token = process.env[connection.tokenEnv]
  const client = createSynergyClient({
    baseUrl: url.href.replace(/\/$/, ""),
    scopeID: connection.scope,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  try {
    const result = await action(client)
    if (result.error) {
      console.log(JSON.stringify({ error: result.error }, null, 2))
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(result.data, null, 2))
  } catch {
    console.log(
      JSON.stringify({
        error: {
          name: "RequestIncomplete",
          data: {
            message:
              "The server response was not received. Inspect the resource or existing operation before retrying a mutation.",
          },
        },
      }),
    )
    process.exitCode = 1
  }
}

export const EnvironmentCommand = cmd({
  command: "environment",
  describe: "manage compute on an attached server; print JSON results",
  builder: (yargs) =>
    yargs
      .option("attach", { type: "string", demandOption: true, describe: "target Synergy HTTP server URL" })
      .option("scope", { type: "string", demandOption: true, describe: "Scope ID on the target server" })
      .option("token-env", {
        type: "string",
        default: "SYNERGY_SERVER_TOKEN",
        describe: "environment variable containing the server bearer token",
      })
      .command(EnvironmentProfilesCommand)
      .command(EnvironmentListCommand)
      .command(EnvironmentInspectCommand)
      .command(EnvironmentCreateCommand)
      .command(EnvironmentSelectCommand)
      .command(EnvironmentReconcileCommand)
      .command(EnvironmentReleaseCommand)
      .command(EnvironmentRecoverCommand)
      .command(EnvironmentCancelCommand)
      .demandCommand(),
  async handler() {},
})
export const EnvironmentProfilesCommand = cmd({
  command: "profiles",
  describe: "list configured compute and storage profiles without allocating compute",
  handler: (args) => request(args, (client) => client.environment.profiles()),
})
export const EnvironmentListCommand = cmd({
  command: "list",
  describe: "list selected Environments without allocating compute",
  handler: (args) => request(args, (client) => client.environment.list()),
})
export const EnvironmentInspectCommand = cmd({
  command: "inspect <environmentID>",
  describe: "inspect allocation, leases and retained operations",
  builder: (yargs) => yargs.positional("environmentID", { ...identifier, describe: "Environment ID" }),
  handler: (args) => request(args, (client) => client.environment.activity({ environmentID: args.environmentID })),
})
export const EnvironmentCreateCommand = cmd({
  command: "create <profile>",
  describe: "select an immutable profile without starting compute",
  builder: (yargs) =>
    yargs
      .positional("profile", { ...identifier, describe: "configured Environment profile" })
      .option("request-id", { ...identifier, describe: "stable request ID; reuse for retries of this creation" }),
  handler: (args) =>
    request(args, (client) => client.environment.create({ profile: args.profile, requestID: args.requestId })),
})
export const EnvironmentSelectCommand = cmd({
  command: "select <sessionID> <environmentID>",
  describe: "change Session compute independently of its Workspace",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { ...identifier, describe: "Session ID" })
      .positional("environmentID", { ...identifier, describe: "Environment ID, or none for API-only work" })
      .option("expected", { ...identifier, describe: "currently observed Environment ID, or none" }),
  handler: (args) =>
    request(args, (client) =>
      client.session.setEnvironment({
        sessionID: args.sessionID,
        sessionEnvironmentSelection: {
          environmentID: selected(args.environmentID),
          expectedEnvironmentID: selected(args.expected),
        },
      }),
    ),
})
export const EnvironmentReconcileCommand = cmd({
  command: "reconcile <environmentID>",
  describe: "check the selected allocation without replaying commands",
  builder: (yargs) => yargs.positional("environmentID", { ...identifier, describe: "Environment ID" }),
  handler: (args) => request(args, (client) => client.environment.reconcile({ environmentID: args.environmentID })),
})
export const EnvironmentReleaseCommand = cmd({
  command: "release <environmentID>",
  describe: "save mounted files and release idle compute",
  builder: (yargs) =>
    yargs
      .positional("environmentID", { ...identifier, describe: "Environment ID" })
      .option("generation", {
        type: "number",
        demandOption: true,
        describe: "observed allocation generation",
        coerce: positive,
      }),
  handler: (args) =>
    request(args, (client) =>
      client.environment.release({ environmentID: args.environmentID, expectedGeneration: args.generation }),
    ),
})
export const EnvironmentRecoverCommand = cmd({
  command: "recover <environmentID> <operationID>",
  describe: "reconcile an existing operation and retry saving its result",
  builder: (yargs) =>
    yargs
      .positional("environmentID", { ...identifier, describe: "Environment ID" })
      .positional("operationID", { ...identifier, describe: "existing operation ID" })
      .option("file", {
        type: "boolean",
        default: false,
        describe: "recover a file mutation instead of process execution",
      }),
  handler: (args) =>
    request(args, (client) =>
      args.file
        ? client.environment.recoverFile({ environmentID: args.environmentID, operationID: args.operationID })
        : client.environment.recoverExecution({ environmentID: args.environmentID, operationID: args.operationID }),
    ),
})
export const EnvironmentCancelCommand = cmd({
  command: "cancel <environmentID> <operationID>",
  describe: "request cancellation of an existing process and drain its result",
  builder: (yargs) =>
    yargs
      .positional("environmentID", { ...identifier, describe: "Environment ID" })
      .positional("operationID", { ...identifier, describe: "existing execution operation ID" }),
  handler: (args) =>
    request(args, (client) =>
      client.environment.cancelExecution({ environmentID: args.environmentID, operationID: args.operationID }),
    ),
})

export const WorkspaceCommand = cmd({
  command: "workspace",
  describe: "manage durable files on an attached server; print JSON results",
  builder: (yargs) =>
    yargs
      .option("attach", { type: "string", demandOption: true, describe: "target Synergy HTTP server URL" })
      .option("scope", { type: "string", demandOption: true, describe: "Scope ID on the target server" })
      .option("token-env", {
        type: "string",
        default: "SYNERGY_SERVER_TOKEN",
        describe: "environment variable containing the server bearer token",
      })
      .command(WorkspaceListCommand)
      .command(WorkspaceCreateCommand)
      .command(WorkspaceRegisterCommand)
      .command(WorkspaceSelectCommand)
      .command(WorkspaceDetachCommand)
      .command(WorkspaceOperationsCommand)
      .command(WorkspaceRecoverCommand)
      .demandCommand(),
  async handler() {},
})
export const WorkspaceListCommand = cmd({
  command: "list",
  describe: "list durable Workspaces and their current bindings",
  handler: (args) => request(args, (client) => client.workspace.list()),
})
export const WorkspaceCreateCommand = cmd({
  command: "create <profile>",
  describe: "create an object-backed Workspace without allocating compute",
  builder: (yargs) =>
    yargs
      .positional("profile", { ...identifier, describe: "configured storage profile" })
      .option("name", { type: "string", describe: "display name for this Workspace" }),
  handler: (args) =>
    request(args, (client) => client.workspace.createObjects({ profile: args.profile, name: args.name })),
})
export const WorkspaceRegisterCommand = cmd({
  command: "register <path>",
  describe: "register a directory on the target server's native host",
  builder: (yargs) =>
    yargs.positional("path", { ...identifier, describe: "absolute directory path on the target host" }),
  handler: (args) => request(args, (client) => client.workspace.register({ path: args.path })),
})
export const WorkspaceSelectCommand = cmd({
  command: "select <sessionID> <workspaceID>",
  describe: "change Session files independently of its Environment",
  builder: (yargs) =>
    yargs
      .positional("sessionID", { ...identifier, describe: "Session ID" })
      .positional("workspaceID", { ...identifier, describe: "Workspace ID, or none" })
      .option("generation", {
        type: "number",
        describe: "required binding generation when selecting a Workspace",
        coerce: positive,
      })
      .check((args) => {
        if (args.workspaceID !== "none" && args.generation === undefined)
          throw new Error("Workspace selection requires --generation")
        return true
      }),
  handler: (args) =>
    request(args, (client) =>
      client.session.selectWorkspace({
        sessionID: args.sessionID,
        sessionWorkspaceSelection:
          args.workspaceID === "none"
            ? { mode: "none" }
            : { mode: "workspace", workspaceID: args.workspaceID, workspaceGeneration: args.generation! },
      }),
    ),
})
export const WorkspaceDetachCommand = cmd({
  command: "detach <workspaceID>",
  describe: "save and detach an idle Workspace view",
  builder: (yargs) =>
    yargs
      .positional("workspaceID", { ...identifier, describe: "Workspace ID" })
      .option("revision", {
        type: "number",
        demandOption: true,
        describe: "observed Workspace revision",
        coerce: positive,
      }),
  handler: (args) =>
    request(args, (client) =>
      client.workspace.detach({ workspaceID: args.workspaceID, expectedRevision: args.revision }),
    ),
})
export const WorkspaceOperationsCommand = cmd({
  command: "operations <workspaceID>",
  describe: "list unfinished Workspace mutations",
  builder: (yargs) => yargs.positional("workspaceID", { ...identifier, describe: "Workspace ID" }),
  handler: (args) => request(args, (client) => client.workspace.operations({ workspaceID: args.workspaceID })),
})
export const WorkspaceRecoverCommand = cmd({
  command: "recover <workspaceID> <operationID>",
  describe: "reconcile an existing Workspace mutation without replaying effects",
  builder: (yargs) =>
    yargs
      .positional("workspaceID", { ...identifier, describe: "Workspace ID" })
      .positional("operationID", { ...identifier, describe: "existing operation ID" }),
  handler: (args) =>
    request(args, (client) =>
      client.workspace.recoverOperation({ workspaceID: args.workspaceID, operationID: args.operationID }),
    ),
})
