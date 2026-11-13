import path from "node:path"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { OrganizationHandoffRecovery as Recovery } from "@ericsanchezok/synergy-organization-protocol"
import type { HandoffCleanupOpen, HandoffCleanupRuntime } from "../handoff-cleanup-runtime"
import { MemberHomeError } from "../record"
import { readMachineInput } from "./input"

export type CleanupRuntimeFactory = (input: HandoffCleanupOpen) => Promise<HandoffCleanupRuntime>
const open: CleanupRuntimeFactory = async (input) =>
  (await import("../handoff-cleanup-runtime")).openHandoffCleanup(input)

export function createCleanupCommand(factory: CleanupRuntimeFactory = open) {
  async function execute(operation: "list" | "inspect" | "retire", query: { limit?: number; cursor?: string } = {}) {
    const home = process.env.SYNERGY_HOME
    if (
      !home ||
      !path.isAbsolute(home) ||
      (process.env.SYNERGY_RUNTIME_ROOT &&
        path.resolve(process.env.SYNERGY_RUNTIME_ROOT) !== path.join(path.resolve(home), ".synergy"))
    )
      throw new MemberHomeError("Cleanup requires an absolute original SYNERGY_HOME")
    const { HandoffCleanupRequest } = await import("../handoff-cleanup-runtime")
    const input =
      operation === "list"
        ? await readMachineInput(HandoffCleanupRequest, "original machine cleanup request")
        : await readMachineInput(
            HandoffCleanupRequest.extend({ descriptor: Recovery.Descriptor }),
            "original machine cleanup request",
          )
    const abort = new AbortController()
    const interrupt = () => abort.abort(new Error("Original machine cleanup interrupted"))
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", interrupt)
    let runtime: HandoffCleanupRuntime | undefined
    try {
      runtime = await factory({
        version: input.version,
        identity: input.identity,
        deploymentIncarnation: input.deploymentIncarnation,
        ca: input.ca,
        home: path.resolve(home),
        readonly: operation !== "retire",
      })
      const signal = abort.signal
      const result =
        operation === "list"
          ? await runtime.list({ ...query, signal })
          : operation === "inspect"
            ? await runtime.inspect(Recovery.Descriptor.parse("descriptor" in input ? input.descriptor : undefined), {
                signal,
              })
            : await runtime.retire(Recovery.Descriptor.parse("descriptor" in input ? input.descriptor : undefined), {
                signal,
              })
      console.log(JSON.stringify(result))
    } finally {
      try {
        await runtime?.close()
      } finally {
        process.off("SIGINT", interrupt)
        process.off("SIGTERM", interrupt)
      }
    }
  }
  return cmd({
    command: "cleanup",
    describe: "reconcile cancelled native targets using this original machine's retained enrollment",
    builder: (yargs) =>
      yargs
        .command(
          cmd({
            command: "list",
            describe: "list this original machine's outstanding cancelled native targets",
            builder: (query) =>
              query
                .option("limit", {
                  type: "number",
                  default: 50,
                  describe: "maximum number of original targets (1–100)",
                })
                .option("cursor", { type: "string", describe: "cursor returned by the previous cleanup page" })
                .check((args) => {
                  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
                    throw new MemberHomeError("Cleanup page limit must be an integer between 1 and 100")
                  return true
                }),
            handler: (args) => execute("list", { limit: args.limit, cursor: args.cursor }),
          }),
        )
        .command(
          cmd({
            command: "inspect",
            describe: "read only the retained target receipt named in the private stdin descriptor",
            handler: () => execute("inspect"),
          }),
        )
        .command(
          cmd({
            command: "retire",
            describe: "release the named inactive target and submit its original signed cleanup fact",
            handler: () => execute("retire"),
          }),
        )
        .demandCommand()
        .epilog(
          "Private stdin requires version:1, identity:{orgID,accountID,deviceID}, deploymentIncarnation and optional ca. Inspect and retire also require the original descriptor from list. Set SYNERGY_HOME to the enrolled Home.",
        ),
    handler() {},
  })
}
