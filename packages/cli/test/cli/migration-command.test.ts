import { UI } from "../../src/util/ui"
import { expect, test } from "bun:test"
import yargs from "yargs"
import { MigrationCommand } from "../../src/cli/cmd/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { getMigrationStatus } from "@ericsanchezok/synergy-harness/migration"
import { Global } from "@ericsanchezok/synergy-harness/global"
import path from "node:path"
import fs from "node:fs/promises"

const domain = "cli-command-fixture"
const id = "20260908-cli-command-fixture"
const output: string[] = []
const invoke = (args: string[]) => yargs(args).exitProcess(false).command(MigrationCommand).parseAsync()

test("migration commands expose pending/completed state and preserve the owner after package relocation", async () => {
  const marker = path.join(Global.Path.data, "cli-migration-fixture.json")
  MigrationRegistry.register(domain, [
    {
      id,
      description: "fixture migration",
      async up(progress) {
        await Bun.write(marker, "applied")
        progress(1, 1)
      },
      async down(progress) {
        await fs.rm(marker, { force: true })
        progress(1, 1)
      },
    },
  ])
  const original = UI.println
  const log = console.log
  UI.println = (...messages) => {
    output.push(messages.join(" "))
  }
  console.log = (...args) => {
    output.push(args.join(" "))
  }
  try {
    await invoke(["migration", "status", domain])
    expect(output.join("")).toContain(id)
    await invoke(["migration", "run", domain, "--dry-run"])
    expect(await Bun.file(marker).exists()).toBe(false)
    await invoke(["migration", "run", domain])
    expect(await Bun.file(marker).text()).toBe("applied")
    await invoke(["migration", "status", domain])
    expect((await getMigrationStatus(domain))[domain].completed.map((item) => item.id)).toContain(id)
    await invoke(["migration", "generate", domain, "change owner field"])
    expect(output.join("")).toContain(`registered for domain "${domain}"`)
    expect(output.join("")).toContain('description: "change owner field"')
    await invoke(["migration", "generate", "unknown-cli-fixture", "new domain"])
    expect(output.join("")).toContain('Domain "unknown-cli-fixture" is not yet registered')
    await invoke(["migration", "rollback", domain, id])
    expect(await Bun.file(marker).exists()).toBe(false)
    expect((await getMigrationStatus(domain))[domain].pending.map((item) => item.id)).toContain(id)
  } finally {
    UI.println = original
    console.log = log
    MigrationRegistry.unregister(domain)
    await fs.rm(marker, { force: true })
  }
})
