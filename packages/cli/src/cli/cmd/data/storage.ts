import { cmd } from "../cmd"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { StorageMaintenance } from "@ericsanchezok/synergy-harness/storage/maintenance"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { parseStorageConfiguration } from "@ericsanchezok/synergy-harness/storage/config"

export const DataStorageCommand = cmd({
  command: "storage",
  describe: "inspect, verify, recover, restore backups, and move authoritative Agent storage",
  builder: (yargs) =>
    yargs
      .command(
        "status",
        "show the active dataset and outstanding recovery records",
        () => {},
        async () => {
          const manifest = await StorageBootstrap.status(Global.Path.root)
          if (manifest?.phase !== "active") {
            console.log(
              JSON.stringify(
                { phase: manifest?.phase ?? "uninitialized", backend: manifest?.backend, backupID: manifest?.backupID },
                null,
                2,
              ),
            )
            return
          }
          await using handle = await StorageMaintenance.open({ readonly: true })
          const recovery = await handle.store.list(["storage_recovery"])
          console.log(
            JSON.stringify(
              {
                backend: handle.manifest.backend,
                namespace: handle.manifest.namespace,
                phase: handle.manifest.phase,
                storeID: handle.manifest.storeID,
                artifactStoreID: handle.manifest.artifactStoreID,
                recoveryRecords: recovery.length,
                pendingEvents: await handle.store.pendingEventCount(),
              },
              null,
              2,
            ),
          )
        },
      )
      .command(
        "verify",
        "verify database integrity, record relationships, and artifact content without changing data",
        () => {},
        async () => {
          await using handle = await StorageMaintenance.open({ readonly: true })
          const report = await handle.store.verify()
          const artifacts = await Storage.validateArtifacts(handle)
          console.log(JSON.stringify({ ...report, artifacts }, null, 2))
          if (report.issues.length) process.exitCode = 1
        },
      )
      .command(
        "resume",
        "resume an interrupted upgrade or target switch after acquiring exclusive ownership",
        () => {},
        async () => {
          await using handle = await StorageMaintenance.open({ recover: true })
          console.log(
            JSON.stringify(
              { backend: handle.manifest.backend, phase: handle.manifest.phase, status: "ready" },
              null,
              2,
            ),
          )
        },
      )
      .command(
        "restore-backup <backup> <destination>",
        "restore a verified packed or segmented legacy Home backup into a new Home directory",
        (yargs) =>
          yargs
            .positional("backup", {
              type: "string",
              demandOption: true,
              describe: "Backup directory; unfinished segmented backups also require their original frozen source",
            })
            .positional("destination", {
              type: "string",
              demandOption: true,
              describe: "New .synergy Home directory; it must not already exist",
            }),
        async (args) =>
          console.log(JSON.stringify(await StorageMaintenance.restoreBackup(args.backup, args.destination), null, 2)),
      )
      .command(
        "migrate",
        "copy authoritative data and atomically activate a verified storage target",
        (yargs) =>
          yargs.option("target", {
            type: "string",
            demandOption: true,
            describe:
              "JSONC configuration file containing the target storage domain; credentials use an environment reference",
          }),
        async (args) => {
          const configuration = parseStorageConfiguration(await Bun.file(args.target).text())
          await using handle = await StorageMaintenance.open()
          await StorageBootstrap.migrateTarget({ root: Global.Path.root, store: handle.store, configuration })
          console.log("Storage target migrated and verified. The next Runtime will use the new target.")
        },
      )
      .demandCommand(),
  async handler() {},
})
