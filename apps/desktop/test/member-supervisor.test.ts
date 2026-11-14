import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareMemberHome, type MemberHome } from "@ericsanchezok/synergy-organization-runtime/home"
import { DesktopServerManager } from "../src/server-manager"
import * as PortState from "../src/server-port-state"

let resourcesPath: string
beforeAll(async () => {
  resourcesPath = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-member-supervisor-assets-"))
  const output = path.join(resourcesPath, "synergy/bin", process.platform === "win32" ? "synergy.exe" : "synergy")
  await fs.mkdir(path.dirname(output), { recursive: true })
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/member-server.ts")],
    compile: { outfile: output, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!build.success) throw new AggregateError(build.logs, "Member supervisor fixture build failed")
}, 20000)
afterAll(async () => {
  if (resourcesPath) await fs.rm(resourcesPath, { recursive: true, force: true })
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-member-supervisor-"))
  const previous = Object.fromEntries(
    [
      "SYNERGY_TEST_HOME",
      "MEMBER_TEST_PERSONAL_SECRET",
      "SYNERGY_INSTALLATION_ROOT",
      "SYNERGY_INSTALLATION_PIN",
      "SYNERGY_BROWSER_HOST_REGISTRATION_SECRET",
    ].map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, {
    SYNERGY_TEST_HOME: root,
    MEMBER_TEST_PERSONAL_SECRET: "personal-credential-sentinel",
    SYNERGY_INSTALLATION_ROOT: path.join(root, "personal"),
    SYNERGY_INSTALLATION_PIN: "personal-pin-sentinel",
    SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: "personal-native-secret",
  })
  const managers: DesktopServerManager[] = []
  try {
    const members = await Promise.all(
      ["account-a", "account-b"].map((accountID) =>
        prepareMemberHome({
          baseDirectory: path.join(root, "members"),
          identity: { orgID: "organization", accountID, deviceID: "device" },
          origin: "https://organization.example",
        }),
      ),
    )
    for (const member of members) await fs.writeFile(path.join(member.home, ".env"), "MEMBER_TEST_DOTENV=private\n")
    const options = (member: MemberHome) => ({
      channel: "dev" as const,
      mode: "managed" as const,
      resourcesPath,
      logDir: path.join(root, "shared-log"),
      userDataPath: path.join(root, "shared-state"),
      member: { home: member.home, identity: member.identity, deploymentIncarnation: "deployment" },
    })
    return {
      root,
      members,
      options,
      manager(member: MemberHome) {
        const manager = new DesktopServerManager(options(member))
        managers.push(manager)
        return manager
      },
      async [Symbol.asyncDispose]() {
        for (const manager of managers) await manager.stop()
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        await fs.rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}

test("member supervisors isolate child environments, credentials and lifecycle while deduplicating starts", async () => {
  await using f = await fixture()
  const [a, b] = f.members.map((member) => f.manager(member))
  const urls = await Promise.all([a.start(), a.start(), b.start(), b.start()])
  expect(urls[0]).toBe(urls[1])
  expect(urls[2]).toBe(urls[3])
  expect(urls[0]).not.toBe(urls[2])
  const first = a.connection()!
  const other = b.connection()!
  expect(first.headers.authorization).not.toBe(other.headers.authorization)
  for (const [manager, member] of [
    [a, f.members[0]],
    [b, f.members[1]],
  ] as const) {
    const endpoint = manager.connection()!
    const probe = await (await fetch(endpoint.url + "/probe", { headers: endpoint.headers })).json()
    expect(probe).toEqual({
      pid: manager.status().pid,
      home: member.home,
      root: member.root,
      cwd: await fs.realpath(member.home),
      identity: member.identity,
      userHome: member.home,
      args: ["member-runtime"],
      privateValue: null,
      loaderValue: null,
      inheritedPin: null,
      parent: String(process.pid),
      desktop: true,
      ambientBrowserToken: null,
    })
    expect((await fetch(endpoint.url + "/global/health")).status).toBe(401)
    expect(JSON.stringify(manager.status())).not.toContain(endpoint.headers.authorization)
    expect((await fs.readFile(path.join(member.root, "fixture-starts"), "utf8")).trim().split("\n")).toHaveLength(1)
    expect(await fs.readFile(manager.status().logFile!, "utf8")).not.toContain(endpoint.headers.authorization.slice(7))
  }
  const nativeA = a.browserConnection()!
  const nativeB = b.browserConnection()!
  expect(nativeA.token).not.toBe(nativeB.token)
  expect(nativeA.headers.authorization).toBe(first.headers.authorization)
  expect(nativeA.headers.authorization).not.toContain(nativeA.token)
  for (const [token, status] of [
    [nativeA.token, 200],
    [nativeB.token, 403],
  ] as const)
    expect(
      (await fetch(nativeA.url + "/native", { headers: { ...nativeA.headers, "x-fixture-browser-token": token } }))
        .status,
    ).toBe(status)
  expect(JSON.stringify(a.status())).not.toContain(nativeA.token)
  expect(await fs.readFile(a.status().logFile!, "utf8")).not.toContain(nativeA.token)
  expect((await fetch(first.url + "/probe", { headers: other.headers })).status).toBe(401)
  await a.stop()
  expect(a.connection()).toBeUndefined()
  expect(a.browserConnection()).toBeUndefined()
  expect((await fetch(other.url + "/global/health", { headers: other.headers })).status).toBe(200)
  await a.start()
  const restarted = a.connection()!
  expect(restarted.url).toBe(first.url)
  expect(restarted.headers.authorization).not.toBe(first.headers.authorization)
  expect(a.browserConnection()!.token).not.toBe(nativeA.token)
  expect(
    (
      await fetch(restarted.url + "/native", {
        headers: { ...restarted.headers, "x-fixture-browser-token": nativeA.token },
      })
    ).status,
  ).toBe(403)
  expect((await fetch(restarted.url + "/global/health", { headers: first.headers })).status).toBe(401)
  expect((await fetch(other.url + "/global/health", { headers: other.headers })).status).toBe(200)
  expect(a.status().logFile).not.toBe(b.status().logFile)
}, 30000)

test("a member exiting while its ready port is persisted cannot become running", async () => {
  await using f = await fixture()
  const member = f.members[0]
  const manager = f.manager(member)
  const directory = path.join(member.root, "state", "desktop")
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const persist = PortState.saveServerPort
  using writing = spyOn(PortState, "saveServerPort").mockImplementation(async (...args) => {
    if (args[0] === directory) {
      entered.resolve()
      await held.promise
    }
    return persist(...args)
  })
  const starting = manager.start().then(
    (url) => ({ url }),
    (error: unknown) => ({ error }),
  )
  try {
    await Promise.race([
      entered.promise,
      starting.then(() => {
        throw new Error("Member startup ended before reaching port persistence")
      }),
    ])
    const pid = manager.status().pid
    expect(pid).toBeNumber()
    process.kill(pid!, "SIGTERM")
    const deadline = Date.now() + 2_000
    while (manager.status().state !== "failed") {
      if (Date.now() >= deadline) throw new Error("Member exit was not observed")
      await Bun.sleep(5)
    }
    held.resolve()
    expect(await starting).toMatchObject({ error: expect.any(Error) })
    expect(manager.connection()).toBeUndefined()
    expect(manager.status().state).toBe("failed")
  } finally {
    held.resolve()
    await starting
  }
}, 10_000)

test("stopping member startup fences late work and leaves a later explicit start usable", async () => {
  await using f = await fixture()
  const member = f.members[0]
  const manager = f.manager(member)
  const starting = manager.start().then(
    () => "unexpected-ready",
    () => "cancelled",
  )
  await manager.stop()
  expect(await starting).toBe("cancelled")
  expect(manager.connection()).toBeUndefined()
  expect(
    await fs.access(path.join(member.root, "fixture-starts")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  await manager.start()
  expect(manager.connection()).toBeDefined()
}, 15000)

test("member supervisors reject external mode, mismatched Homes and personal maintenance commands", async () => {
  await using f = await fixture()
  const member = f.members[0]
  expect(
    () => new DesktopServerManager({ ...f.options(member), mode: "external", externalUrl: "https://example.test" }),
  ).toThrow("member")
  const invalid = f.manager({ ...member, identity: f.members[1].identity })
  await expect(invalid.start()).rejects.toThrow("Home")
  expect(invalid.connection()).toBeUndefined()
  expect(
    await fs.access(path.join(member.root, "log")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const manager = f.manager(member)
  await expect(manager.runMaintenance()).rejects.toThrow("member Runtime")
  await expect(manager.createDiagnostics()).rejects.toThrow("member Runtime")
  expect(
    await fs.access(path.join(member.root, "fixture-starts")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
}, 15000)
