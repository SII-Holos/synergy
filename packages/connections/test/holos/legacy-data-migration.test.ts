import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { migrations } from "../../src/holos/migration"

const originalHome = process.env.SYNERGY_HOME
const originalTestHome = process.env.SYNERGY_TEST_HOME
let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "holos-upgrade-"))
  delete process.env.SYNERGY_HOME
  process.env.SYNERGY_TEST_HOME = home
})
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNERGY_HOME
  else process.env.SYNERGY_HOME = originalHome
  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome
  await fs.rm(home, { recursive: true, force: true })
})
async function run(id: string) {
  const progress: number[][] = []
  const migration = migrations.find((migration) => migration.id === id)
  if (!migration) throw new Error(`Missing migration ${id}`)
  await migration.up((done, total) => progress.push([done, total]))
  return progress
}

test("profile migration removes local labels while retaining credentials and unknown account metadata", async () => {
  const original = {
    activeAccountId: "agent_a",
    extra: { preserved: true },
    accounts: {
      agent_a: { agentId: "agent_a", label: "retired", secretKey: "fixture-only", remote: { name: "Remote" } },
      agent_b: { agentId: "agent_b", secretKey: "fixture-b" },
      malformed: null,
    },
  }
  await Bun.write(Global.Path.authHolosAccounts, JSON.stringify(original))
  await run("20260629-holos-account-profile-source-of-truth")
  expect(await Bun.file(Global.Path.authHolosAccounts).json()).toEqual({
    ...original,
    accounts: {
      ...original.accounts,
      agent_a: {
        agentId: "agent_a",
        secretKey: "fixture-only",
        remote: { name: "Remote" },
      },
    },
  })
  expect((await fs.stat(Global.Path.authHolosAccounts)).mode & 0o777).toBe(0o600)
  const first = await Bun.file(Global.Path.authHolosAccounts).text()
  await run("20260629-holos-account-profile-source-of-truth")
  expect(await Bun.file(Global.Path.authHolosAccounts).text()).toBe(first)
  await Bun.write(Global.Path.authHolosAccounts, '{"accounts":[]}')
  await run("20260629-holos-account-profile-source-of-truth")
  expect(await Bun.file(Global.Path.authHolosAccounts).text()).toBe('{"accounts":[]}')
})

test("mailbox upgrade relocates legacy contacts and preserves current contacts across repeated upgrades", async () => {
  for (const subsystem of ["friend_requests", "message_queue", "friend_reply", "auto_turns"])
    await Storage.write(["holos", subsystem, "old"], { retired: true })
  await Storage.write(StoragePath.holosContact("old"), {
    id: "old",
    holosId: "remote",
    name: "Friend",
    status: "blocked",
    config: { blocked: false },
    addedAt: 12,
  })
  await Storage.write(StoragePath.holosContact("blocked"), { id: "blocked", name: "", bio: "old", status: "blocked" })
  const current = { id: "current", name: "Current", blocked: false, addedAt: 10, ownerMetadata: { retained: true } }
  await Storage.write(StoragePath.holosContact("current"), current)
  expect((await run("20260619-holos-mailbox-cleanup")).at(-1)).toEqual([3, 3])
  expect(await Storage.read<Record<string, unknown>>(StoragePath.holosContact("remote"))).toEqual({
    id: "remote",
    name: "Friend",
    blocked: false,
    addedAt: 12,
  })
  expect(await Storage.list(StoragePath.holosContactsRoot())).not.toContainEqual(StoragePath.holosContact("old"))
  expect(await Storage.read<Record<string, unknown>>(StoragePath.holosContact("blocked"))).toMatchObject({
    id: "blocked",
    name: "Unknown",
    blocked: true,
  })
  for (const subsystem of ["friend_requests", "message_queue", "friend_reply", "auto_turns"])
    expect(await Storage.list(["holos", subsystem])).toEqual([])
  await run("20260619-holos-mailbox-cleanup")
  expect(await Storage.read<Record<string, unknown>>(StoragePath.holosContact("current"))).toEqual(current)
  await Storage.removeTree(StoragePath.holosContactsRoot())
  expect(await run("20260619-holos-mailbox-cleanup")).toEqual([[1, 1]])
})

test("endpoint upgrade archives only unreachable Holos sessions without losing unknown state", async () => {
  const key = (scope: string, id: string) =>
    StoragePath.sessionInfo(Identifier.asScopeID(scope), Identifier.asSessionID(id))
  const state = { endpoint: { kind: "holos" }, time: { created: 42 }, research: { nested: ["preserve"] } }
  await Storage.write(key("home", "ses_legacy"), state)
  await Storage.write(key("global", "ses_archived"), { ...state, time: { archived: 17 } })
  await Storage.write(key("scope_local", "ses_current"), { endpoint: { kind: "channel" }, time: { created: 13 } })
  expect(await run("20260620-archive-holos-endpoint-sessions")).toEqual([[1, 1]])
  const migrated = await Storage.read<typeof state & { time: { archived: number } }>(key("home", "ses_legacy"))
  expect(migrated).toMatchObject(state)
  expect(migrated.time.archived).toBeGreaterThan(42)
  expect(await Storage.read<Record<string, unknown>>(key("global", "ses_archived"))).toEqual({
    ...state,
    time: { archived: 17 },
  })
  expect(await Storage.read<Record<string, unknown>>(key("scope_local", "ses_current"))).toEqual({
    endpoint: { kind: "channel" },
    time: { created: 13 },
  })
  await run("20260620-archive-holos-endpoint-sessions")
  expect(await Storage.read<Record<string, unknown>>(key("home", "ses_legacy"))).toEqual(migrated)
})
