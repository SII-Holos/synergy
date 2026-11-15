import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { getMigrationStatus, runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { BeforeRecoveryReaderBinding } from "../src/home-schema"
import {
  registerOrganizationHomeMigration,
  organizationHomeMigration,
  organizationInitialWorkspaceReaderMigration,
  organizationDurableSyncReaderMigration,
  organizationRecoveryReaderMigration,
} from "../src/home-migration"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { memberEnvironment } from "../src/environment"
import { readRuntimeHome, prepareHostedHome, prepareMemberHome } from "../src/home"
import { enrollRuntime } from "../src/enrollment"
import { openHostedRuntime, openMemberRuntime } from "../src/runtime"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { readRuntimeRegistration } from "../src/registration"
import { fixture } from "./support/organization"

const installed = process.env.SYNERGY_TEST_ORGANIZATION_RUNTIME_INSTALL
const entry = installed
  ? path.join(installed, "node_modules/.bin/synergy-org-runtime")
  : path.resolve(import.meta.dir, "../src/entry.ts")

async function invoke(args: string[], input: unknown, ambient: string, shared = false) {
  const selected = shared ? path.resolve(import.meta.dir, "../../presets/src/index.ts") : entry
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-bunfig", selected, ...(shared ? ["org-runtime"] : []), ...args],
    {
      cwd: installed ?? ambient,
      env: {
        ...process.env,
        SYNERGY_HOME: ambient,
        SYNERGY_RUNTIME_ROOT: undefined,
        NODE_PATH: undefined,
        NODE_OPTIONS: undefined,
      },
      stdin: new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

const homeMigrationDomain = "organization-runtime-home"
const previousHomeMigrations = [
  organizationHomeMigration,
  organizationInitialWorkspaceReaderMigration,
  organizationDurableSyncReaderMigration,
]
type UpgradeHome = Awaited<ReturnType<typeof prepareHostedHome>> | Awaited<ReturnType<typeof prepareMemberHome>>

async function preparePriorReaderCatalog(home: UpgradeHome) {
  expect(await StorageBootstrap.status(home.root)).toBeUndefined()
  const context = RuntimeContext.create(
    { home: home.home, root: home.root, env: memberEnvironment(home, process.env) },
    "oneshot",
  )
  return context.run(async () => {
    const owner = HomeOwnershipFile.FencedInfo.parse(
      JSON.parse(await fs.readFile(path.join(home.root, "home-ownership.json"), "utf8")),
    )
    expect(owner.readerContract).toBe("native-organization-ownership-v5")
    HomeOwnership.select(owner)
    await HomeOwnership.assert({ required: true })
    registerOrganizationHomeMigration(home.identity)
    MigrationRegistry.unregister(homeMigrationDomain)
    MigrationRegistry.register(homeMigrationDomain, previousHomeMigrations)
    MigrationRegistry.lock()
    RuntimeContext.sealComposition()
    let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
    let prepared: Awaited<ReturnType<typeof StorageBootstrap.prepare>> | undefined
    try {
      writer = await ServerProcessLock.acquire()
      prepared = await StorageBootstrap.prepare({ root: home.root })
      context.storage = { store: prepared.store, artifactDirectory: path.join(home.root, "data") }
      await runMigrations({ targetDomain: homeMigrationDomain, output: "silent" })
      const status = (await getMigrationStatus(homeMigrationDomain))[homeMigrationDomain]
      if (!status) throw new Error("The selected prior Home migration catalog is unavailable")
      expect(status.completed.map((migration) => migration.id)).toEqual(
        previousHomeMigrations.map((migration) => migration.id),
      )
      expect(status.pending).toEqual([])
      const ledger = await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain(homeMigrationDomain))
      expect(Object.keys(ledger).sort()).toEqual(previousHomeMigrations.map((migration) => migration.id).sort())
      expect(ledger[organizationRecoveryReaderMigration.id]).toBeUndefined()
      for (const name of ["home-ownership.json", "organization.json"])
        expect(JSON.parse(await fs.readFile(path.join(home.root, name), "utf8")).readerContract).toBe(
          "native-organization-ownership-v5",
        )
      await prepared.activate()
      expect(prepared.manifest.phase).toBe("active")
      return ledger
    } finally {
      try {
        await prepared?.store.close()
      } finally {
        try {
          await writer?.release()
        } finally {
          context.dispose()
        }
      }
    }
  })
}

async function inspectHomeMigrationLog(home: UpgradeHome) {
  const context = RuntimeContext.create(
    { home: home.home, root: home.root, env: memberEnvironment(home, process.env) },
    "oneshot",
  )
  return context.run(async () => {
    let attached: Awaited<ReturnType<typeof StorageBootstrap.inspect>> = undefined
    try {
      attached = await StorageBootstrap.inspect(home.root)
      if (!attached) throw new Error("The original active Home dataset is unavailable")
      context.storage = { store: attached.store, artifactDirectory: attached.artifactDirectory }
      return await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain(homeMigrationDomain))
    } finally {
      try {
        await attached?.store.close()
      } finally {
        context.dispose()
      }
    }
  })
}

test("public register prepares and enrolls member and hosted Homes over TLS without changing the ambient Home", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const help = await invoke(["--help"], {}, ambient)
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain("register")
  expect(help.stdout).toContain("serve")
  for (const kind of ["member", "hosted"] as const) {
    const base = path.join(f.root, kind)
    const identity = kind === "member" ? f.identity : { orgID: f.identity.orgID, hostID: "public-registration" }
    const input = { version: 1, identity, origin: f.origin, ca: f.ca }
    const args = ["register", "--base-directory", base]
    const prepared = await invoke(args, input, ambient)
    expect(prepared.code, prepared.stderr).toBe(0)
    const ready = JSON.parse(prepared.stdout)
    expect(ready).toMatchObject({ state: "prepared", kind, identity })
    const home = await readRuntimeHome(ready.home, identity)
    expect(home.publicKey).toBe(ready.publicKey)
    const before = f.requests.length
    const ticket =
      kind === "member"
        ? await f.ticket(f.identity.deviceID, home.publicKey)
        : (
            await f.client.orgRuntime.registerHosted(
              { orgHostedRuntimeRegistration: { name: "Public registration", publicKey: home.publicKey } },
              { headers: f.headers, throwOnError: true },
            )
          ).data
    const enrolled = await invoke(args, { ...input, ticket }, ambient)
    expect(enrolled.code, enrolled.stderr).toBe(0)
    expect(JSON.parse(enrolled.stdout)).toMatchObject({
      state: "active",
      kind,
      home: home.home,
      publicKey: home.publicKey,
      runtimeID: ticket.runtime.runtimeID,
      deploymentIncarnation: ticket.runtime.deploymentIncarnation,
    })
    expect((await readRuntimeHome(home.home, identity)).publicKey).toBe(home.publicKey)
    expect((await readRuntimeRegistration(home.home, identity))?.state).toBe("active")
    const retained = await invoke(args, input, ambient)
    expect(retained.code, retained.stderr).toBe(0)
    expect(JSON.parse(retained.stdout)).toMatchObject({ state: "active", runtimeID: ticket.runtime.runtimeID })
    expect(f.requests.length - before).toBe(1)
    expect(enrolled.stdout + enrolled.stderr).not.toContain(ticket.token)
  }
  expect(await fs.readdir(ambient, { recursive: true })).toEqual([])
}, 25_000)

