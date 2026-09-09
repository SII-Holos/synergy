import type { Argv } from "yargs"
import { cmd } from "../cmd"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { SnapshotLifecycle } from "@ericsanchezok/synergy-harness/session/snapshot-lifecycle"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { SnapshotLease } from "@ericsanchezok/synergy-harness/session/snapshot-lease"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"

interface Input {
  action: "inspect" | "check" | "migrate" | "compact" | "clean"
  scope?: string
  apply?: boolean
  prune?: boolean
}

export async function executeSnapshots(input: Input) {
  let lock: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
  try {
    if (input.apply) lock = await ServerProcessLock.acquire()
    if (input.action === "inspect") return { ok: true, results: await SnapshotMaintenance.inspect(input.scope) }
    if (input.action === "clean") {
      // Skip registerLegacy: it would claim unowned legacy directories right
      // before reclaiming them, so clean never sees its own candidates.
      const scopes = input.scope ? [SnapshotStore.component(input.scope)] : await SnapshotMaintenance.scopes()
      const results = []
      let ok = true
      for (const scopeID of scopes) {
        if (input.apply) await SnapshotLifecycle.recover(scopeID)
        const result = await SnapshotMaintenance.clean(scopeID, { apply: input.apply })
        ok = ok && result.errors.length === 0
        results.push(result)
      }
      return { ok, results }
    }
    if (input.apply) await SnapshotMaintenance.registerLegacy(undefined, input.scope)
    const scopes = input.scope ? [SnapshotStore.component(input.scope)] : await SnapshotMaintenance.scopes()
    const results = []
    let ok = true
    for (const scopeID of scopes) {
      if (input.apply) await SnapshotLifecycle.recover(scopeID)
      if (input.action === "check") {
        const result = await SnapshotMaintenance.check(scopeID)
        ok &&= result.ok
        results.push(result)
      } else if (input.action === "migrate") {
        const result = await SnapshotMaintenance.migrate(scopeID, { apply: input.apply })
        ok &&= !result.results.some((entry) => entry.status === "failed")
        results.push(result)
      } else results.push(await SnapshotMaintenance.compact(scopeID, { apply: input.apply, prune: input.prune }))
    }
    return { ok, results }
  } catch (error) {
    const busy = error instanceof ServerProcessLock.AlreadyRunningError || error instanceof SnapshotLease.BusyError
    return {
      ok: false,
      results: [],
      error: {
        code: busy ? "busy" : "snapshot_storage_error",
        message: busy
          ? "Snapshot maintenance is busy; the running instance was left unchanged"
          : error instanceof Error
            ? error.message
            : String(error),
      },
    }
  } finally {
    await lock?.release()
  }
}

function common(yargs: Argv) {
  return yargs
    .option("scope", { type: "string", describe: "limit maintenance to one Scope ID" })
    .option("json", { type: "boolean", default: false, describe: "emit a structured result" })
}

function mutation(yargs: Argv) {
  return common(yargs).option("apply", {
    type: "boolean",
    default: false,
    describe: "execute the proposed maintenance",
  })
}

function handler(action: Input["action"]) {
  return async (args: { scope?: string; json?: boolean; apply?: boolean; prune?: boolean }) => {
    const result = await executeSnapshots({ action, scope: args.scope, apply: args.apply, prune: args.prune })
    process.stdout.write(JSON.stringify(result, null, args.json ? undefined : 2) + "\n")
    if (!result.ok) process.exitCode = 1
  }
}

const InspectCommand = cmd({
  command: "inspect",
  describe: "show snapshot ownership and logical/allocated storage usage",
  builder: common,
  handler: handler("inspect"),
})
const CheckCommand = cmd({
  command: "check",
  describe: "verify stored objects and historical snapshot roots",
  builder: common,
  handler: handler("check"),
})
const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate legacy snapshots into shared storage (dry-run unless --apply)",
  builder: mutation,
  handler: handler("migrate"),
})
function compact(yargs: Argv) {
  return mutation(yargs).option("prune", {
    type: "boolean",
    default: false,
    describe: "collect unreferenced objects after integrity checks",
  })
}
const CompactCommand = cmd({
  command: "compact",
  describe: "pack shared snapshots (dry-run unless --apply)",
  builder: compact,
  handler: handler("compact"),
})
const CleanCommand = cmd({
  command: "clean",
  describe: "reclaim unowned legacy snapshot directories (dry-run unless --apply)",
  builder: mutation,
  handler: handler("clean"),
})

export const DataSnapshotsCommand = cmd({
  command: "snapshots",
  describe: "inspect and maintain file snapshot storage",
  builder: (yargs) =>
    yargs
      .command(InspectCommand)
      .command(CheckCommand)
      .command(MigrateCommand)
      .command(CompactCommand)
      .command(CleanCommand)
      .demandCommand(),
  handler: async () => {},
})
