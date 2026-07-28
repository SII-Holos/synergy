import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { HolosAccounts } from "../../src/holos/accounts"
import { ensureMigrations, getMigrationStatus, resetMigrations } from "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"

const migrationId = "20260728-provision-clarus-channel-account"
const originalHome = process.env["SYNERGY_TEST_HOME"]
const originalSynergyHome = process.env["SYNERGY_HOME"]
let home: string

function migration() {
  const result = MigrationRegistry.list()
    .get("holos")
    ?.find((entry) => entry.id === migrationId)
  expect(result).toBeDefined()
  return result!
}

async function resetConfig() {
  Config.global.reset()
  await Config.state.resetAll()
}

async function runMigration() {
  await migration().up(() => {})
}

async function seedFeishuChannel() {
  await Config.domainUpdate(
    "channels",
    {
      channel: {
        feishu: Config.ChannelFeishu.parse({
          type: "feishu",
          accounts: {
            default: {
              appId: "app",
              appSecret: "secret",
            },
          },
        }),
      },
    },
    { mode: "replace-domain" },
  )
}

function expectFeishuChannel(config: Config.Info) {
  const feishu = config.channel?.feishu
  expect(feishu?.type).toBe("feishu")
  if (feishu?.type !== "feishu") throw new Error("Expected Feishu Channel config")
  expect(feishu.accounts.default.appId).toBe("app")
}

describe.serial("Holos Clarus Channel account migration", () => {
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(process.env["SYNERGY_TEST_ROOT"]!, "holos-clarus-migration-"))
    delete process.env["SYNERGY_HOME"]
    process.env["SYNERGY_TEST_HOME"] = home
    await resetConfig()
  })

  afterEach(async () => {
    resetMigrations()
    if (originalSynergyHome === undefined) delete process.env["SYNERGY_HOME"]
    else process.env["SYNERGY_HOME"] = originalSynergyHome
    if (originalHome === undefined) delete process.env["SYNERGY_TEST_HOME"]
    else process.env["SYNERGY_TEST_HOME"] = originalHome
    await resetConfig()
    await fs.rm(home, { recursive: true, force: true })
  })

  test("provisions a disabled Clarus account for an existing active Holos identity", async () => {
    await seedFeishuChannel()
    await HolosAccounts.saveAndActivateAccount("agent_existing", "secret_existing")

    await runMigration()

    const config = await Config.globalResolved()
    expect(config.channel?.clarus).toEqual({
      type: "clarus",
      accounts: {
        agent_existing: { enabled: false },
      },
    })
    expectFeishuChannel(config)
    expect(config.holos).toBeUndefined()
  })

  test("leaves fresh state unchanged when there is no active Holos identity", async () => {
    await seedFeishuChannel()

    await runMigration()

    const config = await Config.globalResolved()
    expect(config.channel?.clarus).toBeUndefined()
    expectFeishuChannel(config)
  })

  test("preserves explicit Clarus settings and is idempotent", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_existing", "secret_existing")
    await Config.domainUpdate(
      "channels",
      {
        channel: {
          clarus: {
            type: "clarus",
            accounts: {
              agent_existing: {
                enabled: true,
                apiUrl: "https://clarus.example.com",
                agent: "synergy-max",
              },
              agent_other: { enabled: false },
            },
          },
        },
      },
      { mode: "replace-domain" },
    )

    await runMigration()
    const first = await Bun.file(path.join(Global.Path.config, "synergy.d", "90-channels.jsonc")).text()
    await runMigration()
    const second = await Bun.file(path.join(Global.Path.config, "synergy.d", "90-channels.jsonc")).text()

    expect(second).toBe(first)
    expect((await Config.globalResolved()).channel?.clarus).toEqual({
      type: "clarus",
      accounts: {
        agent_existing: {
          enabled: true,
          apiUrl: "https://clarus.example.com",
          agent: "synergy-max",
        },
        agent_other: { enabled: false },
      },
    })
  })

  test("does not provision from a malformed Holos account store", async () => {
    await seedFeishuChannel()
    await fs.mkdir(path.dirname(Global.Path.authHolosAccounts), { recursive: true })
    await Bun.write(Global.Path.authHolosAccounts, '{"activeAccountId":"agent_broken","accounts":[]}')

    await runMigration()

    const config = await Config.globalResolved()
    expect(config.channel?.clarus).toBeUndefined()
    expectFeishuChannel(config)
  })

  test("runs after credential migration and is tracked by the startup migration runner", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_existing", "secret_existing")
    resetMigrations()

    const first = await ensureMigrations({ output: "silent", targetDomain: "holos" })
    const status = (await getMigrationStatus("holos")).holos
    const completedIds = status.completed.map((entry) => entry.id)
    resetMigrations()
    const second = await ensureMigrations({ output: "silent", targetDomain: "holos" })

    expect(first.completed).toBeGreaterThan(0)
    expect(completedIds).toContain(migrationId)
    expect(completedIds.indexOf("20260620-migrate-holos-legacy-credentials")).toBeLessThan(
      completedIds.indexOf(migrationId),
    )
    expect(status.pending).toEqual([])
    expect(second.upToDateDomains).toBe(1)
    expect((await Config.globalResolved()).channel?.clarus?.accounts.agent_existing).toEqual({ enabled: false })
  })
})