test("public registration rejects malformed input and foreign tickets before remote dispatch", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const base = path.join(f.root, "member")
  for (const input of ["{", { version: 2 }, " ".repeat(65_537)]) {
    const result = await invoke(["register", "--base-directory", base], input, ambient)
    expect(result.code).toBe(1)
    expect(await fs.readdir(f.root)).not.toContain("member")
  }
  const relative = await invoke(["register", "--base-directory", "relative"], {}, ambient)
  expect(relative.code).toBe(1)
  expect(await fs.readdir(ambient)).toEqual([])
  const input = { version: 1, identity: f.identity, origin: f.origin, ca: f.ca }
  const prepared = await invoke(["register", "--base-directory", base], input, ambient)
  expect(prepared.code, prepared.stderr).toBe(0)
  const ready = JSON.parse(prepared.stdout)
  const ticket = await f.ticket(f.identity.deviceID, ready.publicKey)
  const foreign = {
    ...ticket,
    runtime: { ...ticket.runtime, deviceID: "different-device" },
  }
  const rejected = await invoke(["register", "--base-directory", base], { ...input, ticket: foreign }, ambient)
  expect(rejected.code).toBe(1)
  expect(f.requests).toHaveLength(0)
  expect(rejected.stdout + rejected.stderr).not.toContain(ticket.token)
  expect(await readRuntimeRegistration(ready.home, f.identity)).toBeUndefined()
}, 25_000)

