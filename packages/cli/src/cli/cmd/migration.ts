import { cmd } from "./cmd"
import { runMigrations, rollbackMigrations, getMigrationStatus } from "@ericsanchezok/synergy-harness/migration"
import { UI } from "../../util/ui"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"

export const MigrationCommand = cmd({
  command: "migration",
  describe: "manage schema and data migrations",
  builder: (yargs) =>
    yargs
      .command(
        "status [domain]",
        "show migration status for a domain or all domains",
        (yargs) =>
          yargs.positional("domain", {
            describe: "migration domain to check",
            type: "string",
          }),
        async (args) => {
          const status = await getMigrationStatus(args.domain as string | undefined)
          for (const [domain, { completed, pending }] of Object.entries(status)) {
            UI.println(`\n${UI.Style.TEXT_HIGHLIGHT_BOLD}${domain}${UI.Style.TEXT_NORMAL}`)
            if (completed.length > 0) {
              for (const m of completed) {
                UI.println(`  ✓ ${m.id} — ${m.description}`)
              }
            }
            if (pending.length > 0) {
              for (const m of pending) {
                UI.println(`  · ${m.id} — ${m.description}`)
              }
            }
            if (completed.length === 0 && pending.length === 0) {
              UI.println(`  (no migrations registered)`)
            }
          }
          UI.println()
        },
      )
      .command(
        "run [domain]",
        "run pending migrations",
        (yargs) =>
          yargs
            .positional("domain", {
              describe: "migration domain to run (default: all)",
              type: "string",
            })
            .option("dry-run", {
              describe: "show what would run without executing",
              type: "boolean",
              default: false,
            }),
        async (args) => {
          await runMigrations({
            dryRun: args.dryRun as boolean,
            targetDomain: args.domain as string | undefined,
            output: "interactive",
          })
        },
      )
      .command(
        "rollback <domain> <id>",
        "roll back migrations up to and including the specified migration ID",
        (yargs) =>
          yargs
            .positional("domain", {
              describe: "migration domain",
              type: "string",
              demandOption: true,
            })
            .positional("id", {
              describe: "migration ID to roll back to (inclusive)",
              type: "string",
              demandOption: true,
            }),
        async (args) => {
          await rollbackMigrations(args.domain as string, args.id as string)
        },
      )
      .command(
        "generate <domain> <description>",
        "generate a new migration file for a domain",
        (yargs) =>
          yargs
            .positional("domain", {
              describe: "migration domain (e.g. library, session)",
              type: "string",
              demandOption: true,
            })
            .positional("description", {
              describe: "short description of what the migration does",
              type: "string",
              demandOption: true,
            }),
        async (args) => {
          const domain = args.domain as string
          const description = args.description as string

          // Validate domain exists in registry
          const existing = MigrationRegistry.list().get(domain)

          const id = generateMigrationId()
          const template = [
            `  {`,
            `    id: "${id}",`,
            `    description: "${description}",`,
            `    async up(progress) {`,
            `      // TODO: implement migration`,
            `      progress(1, 1)`,
            `    },`,
            `  },`,
          ].join("\n")

          UI.println()
          UI.println(`${UI.Style.TEXT_INFO_BOLD}Generated migration: ${id}${UI.Style.TEXT_NORMAL}`)
          UI.println()
          if (existing) {
            UI.println(`Add the following to the migrations registered for domain "${domain}":`)
          } else {
            UI.println(`Domain "${domain}" is not yet registered. Create a migration file and register it.`)
          }
          UI.println()
          // eslint-disable-next-line no-console
          console.log(template)
          UI.println()
        },
      )
      .demandCommand(),
  async handler() {},
})

function generateMigrationId(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}${m}${d}-TODO-domain-description`
}
