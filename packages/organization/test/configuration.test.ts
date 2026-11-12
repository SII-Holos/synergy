import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import {
  OrganizationConfigurationError,
  readOrganizationConfiguration,
  readOrganizationConfigurationSnapshot,
} from "../src/configuration"
import { ORGANIZATION_CONFIG_FILENAME, registerConfig } from "../src/config-schema"
import { openOrganizationService } from "../src/service"

async function fixture() {
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-config-"))
  return {
    home,
    file: path.join(home, ".synergy", "config", "synergy.d", ORGANIZATION_CONFIG_FILENAME),
    async write(value: string) {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await Bun.write(this.file, value)
    },
    async [Symbol.asyncDispose]() {
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

test("organization configuration reads only the explicit Home's canonical domain and supports JSONC", async () => {
  await using f = await fixture()
  expect(await readOrganizationConfiguration(f.home)).toEqual({})
  expect(await fs.readdir(f.home)).toEqual([])
  await f.write(`{
    // The dedicated service reads this domain without merging Runtime or legacy settings.
    "organization": { "authentication": { "loginMs": 1000 }, "clientAuthentication": { "clients": [
      { "clientID": "web", "kind": "web", "redirectUri": "https://work.example/callback" },
    ] }, },
  }`)
  for (const file of [
    path.join(f.home, ".synergy", "config", "synergy.jsonc"),
    path.join(path.dirname(f.file), "20-providers.jsonc"),
    path.join(f.home, ".synergy", "synergy.d", ORGANIZATION_CONFIG_FILENAME),
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "invalid unrelated configuration")
  }
  const settings = await readOrganizationConfiguration(f.home)
  expect(settings.authentication).toMatchObject({ loginMs: 1000, hashConcurrency: 2 })
  expect(settings.clientAuthentication).toMatchObject({ accessMs: 900000, clients: [{ clientID: "web" }] })
  await using service = await openOrganizationService({
    ...settings,
    home: f.home,
    publicOrigin: "https://organization.example",
  })
  expect(
    (await service.fetch(new Request("https://organization.example/org/v1/auth/discovery?clientID=web"))).status,
  ).toBe(200)
})

test("invalid organization settings are retained and report metadata without input content", async () => {
  await using f = await fixture()
  const secret = "synthetic-sensitive-input"
  const cases = [
    { text: `{"organization": { invalid ${secret}`, reason: "invalid_json" },
    { text: JSON.stringify({ organization: { unknown: secret } }), reason: "invalid_settings" },
    {
      text: JSON.stringify({
        organization: {
          clientAuthentication: {
            clients: [{ clientID: "web", kind: "web", redirectUri: "{env:ORGANIZATION_CALLBACK}" }],
          },
        },
      }),
      reason: "invalid_settings",
    },
    {
      text: JSON.stringify({ organization: { connections: { heartbeatMs: 2000, offlineMs: 1000 } } }),
      reason: "invalid_settings",
    },
    {
      text: JSON.stringify({ organization: { authentication: { loginMs: 31 * 24 * 60 * 60_000 } } }),
      reason: "invalid_settings",
    },
    { text: "{}" + " ".repeat(4 * 1024 * 1024), reason: "too_large" },
  ]
  for (const input of cases) {
    await f.write(input.text)
    const error = await readOrganizationConfiguration(f.home).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(OrganizationConfigurationError)
    expect(error).toMatchObject({ data: { path: f.file, reason: input.reason } })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(await Bun.file(f.file).text()).toBe(input.text)
  }
  await fs.rm(f.file)
  await fs.mkdir(f.file)
  await expect(readOrganizationConfiguration(f.home)).rejects.toMatchObject({
    data: { reason: process.platform === "win32" ? "read_failed" : "not_regular" },
  })
  await expect(readOrganizationConfiguration("relative-home")).rejects.toThrow("absolute")
})

test("a configuration changed during its descriptor read cannot publish partial settings", async () => {
  await using f = await fixture()
  await f.write("{}")
  const open = fs.open.bind(fs)
  const intercept = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (String(args[0]) !== f.file) return file
    const stat = file.stat.bind(file)
    let changed = false
    file.stat = (async (...args: Parameters<typeof stat>) => {
      const before = await stat(...args)
      if (!changed) {
        changed = true
        await fs.appendFile(f.file, " ")
      }
      return before
    }) as typeof file.stat
    return file
  })
  try {
    await expect(readOrganizationConfiguration(f.home)).rejects.toMatchObject({ data: { reason: "changed" } })
  } finally {
    intercept.mockRestore()
  }
})

test("the organization domain is optional, global-only and fail-closed in composed configuration", async () => {
  await using f = await fixture()
  const context = RuntimeContext.create({
    home: f.home,
    root: path.join(f.home, ".synergy"),
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
  })
  try {
    await context.run(async () => {
      expect(ConfigDomain.domainForKey("organization")).toBeUndefined()
      registerConfig()
      expect(ConfigDomain.domainForKey("organization")).toMatchObject({
        filename: ORGANIZATION_CONFIG_FILENAME,
        globalOnly: true,
        failClosed: true,
      })
      expect(Config.Info.parse({}).organization).toBeUndefined()
      expect(Config.Info.safeParse({ organization: { authentication: { loginMs: 0 } } }).success).toBe(false)
      expect(Config.Info.safeParse({ organization: { clientAuthentication: { clients: [] } } }).success).toBe(true)
      const project = path.join(f.home, "project", ".synergy")
      await expect(Config.domainUpdate("organization", { organization: {} }, { root: project })).rejects.toThrow(
        "global",
      )
    })
  } finally {
    context.dispose()
  }
})

test("native configuration snapshots retain the same validated JSONC bytes and explicit absence", async () => {
  await using f = await fixture()
  expect(await readOrganizationConfigurationSnapshot(f.home)).toEqual({
    present: false,
    settings: {},
    bytes: new Uint8Array(),
  })
  const text = '{ // retained original comment\n "organization": { "authentication": { "loginMs": 12345 } } }\n'
  await f.write(text)
  const snapshot = await readOrganizationConfigurationSnapshot(f.home)
  expect(snapshot.present).toBe(true)
  expect(Buffer.from(snapshot.bytes).toString()).toBe(text)
  expect(snapshot.settings).toEqual(await readOrganizationConfiguration(f.home))
  const controller = new AbortController()
  const reason = new Error("native capture cancelled")
  controller.abort(reason)
  await expect(readOrganizationConfigurationSnapshot(f.home, { signal: controller.signal })).rejects.toBe(reason)
})

test("native configuration snapshots reject a valid pathname replacement during the original descriptor read", async () => {
  await using f = await fixture()
  await f.write('{"organization":{"authentication":{"loginMs":12345}}}')
  const open = fs.open.bind(fs)
  const intercept = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (String(args[0]) !== f.file) return file
    const read = file.read.bind(file)
    let replaced = false
    file.read = (async (...args: Parameters<typeof read>) => {
      if (!replaced) {
        replaced = true
        await fs.rename(f.file, f.file + ".retained")
        await Bun.write(f.file, '{"organization":{"authentication":{"loginMs":54321}}}')
      }
      return read(...args)
    }) as typeof file.read
    return file
  })
  try {
    await expect(readOrganizationConfigurationSnapshot(f.home)).rejects.toMatchObject({ data: { reason: "changed" } })
  } finally {
    intercept.mockRestore()
  }
})

test("native configuration snapshots reject a parent symlink even when it reaches the same original file", async () => {
  await using f = await fixture()
  await f.write("{}")
  const open = fs.open.bind(fs)
  const intercept = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (String(args[0]) !== f.file) return file
    const parent = path.dirname(f.file)
    await fs.rename(parent, parent + ".retained")
    await fs.symlink(parent + ".retained", parent, "dir")
    return file
  })
  try {
    await expect(readOrganizationConfigurationSnapshot(f.home)).rejects.toMatchObject({ data: { reason: "changed" } })
  } finally {
    intercept.mockRestore()
  }
})