test("registration response loss preserves the prepared key and requires an explicit same-ticket reconciliation", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const args = ["register", "--base-directory", path.join(f.root, "member")]
  const input = { version: 1, identity: f.identity, origin: f.origin, ca: f.ca }
  const prepared = await invoke(args, input, ambient)
  expect(prepared.code, prepared.stderr).toBe(0)
  const home = JSON.parse(prepared.stdout)
  const ticket = await f.ticket(f.identity.deviceID, home.publicKey)
  const fingerprint = () =>
    fs
      .readFile(path.join(home.home, ".synergy", "auth", "organization-runtime.json"))
      .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
  const before = await fingerprint()
  f.loseRegistrationResponse()
  const lost = await invoke(args, { ...input, ticket }, ambient)
  expect(lost.code).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(await fingerprint()).toBe(before)
  expect(await readRuntimeRegistration(home.home, f.identity)).toBeUndefined()
  const retried = await invoke(args, { ...input, ticket }, ambient)
  expect(retried.code, retried.stderr).toBe(0)
  expect(f.requests).toHaveLength(2)
  expect(await fingerprint()).toBe(before)
  expect((await readRuntimeRegistration(home.home, f.identity))?.runtimeID).toBe(ticket.runtime.runtimeID)
  expect(lost.stdout + lost.stderr + retried.stdout + retried.stderr).not.toContain(ticket.token)
}, 25_000)

test("public serve reuses the enrolled supervised lifecycle and graceful shutdown", async () => {
  await using f = await fixture()
  const ambient = path.join(f.root, "ambient")
  await fs.mkdir(ambient)
  const identity = { orgID: f.identity.orgID, hostID: "public-serve" }
  const input = { version: 1, identity, origin: f.origin, ca: f.ca }
  const args = ["register", "--base-directory", path.join(f.root, "hosted")]
  const prepared = await invoke(args, input, ambient)
  expect(prepared.code, prepared.stderr).toBe(0)
  const ready = JSON.parse(prepared.stdout)
  const ticket = (
    await f.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Public serve", publicKey: ready.publicKey } },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  const enrolled = await invoke(args, { ...input, ticket }, ambient)
  expect(enrolled.code, enrolled.stderr).toBe(0)
  const home = await readRuntimeHome(ready.home, identity)
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const token = "c".repeat(64)
  const connected = Promise.withResolvers<Protocol.ConnectionProof["handshake"]>()
  let handshake: Protocol.ConnectionProof["handshake"] | undefined
  f.interceptFrames((_socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "handshake" && frame.proof.handshake.runtimeID === ticket.runtime.runtimeID)
      handshake = frame.proof.handshake
    if (frame.type === "heartbeat" && handshake && frame.connectionEpoch === handshake.connectionEpoch)
      connected.resolve(handshake)
    return false
  })
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, "serve", "--kind", "hosted"], {
    cwd: installed ?? home.home,
    env: { ...memberEnvironment(home, process.env), NODE_PATH: undefined, NODE_OPTIONS: undefined },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        identity,
        deploymentIncarnation: ticket.runtime.deploymentIncarnation,
        port,
        token,
        ca: f.ca,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  try {
    const client = createSynergyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      headers: { authorization: `Bearer ${token}` },
    })
    let running = false
    const deadline = Date.now() + 12_000
    while (!running && child.exitCode === null && Date.now() < deadline) {
      const capabilities = await client.global.capabilities({ signal: AbortSignal.timeout(250) }).catch(() => undefined)
      running = !!capabilities?.data?.runtimeID
      if (!running) await Bun.sleep(25)
    }
    if (child.exitCode !== null) throw new Error((await output).join("\n"))
    expect(running).toBe(true)
    const bridgeDeadline = setTimeout(
      () => connected.reject(new Error("Public hosted CLI bridge did not connect")),
      3000,
    )
    try {
      const accepted = await connected.promise
      expect(accepted.capabilities).toContain("handoffs")
      expect(accepted.schemas.handoffs).toBe(Handoff.syncTransferBridge)
    } finally {
      clearTimeout(bridgeDeadline)
    }
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
    const printed = (await output).join("\n")
    expect(printed).not.toContain(token)
    expect(printed).not.toContain(ticket.token)
    expect(printed).toContain('"state":"ready"')
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await output
  }
}, 25_000)

for (const kind of ["member", "hosted"] as const)
  test(`public ${kind} Home upgrade reaches the native owner through shared and independent parsers`, async () => {
    await using f = await fixture({ connections: { heartbeatMs: 25 } })
    const identity = kind === "member" ? f.identity : { orgID: f.identity.orgID, hostID: "public-reader-upgrade" }
    const home =
      "accountID" in identity
        ? await prepareMemberHome({ baseDirectory: path.join(f.root, "upgrade"), identity, origin: f.origin })
        : await prepareHostedHome({ baseDirectory: path.join(f.root, "upgrade"), identity, origin: f.origin })
    const ticket =
      "accountID" in identity
        ? await f.ticket(identity.deviceID, home.publicKey)
        : (
            await f.client.orgRuntime.registerHosted(
              {
                orgHostedRuntimeRegistration: {
                  name: "Reader upgrade",
                  publicKey: home.publicKey,
                },
              },
              { headers: f.headers, throwOnError: true },
            )
          ).data
    await enrollRuntime({ home: home.home, identity, ticket, ca: f.ca })
    const open = () =>
      "accountID" in identity
        ? openMemberRuntime({ home: home.home, identity, ca: f.ca, logging: { print: false } })
        : openHostedRuntime({ home: home.home, identity, ca: f.ca, logging: { print: false } })
    expect(await StorageBootstrap.status(home.root)).toBeUndefined()
    const retainedFiles = ["auth/organization-runtime.json", "organization-registration.json"]
    const retained = await Promise.all(retainedFiles.map((name) => fs.readFile(path.join(home.root, name))))
    for (const name of ["home-ownership.json", "organization.json"]) {
      const file = path.join(home.root, name)
      const value = JSON.parse(await fs.readFile(file, "utf8"))
      const prior = { ...value, readerContract: "native-organization-ownership-v5" }
      await fs.writeFile(
        file,
        JSON.stringify(
          name === "organization.json"
            ? BeforeRecoveryReaderBinding.parse(prior)
            : HomeOwnershipFile.FencedInfo.parse(prior),
        ),
      )
    }
    const priorLedger = await preparePriorReaderCatalog(home)
    await expect(readRuntimeHome(home.home, identity)).rejects.toThrow("migration")
    const requestID = "public-native-reader-upgrade"
    const input = { version: 1, identity }
    const first = await invoke(["upgrade", "--request-id", requestID], input, home.home, !installed)
    expect(first.code, first.stderr).toBe(0)
    const receipt = JSON.parse(first.stdout)
    expect(receipt).toMatchObject({
      state: "upgrade-complete",
      requestID,
      restartRequired: true,
      executesAgents: false,
      schemaVersion: 2,
      readerContract: "native-organization-ownership-v6",
    })
    const retry = await invoke(["upgrade", "--request-id", requestID], input, home.home)
    expect(retry.code, retry.stderr).toBe(0)
    expect(JSON.parse(retry.stdout)).toEqual(receipt)
    expect(await Promise.all(retainedFiles.map((name) => fs.readFile(path.join(home.root, name))))).toEqual(retained)
    expect((await readRuntimeHome(home.home, identity)).publicKey).toBe(home.publicKey)
    const currentLedger = await inspectHomeMigrationLog(home)
    expect(Object.keys(currentLedger).sort()).toEqual(
      [...Object.keys(priorLedger), organizationRecoveryReaderMigration.id].sort(),
    )
    for (const [id, completedAt] of Object.entries(priorLedger)) expect(currentLedger[id]).toBe(completedAt)
    expect(currentLedger[organizationRecoveryReaderMigration.id]).toBeGreaterThan(0)
    await using reopened = await open()
    const released = await reopened.run(() => RuntimeMaintenance.status())
    expect(released).toMatchObject({
      version: 2,
      requestID,
      phase: "released",
      native: {
        source: { schemaVersion: 2, readerContract: "native-organization-ownership-v5" },
        target: { schemaVersion: 2, readerContract: "native-organization-ownership-v6" },
      },
    })
  }, 30_000)

test("public upgrade refuses a reader-six receipt paired with files falsely claiming reader five", async () => {
  await using f = await fixture({ connections: { heartbeatMs: 25 } })
  const identity = { orgID: f.identity.orgID, hostID: "inconsistent-reader-ledger" }
  const home = await prepareHostedHome({ baseDirectory: path.join(f.root, "upgrade"), identity, origin: f.origin })
  const ticket = (
    await f.client.orgRuntime.registerHosted(
      {
        orgHostedRuntimeRegistration: {
          name: "Inconsistent reader ledger",
          publicKey: home.publicKey,
        },
      },
      { headers: f.headers, throwOnError: true },
    )
  ).data
  await enrollRuntime({ home: home.home, identity, ticket, ca: f.ca })
  const original = await openHostedRuntime({ home: home.home, identity, ca: f.ca, logging: { print: false } })
  const ledger = await original.run(() =>
    Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain(homeMigrationDomain)),
  )
  expect(ledger[organizationRecoveryReaderMigration.id]).toBeGreaterThan(0)
  await original.close()
  const paths = ["home-ownership.json", "organization.json"]
  for (const name of paths) {
    const file = path.join(home.root, name)
    const current = JSON.parse(await fs.readFile(file, "utf8"))
    await fs.writeFile(file, JSON.stringify({ ...current, readerContract: "native-organization-ownership-v5" }))
  }
  const files = await Promise.all(paths.map((name) => fs.readFile(path.join(home.root, name))))
  const credentials = await fs.readFile(path.join(home.root, "auth", "organization-runtime.json"))
  const result = await invoke(
    ["upgrade", "--request-id", "inconsistent-native-reader"],
    { version: 1, identity },
    home.home,
  )
  expect(result.code).toBe(1)
  expect(await inspectHomeMigrationLog(home)).toEqual(ledger)
  expect(await Promise.all(paths.map((name) => fs.readFile(path.join(home.root, name))))).toEqual(files)
  expect(await fs.readFile(path.join(home.root, "auth", "organization-runtime.json"))).toEqual(credentials)
  await expect(readRuntimeHome(home.home, identity)).rejects.toThrow("migration")
}, 30_000)
